import express from "express";
import mongoose from "mongoose";
import { z } from "zod";
import { Contact, Creator, CreatorPayout, Order, PointsEntry, Return, getSettings } from "../models/index.js";
import { requireAuth, requirePermission } from "../auth/middleware.js";
import { withTransaction, isDuplicateKeyError } from "../db.js";
import { audit } from "../audit.js";
import { httpError, parseBody, route } from "./validate.js";
import { contactForPhone, ensureReferralCode, keptPaise, quoteDiscount, tierFor, yearSpend } from "../commerce/loyalty.js";
import { creatorStatement } from "../commerce/creators.js";
import { REASON_LABELS } from "../commerce/returns.js";
import { priceLines } from "../commerce/orders.js";
import { memberPrices } from "../commerce/buying.js";
import { waIdFromPhone } from "../commerce/picks.js";

// Customers: one record per person across WhatsApp, the website and the store counter (matched by
// phone), with her sizes, what she bought and sent back, her consents, points and tier. Creators and
// their codes live here too.

const KEPT = ["confirmed", "packed", "shipped", "delivered", "returned"];
const id = z.string().regex(/^[0-9a-f]{24}$/i, "not a valid id");
const trusted = (filter) => mongoose.trusted(filter);
const escape = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export function createCustomersRouter({ config }) {
  const router = express.Router();
  const tenantId = config.TENANT_ID;
  const who = (req) => req.user.name || req.user.email;

  async function loadContact(contactId, session) {
    if (!/^[0-9a-f]{24}$/i.test(contactId)) throw httpError(404, "Customer not found");
    const contact = await Contact.findOne({ _id: contactId, tenantId }).session(session || null);
    if (!contact) throw httpError(404, "Customer not found");
    return contact;
  }

  // ---- Customers ----------------------------------------------------------------------------------
  router.get("/api/customers", requireAuth(), requirePermission("orders:read"), route(async (req, res) => {
    const q = typeof req.query.q === "string" ? req.query.q.trim() : "";
    const filter = { tenantId };
    if (q) {
      const digits = q.replace(/\D/g, "");
      const or = [{ name: trusted({ $regex: escape(q), $options: "i" }) }, { profileName: trusted({ $regex: escape(q), $options: "i" }) }, { "loyalty.referralCode": q.toUpperCase() }];
      if (digits.length >= 4) or.push({ waId: trusted({ $regex: `${digits}$` }) });
      filter.$or = trusted(or);
    }
    const sort = req.query.sort === "points" ? { "loyalty.points": -1 } : { updatedAt: -1 };
    const contacts = await Contact.find(filter).sort(sort).limit(100).lean();
    const settings = await getSettings(tenantId);
    res.json({
      customers: contacts.map((contact) => ({
        _id: contact._id,
        name: contact.name || contact.profileName || "",
        waId: contact.waId,
        usualSize: contact.fit?.usualSize || "",
        points: contact.loyalty?.points || 0,
        tier: contact.loyalty?.tier || "",
        offers: Boolean(contact.consents?.offers?.given),
        lastInboundAt: contact.lastInboundAt,
        updatedAt: contact.updatedAt,
      })),
      tiers: settings.loyalty?.tiers || [],
    });
  }));

  router.get("/api/customers/:id", requireAuth(), requirePermission("orders:read"), route(async (req, res) => {
    const contact = await loadContact(req.params.id);
    const settings = await getSettings(tenantId);
    const phone = contact.waId.replace(/^91(?=\d{10}$)/, "");
    // Older store bills carry only the phone number: they are counted too.
    const orders = await Order.find({ tenantId, $or: trusted([{ contactId: contact._id }, { channel: "store", "customer.phone": phone, contactId: null }]) }, { history: 0, shipment: 0 }).sort({ createdAt: -1 }).limit(100).lean();
    const returns = await Return.find({ tenantId, orderId: trusted({ $in: orders.map((order) => order._id) }) }).sort({ at: -1 }).lean();
    const points = await PointsEntry.find({ tenantId, contactId: contact._id }).sort({ at: -1 }).limit(50).lean();
    const spend = await yearSpend({ tenantId, contactId: contact._id });
    const kept = orders.filter((order) => KEPT.includes(order.status));
    // Fit feedback from her returns: which sizes came back too small or too big.
    const fitNotes = returns.flatMap((ret) => ret.lines.filter((line) => ["too_small", "too_big", "fit"].includes(line.reason)).map((line) => `${line.styleCode} in ${line.size}: ${REASON_LABELS[line.reason].toLowerCase()}`));
    const referred = await Contact.countDocuments({ tenantId, "loyalty.referredBy": contact._id });
    res.json({
      customer: contact,
      stats: {
        orders: kept.length,
        lifetimePaise: kept.reduce((sum, order) => sum + keptPaise(order), 0),
        yearPaise: spend,
        lastOrderAt: kept[0]?.createdAt || null,
        piecesReturned: returns.reduce((sum, ret) => sum + ret.lines.reduce((n, line) => n + line.qty, 0), 0),
        referred,
      },
      tier: tierFor(settings, spend),
      fitNotes,
      orders: orders.map((order) => ({ _id: order._id, number: order.number, channel: order.channel, status: order.status, createdAt: order.createdAt, totalPaise: order.totals.totalPaise, lines: order.lines, discount: order.discount })),
      returns,
      points,
    });
  }));

  router.patch("/api/customers/:id", requireAuth(), requirePermission("orders:write"), route(async (req, res) => {
    const body = parseBody(
      z.object({
        name: z.string().trim().max(80).optional(),
        fit: z.object({ usualSize: z.string().trim().toUpperCase().max(12).optional(), waist: z.string().trim().regex(/^$|^\d{2}$/, "a waist size like 28").optional(), notes: z.string().max(300).optional() }).optional(),
        birthday: z.object({ day: z.number().int().min(1).max(31).nullable(), month: z.number().int().min(1).max(12).nullable() }).optional(),
        notes: z.string().max(500).optional(),
        // Staff record a yes or a no she gave in person.
        offers: z.boolean().optional(),
      }),
      req,
    );
    const contact = await loadContact(req.params.id);
    if (body.name !== undefined) contact.name = body.name;
    if (body.fit) for (const [key, value] of Object.entries(body.fit)) if (value !== undefined) contact.set(`fit.${key}`, value);
    if (body.birthday) contact.set("birthday", body.birthday);
    if (body.notes !== undefined) contact.notes = body.notes;
    if (body.offers !== undefined && body.offers !== Boolean(contact.consents?.offers?.given)) {
      contact.set("consents.offers", { given: body.offers, at: new Date(), source: `staff:${who(req)}`, askedAt: contact.consents?.offers?.askedAt || new Date() });
    }
    await contact.save();
    await audit({ req, action: "customer.update", meta: { contactId: contact._id, fields: Object.keys(body) } });
    res.json({ customer: contact });
  }));

  // A new customer at the counter or the trial room: by phone (found if she exists).
  router.post("/api/customers", requireAuth(), requirePermission("orders:write"), route(async (req, res) => {
    const body = parseBody(z.object({ phone: z.string().min(10).max(20), name: z.string().trim().max(80).default("") }), req);
    if (!waIdFromPhone(body.phone)) throw httpError(400, "Type a 10-digit mobile number", "BAD_PHONE");
    const contact = await withTransaction((session) => contactForPhone({ tenantId, phone: body.phone, name: body.name, session }));
    res.status(201).json({ customer: contact });
  }));

  // Points by hand (a goodwill gesture, a correction): owner only, always with a note.
  router.post("/api/customers/:id/points", requireAuth(), requirePermission("settings:write"), route(async (req, res) => {
    const body = parseBody(z.object({ points: z.number().int().min(-100000).max(100000).refine((value) => value !== 0, "not zero"), note: z.string().trim().min(3).max(200) }), req);
    const contact = await withTransaction(async (session) => {
      const found = await loadContact(req.params.id, session);
      if ((found.loyalty?.points || 0) + body.points < 0) throw httpError(409, "That would leave her below zero points.", "BELOW_ZERO");
      await PointsEntry.create([{ tenantId, contactId: found._id, kind: "adjust", points: body.points, note: body.note, by: who(req) }], { session });
      found.set("loyalty.points", (found.loyalty?.points || 0) + body.points);
      await found.save({ session });
      await ensureReferralCode({ contact: found, session });
      return found;
    });
    await audit({ req, action: "customer.points", meta: { contactId: contact._id, points: body.points } });
    res.json({ customer: contact });
  }));

  router.post("/api/customers/:id/referral-code", requireAuth(), requirePermission("orders:write"), route(async (req, res) => {
    const code = await withTransaction(async (session) => ensureReferralCode({ contact: await loadContact(req.params.id, session), session }));
    res.json({ code });
  }));

  // The counter asks: who is she, what is her tier, what can she use on this bill.
  router.post("/api/counter/quote", requireAuth(), requirePermission("orders:write"), route(async (req, res) => {
    const body = parseBody(z.object({ phone: z.string().max(20).default(""), code: z.string().trim().max(20).default(""), redeem: z.number().int().min(0).max(1_000_000).default(0), grossPaise: z.number().int().min(0).max(1_000_000_00), items: z.array(z.object({ skuCode: z.string().max(40), qty: z.number().int().min(1).max(20) })).max(60).optional() }), req);
    const settings = await getSettings(tenantId);
    const waId = waIdFromPhone(body.phone);
    const contact = waId ? await Contact.findOne({ tenantId, waId }) : null;
    // With the bill's pieces, members' quiet markdown prices come off first, as the sale will do.
    let gross = body.grossPaise;
    let memberSavingPaise = 0;
    if (contact && body.items?.length) {
      const lines = await priceLines({ tenantId, items: body.items, settings, session: null });
      memberSavingPaise = await memberPrices({ tenantId, lines, settings, session: null });
      gross = lines.reduce((sum, line) => sum + line.unitPaise * line.qty, 0);
    }
    const quote = await quoteDiscount({ tenantId, settings, contact, code: body.code, redeemPoints: body.redeem, grossPaise: gross, session: null });
    quote.memberSavingPaise = memberSavingPaise;
    quote.totalPaise += memberSavingPaise;
    const spend = contact ? await yearSpend({ tenantId, contactId: contact._id }) : 0;
    res.json({
      member: contact ? { _id: contact._id, name: contact.name || contact.profileName || "", points: contact.loyalty?.points || 0, tier: tierFor(settings, spend), usualSize: contact.fit?.usualSize || "", offers: Boolean(contact.consents?.offers?.given) } : null,
      quote,
      pointValuePaise: settings.loyalty?.pointValuePaise || 100,
    });
  }));

  // ---- Creators -----------------------------------------------------------------------------------
  const creatorFields = {
    name: z.string().trim().min(2).max(80),
    code: z.string().trim().toUpperCase().regex(/^[A-Z0-9]{3,16}$/, "3 to 16 letters or digits"),
    phone: z.string().max(15).default(""),
    instagram: z.string().trim().max(60).default(""),
    upi: z.string().trim().max(80).default(""),
    discountPct: z.number().min(0).max(50),
    commissionPct: z.number().min(0).max(50),
    tdsPct: z.number().min(0).max(30).default(0),
    active: z.boolean().default(true),
    notes: z.string().max(300).default(""),
  };

  router.get("/api/creators", requireAuth(), requirePermission("broadcasts:send"), route(async (req, res) => {
    const month = typeof req.query.month === "string" && /^\d{4}-\d{2}$/.test(req.query.month) ? req.query.month : new Date(Date.now() + 330 * 60_000).toISOString().slice(0, 7);
    const creators = await Creator.find({ tenantId }).sort({ active: -1, name: 1 });
    res.json({ month, creators: await Promise.all(creators.map(async (creator) => ({ ...creator.toObject(), statement: await creatorStatement({ tenantId, creator, month }) }))) });
  }));

  router.post("/api/creators", requireAuth(), requirePermission("broadcasts:send"), route(async (req, res) => {
    const body = parseBody(z.object(creatorFields), req);
    if (await Contact.exists({ tenantId, "loyalty.referralCode": body.code })) throw httpError(409, "A member already has that code; choose another.", "CODE_TAKEN");
    try {
      const creator = await Creator.create({ tenantId, ...body });
      await audit({ req, action: "creator.create", meta: { creatorId: creator._id, code: creator.code } });
      res.status(201).json({ creator });
    } catch (error) {
      if (isDuplicateKeyError(error)) throw httpError(409, "That code is already in use.", "CODE_TAKEN");
      throw error;
    }
  }));

  router.patch("/api/creators/:id", requireAuth(), requirePermission("broadcasts:send"), route(async (req, res) => {
    const body = parseBody(z.object(creatorFields).omit({ code: true }).partial(), req);
    const creator = await Creator.findOne({ _id: parseBody(id, { body: req.params.id }), tenantId });
    if (!creator) throw httpError(404, "Creator not found");
    creator.set(body);
    await creator.save();
    await audit({ req, action: "creator.update", meta: { creatorId: creator._id } });
    res.json({ creator });
  }));

  // A month paid: the statement's figures are written down with the payment reference. Owner only.
  router.post("/api/creators/:id/payouts", requireAuth(), requirePermission("settings:write"), route(async (req, res) => {
    const body = parseBody(z.object({ month: z.string().regex(/^\d{4}-\d{2}$/), reference: z.string().trim().min(3).max(80) }), req);
    const creator = await Creator.findOne({ _id: parseBody(id, { body: req.params.id }), tenantId });
    if (!creator) throw httpError(404, "Creator not found");
    const statement = await creatorStatement({ tenantId, creator, month: body.month });
    if (statement.payout) throw httpError(409, "That month is already paid.", "ALREADY_PAID");
    if (statement.payablePaise <= 0) throw httpError(409, "Nothing to pay for that month.", "NOTHING_DUE");
    const payout = await CreatorPayout.create({ tenantId, creatorId: creator._id, month: body.month, orders: statement.orders, netSalesPaise: statement.netSalesPaise, commissionPaise: statement.commissionPaise, tdsPaise: statement.tdsPaise, paidPaise: statement.payablePaise, reference: body.reference, by: who(req) });
    await audit({ req, action: "creator.payout", meta: { creatorId: creator._id, month: body.month, paidPaise: payout.paidPaise } });
    res.status(201).json({ payout });
  }));

  return router;
}
