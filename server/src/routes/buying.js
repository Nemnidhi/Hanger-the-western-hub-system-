import express from "express";
import { z } from "zod";
import { Location, Markdown, PurchaseOrder, Supplier, getSettings } from "../models/index.js";
import { requireAuth, requirePermission } from "../auth/middleware.js";
import { withTransaction, isDuplicateKeyError } from "../db.js";
import { audit } from "../audit.js";
import { httpError, parseBody, route } from "./validate.js";
import { buyingCalendar, createPurchaseOrder, endMarkdown, markdownPlan, purchaseOrderText, receivePurchaseOrder, reorderDraft, reorderPlan, sizeMixFrom, startMarkdown, styleStats, supplierScorecard, trialResults } from "../commerce/buying.js";
import { enqueue } from "../jobs/queue.js";

// The buying desk: reading is for whoever sees the reports; orders to suppliers need stock:write;
// markdowns change prices, so they need catalog:write.

const id = z.string().regex(/^[0-9a-f]{24}$/i, "not a valid id");
const date = z.iso.date().transform((value) => new Date(`${value}T23:59:59+05:30`));

export function createBuyingRouter({ config }) {
  const router = express.Router();
  const tenantId = config.TENANT_ID;
  const who = (req) => req.user.name || req.user.email;
  const read = [requireAuth(), requirePermission("reports:read")];

  router.get("/api/buying/reorder", ...read, route(async (req, res) => res.json(await reorderPlan({ tenantId }))));
  router.get("/api/buying/size-mix", ...read, route(async (req, res) => res.json({ categories: sizeMixFrom(await styleStats({ tenantId, settings: await getSettings(tenantId) })) })));
  router.get("/api/buying/suppliers", ...read, route(async (req, res) => res.json({ suppliers: await supplierScorecard({ tenantId }) })));
  router.get("/api/buying/trials", ...read, route(async (req, res) => res.json(await trialResults({ tenantId }))));
  router.get("/api/buying/markdowns", ...read, route(async (req, res) => res.json(await markdownPlan({ tenantId }))));
  router.get("/api/buying/calendar", ...read, route(async (req, res) => res.json({ events: await buyingCalendar({ tenantId }) })));

  // ---- Purchase orders ----
  router.get("/api/purchase-orders", ...read, route(async (req, res) => {
    const filter = { tenantId };
    if (typeof req.query.status === "string" && ["draft", "sent", "part_received", "received", "cancelled"].includes(req.query.status)) filter.status = req.query.status;
    const orders = await PurchaseOrder.find(filter).sort({ createdAt: -1 }).limit(200).lean();
    const suppliers = new Map((await Supplier.find({ tenantId }, { name: 1, waId: 1 }).lean()).map((row) => [String(row._id), row]));
    res.json({ orders: orders.map((po) => ({ ...po, supplier: suppliers.get(String(po.supplierId))?.name || "", pieces: po.lines.reduce((sum, line) => sum + line.qty, 0), received: po.lines.reduce((sum, line) => sum + line.receivedQty, 0), costPaise: po.lines.reduce((sum, line) => sum + line.qty * line.costPaise, 0) })) });
  }));

  async function loadPo(poId, session) {
    const po = await PurchaseOrder.findOne({ _id: parseBody(id, { body: poId }), tenantId }).session(session || null);
    if (!po) throw httpError(404, "Purchase order not found");
    return po;
  }
  async function locationFor(code, session) {
    const location = code ? await Location.findOne({ tenantId, code: String(code).toUpperCase(), active: true }).session(session) : await Location.findOne({ tenantId, active: true }).sort({ kind: -1, createdAt: 1 }).session(session);
    if (!location) throw httpError(404, "Location not found", "NO_LOCATION");
    return location;
  }

  router.get("/api/purchase-orders/:id", ...read, route(async (req, res) => {
    const po = await loadPo(req.params.id);
    const supplier = await Supplier.findById(po.supplierId).lean();
    res.json({ order: po, supplier, text: await purchaseOrderText({ tenantId, po }) });
  }));

  const items = z.array(z.object({ skuCode: z.string().min(1).max(40), qty: z.number().int().min(1).max(10000), costPaise: z.number().int().min(0).max(10_000_00).optional() })).min(1).max(300);

  router.post("/api/purchase-orders", requireAuth(), requirePermission("stock:write"), route(async (req, res) => {
    const body = parseBody(z.object({ supplierId: id, location: z.string().max(12).optional(), trial: z.boolean().default(false), items, note: z.string().max(500).default(""), expectedAt: date.optional() }), req);
    const po = await withTransaction(async (session) => createPurchaseOrder({ tenantId, supplierId: body.supplierId, locationId: (await locationFor(body.location, session))._id, items: body.items, trial: body.trial, note: body.note, expectedAt: body.expectedAt || null, by: who(req), session }));
    await audit({ req, action: "po.create", meta: { poId: po._id, number: po.number } });
    res.status(201).json({ order: po });
  }));

  router.post("/api/purchase-orders/reorder-draft", requireAuth(), requirePermission("stock:write"), route(async (req, res) => {
    const body = parseBody(z.object({ supplierId: id, location: z.string().max(12).optional() }), req);
    const po = await withTransaction(async (session) => reorderDraft({ tenantId, supplierId: body.supplierId, locationId: (await locationFor(body.location, session))._id, by: who(req), session }));
    await audit({ req, action: "po.create", meta: { poId: po._id, number: po.number, from: "reorder" } });
    res.status(201).json({ order: po });
  }));

  router.patch("/api/purchase-orders/:id", requireAuth(), requirePermission("stock:write"), route(async (req, res) => {
    const body = parseBody(z.object({ items: items.optional(), note: z.string().max(500).optional(), expectedAt: date.nullable().optional(), trial: z.boolean().optional() }), req);
    const po = await withTransaction(async (session) => {
      const found = await loadPo(req.params.id, session);
      if (found.status !== "draft") throw httpError(409, "Only a draft can be changed; a sent order is received against.", "NOT_DRAFT");
      if (body.items) {
        const fresh = await createPurchaseOrder({ tenantId, supplierId: found.supplierId, locationId: found.locationId, items: body.items, by: who(req), session });
        found.lines = fresh.lines;
        await PurchaseOrder.deleteOne({ _id: fresh._id }, { session });
      }
      if (body.note !== undefined) found.note = body.note;
      if (body.expectedAt !== undefined) found.expectedAt = body.expectedAt;
      if (body.trial !== undefined) found.trial = body.trial;
      await found.save({ session });
      return found;
    });
    res.json({ order: po });
  }));

  // Sent: the order is with the supplier (staff send the message from their own WhatsApp).
  router.post("/api/purchase-orders/:id/send", requireAuth(), requirePermission("stock:write"), route(async (req, res) => {
    const po = await loadPo(req.params.id);
    if (po.status !== "draft") throw httpError(409, "This order was already sent.", "NOT_DRAFT");
    po.status = "sent";
    po.sentAt = new Date();
    await po.save();
    await audit({ req, action: "po.send", meta: { poId: po._id } });
    res.json({ order: po, text: await purchaseOrderText({ tenantId, po }) });
  }));

  router.post("/api/purchase-orders/:id/receive", requireAuth(), requirePermission("stock:write"), route(async (req, res) => {
    const body = parseBody(z.object({ items: z.array(z.object({ skuCode: z.string().max(40), qty: z.number().int().min(0).max(10000) })).min(1).max(300), note: z.string().max(200).default("") }), req);
    const po = await withTransaction(async (session) => receivePurchaseOrder({ tenantId, po: await loadPo(req.params.id, session), items: body.items, note: body.note, by: who(req), session }));
    await audit({ req, action: "po.receive", meta: { poId: po._id, status: po.status } });
    res.json({ order: po });
  }));

  router.post("/api/purchase-orders/:id/cancel", requireAuth(), requirePermission("stock:write"), route(async (req, res) => {
    const po = await loadPo(req.params.id);
    if (!["draft", "sent", "part_received"].includes(po.status)) throw httpError(409, "This order is closed.", "CLOSED");
    // Part received: what came stays in stock; the rest is no longer expected.
    po.status = po.status === "part_received" ? "received" : "cancelled";
    if (po.status === "received") po.receivedAt = new Date();
    await po.save();
    await audit({ req, action: "po.cancel", meta: { poId: po._id } });
    res.json({ order: po });
  }));

  // ---- Markdowns ----
  router.post("/api/buying/markdowns", requireAuth(), requirePermission("catalog:write"), route(async (req, res) => {
    const body = parseBody(z.object({ styleCode: z.string().min(2).max(24), kind: z.enum(["public", "quiet"]), pct: z.number().min(5).max(80), until: date.optional(), reason: z.string().max(300).default("") }), req);
    const markdown = await withTransaction(async (session) => {
      const made = await startMarkdown({ tenantId, styleCode: body.styleCode, kind: body.kind, pct: body.pct, until: body.until || null, reason: body.reason, by: who(req), session });
      if (made.until) await enqueue("markdown.end", { markdownId: String(made._id) }, { runAt: made.until, dedupeKey: `markdown.end:${made._id}`, session });
      return made;
    }).catch((error) => {
      if (isDuplicateKeyError(error)) throw httpError(409, "That style is already marked down.", "ALREADY_MARKED");
      throw error;
    });
    await audit({ req, action: "markdown.start", meta: { styleCode: markdown.styleCode, kind: markdown.kind, pct: markdown.pct } });
    res.status(201).json({ markdown });
  }));

  router.post("/api/buying/markdowns/:id/end", requireAuth(), requirePermission("catalog:write"), route(async (req, res) => {
    const markdown = await withTransaction(async (session) => {
      const found = await Markdown.findOne({ _id: parseBody(id, { body: req.params.id }), tenantId }).session(session);
      if (!found) throw httpError(404, "Markdown not found");
      return endMarkdown({ tenantId, markdown: found, session });
    });
    await audit({ req, action: "markdown.end", meta: { styleCode: markdown.styleCode } });
    res.json({ markdown });
  }));

  return router;
}

/** Ends a markdown on its last day (queued when it starts). */
export function createBuyingHandlers({ config, now = () => new Date() }) {
  return {
    "markdown.end": async ({ markdownId }) => {
      await withTransaction(async (session) => {
        const markdown = await Markdown.findOne({ _id: markdownId, tenantId: config.TENANT_ID }).session(session);
        if (markdown?.status === "active") await endMarkdown({ tenantId: config.TENANT_ID, markdown, session, now: now() });
      });
    },
  };
}
