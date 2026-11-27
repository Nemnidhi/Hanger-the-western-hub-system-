import express from "express";
import mongoose from "mongoose";
import { z } from "zod";
import { Invoice, Location, Order, Return, RETURN_REASONS, REFUND_METHODS } from "../models/index.js";
import { requireAuth, requirePermission } from "../auth/middleware.js";
import { withTransaction } from "../db.js";
import { audit } from "../audit.js";
import { httpError, parseBody, route } from "./validate.js";
import { REASON_LABELS, findReturnable, returnPieces } from "../commerce/returns.js";

// Returns and exchanges: find the bill or order, choose the pieces and why they came back, and how the
// money goes back. Works for online orders and store bills alike.

export function createReturnsRouter({ config }) {
  const router = express.Router();
  const tenantId = config.TENANT_ID;

  router.get("/api/returns/reasons", requireAuth(), requirePermission("orders:read"), (req, res) => {
    res.json({ reasons: RETURN_REASONS.map((id) => ({ id, label: REASON_LABELS[id] })), refunds: REFUND_METHODS });
  });

  router.get("/api/returns/find", requireAuth(), requirePermission("orders:read"), route(async (req, res) => {
    res.json({ orders: await findReturnable({ tenantId, q: typeof req.query.q === "string" ? req.query.q : "" }) });
  }));

  router.get("/api/returns", requireAuth(), requirePermission("orders:read"), route(async (req, res) => {
    const filter = { tenantId };
    if (typeof req.query.orderId === "string" && /^[0-9a-f]{24}$/i.test(req.query.orderId)) filter.orderId = req.query.orderId;
    const returns = await Return.find(filter).sort({ at: -1 }).limit(100).lean();
    const notes = await Invoice.find({ _id: mongoose.trusted({ $in: returns.map((ret) => ret.creditNoteId).filter(Boolean) }) }, { number: 1 }).lean();
    const numberOf = new Map(notes.map((note) => [String(note._id), note.number]));
    res.json({ returns: returns.map((ret) => ({ ...ret, creditNoteNumber: numberOf.get(String(ret.creditNoteId)) || "" })) });
  }));

  router.post("/api/orders/:id/returns", requireAuth(), requirePermission("orders:write"), route(async (req, res) => {
    const body = parseBody(
      z.object({
        items: z.array(z.object({ skuCode: z.string().min(3).max(40), qty: z.number().int().min(1).max(20), reason: z.enum(RETURN_REASONS), condition: z.enum(["resell", "damaged"]).default("resell") })).min(1).max(50),
        note: z.string().max(300).default(""),
        refund: z.object({ method: z.enum(REFUND_METHODS), note: z.string().max(200).default("") }),
        location: z.string().max(6).optional(),
      }),
      req,
    );
    if (!/^[0-9a-f]{24}$/i.test(req.params.id)) throw httpError(404, "Order not found");
    const result = await withTransaction(async (session) => {
      const order = await Order.findOne({ _id: req.params.id, tenantId }).session(session);
      if (!order) throw httpError(404, "Order not found");
      let locationId = null;
      if (body.location) {
        const location = await Location.findOne({ tenantId, code: body.location.toUpperCase(), active: true }).session(session);
        if (!location) throw httpError(404, "Location not found", "NO_LOCATION");
        locationId = location._id;
      }
      return returnPieces({ tenantId, order, items: body.items, note: body.note, refund: body.refund, locationId, by: req.user, session });
    });
    await audit({ req, action: "order.return", meta: { orderId: result.order._id, returnId: result.ret._id, pieces: result.ret.lines.reduce((sum, line) => sum + line.qty, 0) } });
    res.status(201).json({ return: result.ret, creditNote: result.creditNote, order: result.order });
  }));

  return router;
}
