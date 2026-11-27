import mongoose from "mongoose";
import { randomInt } from "node:crypto";
import { Contact, Creator, Order, PointsEntry } from "../models/index.js";
import { isDuplicateKeyError } from "../db.js";
import { rateForPiece } from "./gst.js";
import { waIdFromPhone } from "./picks.js";

// The members' circle, referrals and creator codes. Every function runs inside the caller's
// transaction. Points are earned on what a customer keeps (taken back when pieces return), spent as a
// discount on a later bill; tiers come from her spend over the last 12 months.

const DAY = 86_400_000;
const KEPT = ["confirmed", "packed", "shipped", "delivered", "returned"];
const trusted = (filter) => mongoose.trusted(filter);
const fail = (status, message, code) => Object.assign(new Error(message), { status, code });

/** The value of the pieces she kept on an order (after any discount). */
export const keptPaise = (order) => order.lines.reduce((sum, line) => sum + line.unitPaise * Math.max(0, line.qty - (line.returnedQty || 0)), 0);

/** Her tier for a 12-month spend: the highest tier whose threshold she has reached. */
export function tierFor(settings, spendPaise) {
  const tiers = [...(settings.loyalty?.tiers || [])].sort((a, b) => a.minSpendPaise - b.minSpendPaise);
  let tier = tiers[0] || { name: "Circle", minSpendPaise: 0, multiplier: 1, perk: "" };
  for (const candidate of tiers) if (spendPaise >= candidate.minSpendPaise) tier = candidate;
  const next = tiers.find((candidate) => candidate.minSpendPaise > spendPaise) || null;
  return { name: tier.name, multiplier: tier.multiplier || 1, perk: tier.perk || "", next: next ? { name: next.name, needPaise: next.minSpendPaise - spendPaise } : null };
}

/** What she kept over the last 12 months, all channels. */
export async function yearSpend({ tenantId, contactId, session, now = new Date() }) {
  const orders = await Order.find({ tenantId, contactId, status: trusted({ $in: KEPT }), createdAt: trusted({ $gte: new Date(now.getTime() - 365 * DAY) }) }, { lines: 1 }).session(session).lean();
  return orders.reduce((sum, order) => sum + keptPaise(order), 0);
}

/** The customer for a phone number given at the counter, created if new (no consents: those are asked). */
export async function contactForPhone({ tenantId, phone, name = "", session }) {
  const waId = waIdFromPhone(phone);
  if (!waId) return null;
  const contact = await Contact.findOneAndUpdate({ tenantId, waId }, { $setOnInsert: { tenantId, waId, firstSeenAt: new Date() } }, { upsert: true, new: true, session });
  if (name && !contact.name) {
    contact.name = String(name).trim().slice(0, 80);
    await contact.save({ session });
  }
  return contact;
}

/** Her own referral code: her first name's letters and three more, e.g. ASHA7K2. Made once. */
export async function ensureReferralCode({ contact, session }) {
  if (contact.loyalty?.referralCode) return contact.loyalty.referralCode;
  const stem = (String(contact.name || contact.profileName || "").replace(/[^A-Za-z]/g, "").toUpperCase().slice(0, 5) || "HANGER");
  const letters = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  for (let attempt = 0; attempt < 6; attempt += 1) {
    const code = stem + Array.from({ length: 3 }, () => letters[randomInt(letters.length)]).join("");
    if (await Creator.exists({ tenantId: contact.tenantId, code }).session(session)) continue;
    if (await Contact.exists({ tenantId: contact.tenantId, "loyalty.referralCode": code }).session(session)) continue;
    contact.set("loyalty.referralCode", code);
    if (!contact.loyalty.joinedAt) contact.set("loyalty.joinedAt", new Date());
    await contact.save({ session });
    return code;
  }
  throw fail(500, "Could not make a referral code", "CODE_CLASH");
}

/**
 * What a bill would get off: a creator's code or a friend's referral code (her first bill only), then
 * points, at most the shop's share of what is left. Returns the parts and the total, or throws a 4xx
 * with the reason in plain words.
 */
export async function quoteDiscount({ tenantId, settings, contact, code = "", redeemPoints = 0, grossPaise, session }) {
  const loyalty = settings.loyalty || {};
  const out = { code: null, points: { used: 0, paise: 0, available: contact?.loyalty?.points || 0, max: 0 }, totalPaise: 0 };
  const wanted = String(code || "").trim().toUpperCase();
  if (wanted) {
    const creator = await Creator.findOne({ tenantId, code: wanted, active: true }).session(session);
    if (creator) {
      out.code = { kind: "creator", code: wanted, creatorId: creator._id, referrerId: null, pct: creator.discountPct, label: `${creator.name}'s code`, paise: Math.round((grossPaise * creator.discountPct) / 100) };
    } else {
      const referrer = await Contact.findOne({ tenantId, "loyalty.referralCode": wanted }).session(session);
      if (!referrer) throw fail(404, `No code ${wanted}. Check the spelling.`, "NO_CODE");
      if (!contact) throw fail(400, "A friend's code needs the new customer's phone number.", "NEEDS_PHONE");
      if (String(referrer._id) === String(contact._id)) throw fail(409, "That is her own code: it is for her friends.", "OWN_CODE");
      const before = await Order.exists({ tenantId, contactId: contact._id, status: trusted({ $in: KEPT }) }).session(session);
      if (before) throw fail(409, "A friend's code is for a first bill only.", "NOT_FIRST");
      const pct = loyalty.referralDiscountPct ?? 10;
      out.code = { kind: "referral", code: wanted, creatorId: null, referrerId: referrer._id, pct, label: `Referred by ${referrer.name || referrer.profileName || "a member"}`, paise: Math.round((grossPaise * pct) / 100) };
    }
  }
  const afterCode = grossPaise - (out.code?.paise || 0);
  if (contact && loyalty.enabled !== false) {
    const value = loyalty.pointValuePaise || 100;
    out.points.max = Math.min(out.points.available, Math.floor((afterCode * (loyalty.maxRedeemPct ?? 20)) / 100 / value));
    const asked = Math.max(0, Math.floor(Number(redeemPoints) || 0));
    if (asked) {
      if (asked < (loyalty.minRedeemPoints ?? 0)) throw fail(409, `Points can be used from ${loyalty.minRedeemPoints} at a time.`, "TOO_FEW_POINTS");
      if (asked > out.points.max) throw fail(409, `At most ${out.points.max} points on this bill.`, "TOO_MANY_POINTS");
      out.points.used = asked;
      out.points.paise = asked * value;
    }
  } else if (redeemPoints) throw fail(400, "Points need the customer's phone number.", "NEEDS_PHONE");
  out.totalPaise = (out.code?.paise || 0) + out.points.paise;
  return out;
}

/**
 * Spreads a bill's discount over its pieces (in proportion to price), so each invoice line shows the
 * price actually paid and its GST slab is decided on that price. Returns the discount applied.
 */
export function applyDiscount(lines, discountPaise, settings) {
  const gross = lines.reduce((sum, line) => sum + line.unitPaise * line.qty, 0);
  if (!discountPaise || discountPaise <= 0 || !gross) return 0;
  const target = Math.min(discountPaise, gross);
  let given = 0;
  for (const line of lines) {
    const perPiece = Math.floor((target * line.unitPaise) / gross);
    line.listUnitPaise = line.listUnitPaise || line.unitPaise;
    line.unitPaise -= perPiece;
    given += perPiece * line.qty;
  }
  // Paise left by rounding go on single pieces first, so the bill comes off by exactly the discount.
  for (const line of [...lines].sort((a, b) => a.qty - b.qty)) {
    const room = target - given;
    if (room <= 0) break;
    const step = Math.floor(room / line.qty);
    if (!step) continue;
    line.unitPaise -= step;
    given += step * line.qty;
  }
  for (const line of lines) line.gstRate = rateForPiece(line.unitPaise, settings.gstSlabs);
  return given;
}

/** Takes the points off her balance for a bill (never below zero). */
export async function redeemPoints({ tenantId, contact, order, points, by, session, now = new Date() }) {
  if (!points) return;
  const updated = await Contact.updateOne({ _id: contact._id, tenantId, "loyalty.points": trusted({ $gte: points }) }, { $inc: { "loyalty.points": -points } }, { session });
  if (!updated.modifiedCount) throw fail(409, "She no longer has enough points.", "NOT_ENOUGH_POINTS");
  await PointsEntry.create([{ tenantId, contactId: contact._id, kind: "redeem", points: -points, orderId: order._id, note: `bill #${order.number}`, by, at: now }], { session });
}

/**
 * Points for a delivered order (store bill: at once; online: on delivery), at her tier's rate, and the
 * friend who referred her gets her reward on that first order. Safe to call twice.
 */
export async function earnPoints({ tenantId, order, settings, session, now = new Date() }) {
  const loyalty = settings.loyalty || {};
  if (loyalty.enabled === false || !order.contactId) return null;
  const contact = await Contact.findOne({ _id: order.contactId, tenantId }).session(session);
  if (!contact) return null;
  const spend = await yearSpend({ tenantId, contactId: contact._id, session, now });
  const tier = tierFor(settings, spend);
  const points = Math.floor((keptPaise(order) / ((loyalty.rupeesPerPoint || 100) * 100)) * tier.multiplier);
  let earned = null;
  try {
    if (points > 0) {
      [earned] = await PointsEntry.create([{ tenantId, contactId: contact._id, kind: "earn", points, orderId: order._id, multiplier: tier.multiplier, note: `bill #${order.number} (${tier.name})`, at: now }], { session });
      contact.loyalty.points = (contact.loyalty.points || 0) + points;
    }
  } catch (error) {
    if (isDuplicateKeyError(error)) return null; // already earned
    throw error;
  }
  contact.set("loyalty.tier", tier.name);
  if (!contact.loyalty.joinedAt) contact.set("loyalty.joinedAt", now);
  if (order.discount?.kind === "referral" && order.discount.referrerId && !contact.loyalty.referredBy) contact.set("loyalty.referredBy", order.discount.referrerId);
  await contact.save({ session });
  await ensureReferralCode({ contact, session });

  if (order.discount?.kind === "referral" && order.discount.referrerId && loyalty.referrerPoints) {
    const reward = loyalty.referrerPoints;
    await PointsEntry.create([{ tenantId, contactId: order.discount.referrerId, kind: "referral", points: reward, orderId: order._id, note: `${contact.name || "a friend"} bought with her code`, at: now }], { session });
    await Contact.updateOne({ _id: order.discount.referrerId, tenantId }, { $inc: { "loyalty.points": reward } }, { session });
  }
  return earned;
}

/**
 * Pieces came back: the points earned on them are taken back, and points she paid with on them are
 * given back, in proportion. One ledger row per return.
 */
export async function pointsForReturn({ tenantId, order, ret, settings, session, now = new Date() }) {
  if (!order.contactId) return null;
  const loyalty = settings.loyalty || {};
  const returnedPaise = ret.lines.reduce((sum, line) => sum + line.unitPaise * line.qty, 0);
  const orderPaise = order.lines.reduce((sum, line) => sum + line.unitPaise * line.qty, 0) || 1;
  const earn = await PointsEntry.findOne({ tenantId, orderId: order._id, kind: "earn", contactId: order.contactId }).session(session);
  const back = earn ? Math.min(earn.points, Math.floor((returnedPaise / ((loyalty.rupeesPerPoint || 100) * 100)) * earn.multiplier)) : 0;
  const refund = order.discount?.pointsUsed ? Math.round((order.discount.pointsUsed * returnedPaise) / orderPaise) : 0;
  const change = refund - back;
  if (!change) return null;
  await PointsEntry.create([{ tenantId, contactId: order.contactId, kind: "reverse", points: change, returnId: ret._id, note: `return ${ret.number}${back ? `: ${back} earned taken back` : ""}${refund ? `${back ? "," : ":"} ${refund} paid with given back` : ""}`, at: now }], { session });
  await Contact.updateOne({ _id: order.contactId, tenantId }, { $inc: { "loyalty.points": change } }, { session });
  return change;
}
