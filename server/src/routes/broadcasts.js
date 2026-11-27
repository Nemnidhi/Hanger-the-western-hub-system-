import express from "express";
import mongoose from "mongoose";
import { z } from "zod";
import { Broadcast, Style, Template, getSettings } from "../models/index.js";
import { requireAuth, requirePermission } from "../auth/middleware.js";
import { audit } from "../audit.js";
import { httpError, parseBody, route } from "./validate.js";
import { broadcastResults, checkTemplate, findAudience, startBroadcast, templateFor } from "../commerce/broadcasts.js";

// WhatsApp broadcasts for the owner and manager: choose who, choose the template, see the reach, send
// now or at a time, and follow the results.

const days = z.number().int().min(1).max(1000).nullable().optional();
const audienceSchema = z
  .object({
    lastBoughtWithinDays: days,
    notBoughtForDays: days,
    neverBought: z.boolean().optional(),
    categories: z.array(z.string().trim().toLowerCase().max(40)).max(20).optional(),
    sizes: z.array(z.string().trim().toUpperCase().max(12)).max(20).optional(),
    minSpend: z.number().min(0).max(10_000_000).optional(),
    pincodePrefixes: z.array(z.string().regex(/^\d{2,6}$/, "the start of a pincode")).max(20).optional(),
    chattedWithinDays: days,
  })
  .default({})
  .transform(({ minSpend, ...rest }) => ({ ...rest, minSpendPaise: Math.round((minSpend || 0) * 100) }));

const fields = {
  name: z.string().trim().min(2).max(80),
  template: z.object({ name: z.string().min(1).max(512), language: z.string().min(2).max(10) }),
  params: z.array(z.string().trim().min(1, "fill every blank").max(500)).max(10).default([]),
  headerImageUrl: z.union([z.literal(""), z.url({ protocol: /^https$/ }).max(500)]).default(""),
  urlSuffix: z.string().trim().max(200).default(""),
  audience: audienceSchema,
};

const PLACEHOLDER = /\{\{(\d+)\}\}/g;
const hasUrlBlank = (template) => (template.components || []).some((part) => String(part.type).toUpperCase() === "BUTTONS" && (part.buttons || []).some((button) => /\{\{\d+\}\}/.test(button.url || "")));
const headerFormat = (template) => (template.components || []).find((part) => String(part.type).toUpperCase() === "HEADER")?.format || "";

export function createBroadcastsRouter({ config }) {
  const router = express.Router();
  const tenantId = config.TENANT_ID;
  const can = [requireAuth(), requirePermission("broadcasts:send")];
  const load = async (id) => {
    if (!/^[0-9a-f]{24}$/i.test(id)) throw httpError(404, "Broadcast not found");
    const broadcast = await Broadcast.findOne({ _id: id, tenantId });
    if (!broadcast) throw httpError(404, "Broadcast not found");
    return broadcast;
  };
  const view = (broadcast) => {
    const { recipients, skippedIds, ...rest } = broadcast.toObject();
    return rest;
  };

  // What the form needs: approved Marketing templates, the shop's categories, the sending limits.
  router.get("/api/broadcasts/setup", ...can, route(async (req, res) => {
    const templates = await Template.find({ tenantId, status: "APPROVED", category: mongoose.trusted({ $in: ["MARKETING", ""] }) }).sort({ name: 1 }).lean();
    const categories = await Style.distinct("category", { tenantId });
    const settings = await getSettings(tenantId);
    res.json({
      templates: templates.map((template) => ({ name: template.name, language: template.language, bodyText: template.bodyText, paramCount: template.paramCount, header: headerFormat(template), urlButton: hasUrlBlank(template) })),
      categories: categories.sort(),
      limits: settings.broadcasts,
    });
  }));

  router.post("/api/broadcasts/audience", ...can, route(async (req, res) => {
    const body = parseBody(z.object({ audience: audienceSchema }), req);
    const { recipients, counts, gapDays } = await findAudience({ tenantId, audience: body.audience });
    res.json({ counts, gapDays, sample: recipients.slice(0, 5).map((contact) => contact.name || contact.profileName || "Customer") });
  }));

  router.get("/api/broadcasts", ...can, route(async (req, res) => {
    const broadcasts = await Broadcast.find({ tenantId }).sort({ createdAt: -1 }).limit(50);
    res.json({ broadcasts: await Promise.all(broadcasts.map(async (broadcast) => ({ ...view(broadcast), results: await broadcastResults({ tenantId, broadcast }) }))) });
  }));

  router.get("/api/broadcasts/:id", ...can, route(async (req, res) => {
    const broadcast = await load(req.params.id);
    const template = await Template.findOne({ tenantId, name: broadcast.template.name, language: broadcast.template.language }).lean();
    const settings = await getSettings(tenantId);
    // The message as a customer named Priya in size M would read it.
    const filled = template ? templateFor({ template, broadcast, contact: { name: "Priya", fit: { usualSize: "M" } }, brandName: settings.brandName }) : null;
    const values = filled?.components.find((part) => part.type === "body")?.parameters.map((part) => part.text) || [];
    const preview = template ? template.bodyText.replace(PLACEHOLDER, (all, n) => values[Number(n) - 1] ?? all) : "";
    res.json({ broadcast: view(broadcast), results: await broadcastResults({ tenantId, broadcast }), preview });
  }));

  router.post("/api/broadcasts", ...can, route(async (req, res) => {
    const body = parseBody(z.object(fields), req);
    const broadcast = new Broadcast({ tenantId, ...body, createdBy: req.user.name || req.user.email });
    await checkTemplate({ tenantId, broadcast });
    await broadcast.save();
    await audit({ req, action: "broadcast.create", meta: { broadcastId: broadcast._id } });
    res.status(201).json({ broadcast: view(broadcast) });
  }));

  router.patch("/api/broadcasts/:id", ...can, route(async (req, res) => {
    const body = parseBody(z.object(fields).partial(), req);
    const broadcast = await load(req.params.id);
    if (broadcast.status !== "draft") throw httpError(409, "Only a draft can be changed.", "NOT_DRAFT");
    broadcast.set(body);
    await checkTemplate({ tenantId, broadcast });
    await broadcast.save();
    res.json({ broadcast: view(broadcast) });
  }));

  router.post("/api/broadcasts/:id/send", ...can, route(async (req, res) => {
    const body = parseBody(z.object({ scheduledAt: z.iso.datetime({ offset: true }).optional() }), req);
    const broadcast = await load(req.params.id);
    const when = body.scheduledAt ? new Date(body.scheduledAt) : null;
    if (when && when.getTime() > Date.now() + 60 * 86_400_000) throw httpError(400, "Schedule it within the next 60 days.", "TOO_FAR");
    await startBroadcast({ tenantId, broadcast, scheduledAt: when });
    await audit({ req, action: "broadcast.send", meta: { broadcastId: broadcast._id, scheduledAt: when } });
    res.json({ broadcast: view(broadcast) });
  }));

  router.post("/api/broadcasts/:id/cancel", ...can, route(async (req, res) => {
    const broadcast = await load(req.params.id);
    if (["done", "cancelled"].includes(broadcast.status)) throw httpError(409, "This broadcast has finished.", "FINISHED");
    broadcast.status = "cancelled";
    broadcast.finishedAt = new Date();
    broadcast.note = `Stopped by ${req.user.name || req.user.email}`;
    await broadcast.save();
    await audit({ req, action: "broadcast.cancel", meta: { broadcastId: broadcast._id } });
    res.json({ broadcast: view(broadcast) });
  }));

  router.delete("/api/broadcasts/:id", ...can, route(async (req, res) => {
    const broadcast = await load(req.params.id);
    if (broadcast.status !== "draft") throw httpError(409, "Only a draft can be deleted.", "NOT_DRAFT");
    await broadcast.deleteOne();
    res.json({ ok: true });
  }));

  return router;
}
