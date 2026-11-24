import express from "express";
import { z } from "zod";
import { requireAuth, requirePermission } from "../auth/middleware.js";
import { audit } from "../audit.js";
import { parseBody, route } from "./validate.js";
import { picksFor } from "../commerce/picks.js";
import { saveCustomerSizes, sendPicks } from "../commerce/picksSend.js";

// Outfit picks for the staff app's trial room screen: what to bring her next, and sending them to her phone.

const code = z.string().trim().min(3).max(40);
const sizeText = z.string().trim().max(12).optional();
const base = {
  pieces: z.array(code).max(8).default([]),
  phone: z.string().max(20).optional(),
  size: sizeText,
  waist: z.string().trim().regex(/^$|^\d{2}$/, "a waist size like 28").optional(),
  location: z.string().max(6).optional(),
};

export function createPicksRouter({ config }) {
  const router = express.Router();
  const tenantId = config.TENANT_ID;

  router.post("/api/picks", requireAuth(), requirePermission("catalog:read"), route(async (req, res) => {
    const body = parseBody(z.object({ ...base, limit: z.number().int().min(1).max(12).default(6) }), req);
    res.json(await picksFor({ tenantId, pieces: body.pieces, phone: body.phone, letter: body.size, waist: body.waist, locationCode: body.location, limit: body.limit }));
  }));

  router.post("/api/picks/send", requireAuth(), requirePermission("inbox:write"), route(async (req, res) => {
    const body = parseBody(z.object({ ...base, phone: z.string().min(10).max(20), styleCodes: z.array(code).max(10).default([]), consentNow: z.boolean().default(false) }), req);
    const sent = await sendPicks({ tenantId, config, phone: body.phone, pieces: body.pieces, styleCodes: body.styleCodes, locationCode: body.location, letter: body.size, waist: body.waist, consentNow: body.consentNow, by: req.user });
    await audit({ req, action: "picks.send", meta: { contactId: sent.contactId, styles: sent.picks.map((pick) => pick.styleCode), via: sent.via, consentNow: body.consentNow } });
    res.status(201).json({ via: sent.via, picks: sent.picks, messageId: sent.message._id });
  }));

  router.post("/api/customers/sizes", requireAuth(), requirePermission("inbox:write"), route(async (req, res) => {
    const body = parseBody(z.object({ phone: z.string().min(10).max(20), usualSize: sizeText.transform((value) => value?.toUpperCase()), waist: base.waist }), req);
    const contact = await saveCustomerSizes({ tenantId, phone: body.phone, usualSize: body.usualSize, waist: body.waist });
    await audit({ req, action: "customer.sizes", meta: { contactId: contact._id } });
    res.json({ fit: contact.fit });
  }));

  return router;
}
