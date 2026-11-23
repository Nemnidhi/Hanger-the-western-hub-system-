import mongoose from "mongoose";
import { Sku, StockLevel, StockMove } from "../models/index.js";

// Every stock change goes through here, inside the caller's transaction, and every change to the
// pieces on hand writes a ledger row (StockMove). `available` = onHand - reserved, kept in the same write.

export const stockError = (status, message, code, extra = {}) => Object.assign(new Error(message), { status, code, ...extra });

async function markDirty(skuIds, session) {
  await Sku.updateMany({ _id: mongoose.trusted({ $in: skuIds }) }, { $set: { metaDirty: true } }, { session });
}

/**
 * Holds pieces for an order. All lines or none: if any size has run out, the whole transaction is
 * refused with OUT_OF_STOCK and the list of what is short.
 */
export async function holdStock({ tenantId, locationId, lines, session }) {
  const short = [];
  for (const line of lines) {
    const result = await StockLevel.updateOne(
      { tenantId, skuId: line.skuId, locationId, available: mongoose.trusted({ $gte: line.qty }) },
      { $inc: { reserved: line.qty, available: -line.qty } },
      { session },
    );
    if (!result.modifiedCount) {
      const level = await StockLevel.findOne({ skuId: line.skuId, locationId }).session(session);
      short.push({ skuCode: line.skuCode, size: line.size, wanted: line.qty, available: level?.available || 0 });
    }
  }
  if (short.length) throw stockError(409, "Some items are no longer in stock.", "OUT_OF_STOCK", { short });
  await markDirty(lines.map((line) => line.skuId), session);
}

/** Gives held pieces back (order cancelled or not paid in time). */
export async function releaseStock({ tenantId, locationId, lines, session }) {
  for (const line of lines) {
    const result = await StockLevel.updateOne(
      { tenantId, skuId: line.skuId, locationId, reserved: mongoose.trusted({ $gte: line.qty }) },
      { $inc: { reserved: -line.qty, available: line.qty } },
      { session },
    );
    if (!result.modifiedCount) throw stockError(500, `Stock hold missing for ${line.skuCode}`, "STOCK_HOLD_MISSING");
  }
  await markDirty(lines.map((line) => line.skuId), session);
}

/** The held pieces are sold: they leave the shelf. */
export async function commitStock({ tenantId, locationId, lines, orderId, by, session, at = new Date() }) {
  for (const line of lines) {
    const result = await StockLevel.updateOne(
      { tenantId, skuId: line.skuId, locationId, reserved: mongoose.trusted({ $gte: line.qty }), onHand: mongoose.trusted({ $gte: line.qty }) },
      { $inc: { reserved: -line.qty, onHand: -line.qty } },
      { session },
    );
    if (!result.modifiedCount) throw stockError(500, `Stock hold missing for ${line.skuCode}`, "STOCK_HOLD_MISSING");
  }
  await StockMove.create(
    lines.map((line) => ({ tenantId, skuId: line.skuId, skuCode: line.skuCode, locationId, qty: -line.qty, kind: "sale", orderId, by, at })),
    { session, ordered: true },
  );
}

/** Sold pieces come back to the shelf (return, refusal, cancellation after confirming). */
export async function restock({ tenantId, locationId, lines, orderId, kind, by, note = "", session, at = new Date() }) {
  for (const line of lines) {
    await StockLevel.updateOne(
      { tenantId, skuId: line.skuId, locationId },
      { $inc: { onHand: line.qty, available: line.qty }, $setOnInsert: { reserved: 0 } },
      { session, upsert: true },
    );
  }
  await StockMove.create(
    lines.map((line) => ({ tenantId, skuId: line.skuId, skuCode: line.skuCode, locationId, qty: line.qty, kind, orderId, by, note, at })),
    { session, ordered: true },
  );
  await markDirty(lines.map((line) => line.skuId), session);
}

/** New pieces in from a supplier: [{ sku, qty }]. */
export async function receiveStock({ tenantId, locationId, items, supplierId = null, by, note = "", session, at = new Date() }) {
  for (const { sku, qty } of items) {
    if (!Number.isInteger(qty) || qty < 1) throw stockError(400, `Quantity for ${sku.code} must be a whole number above 0`, "BAD_QTY");
    await StockLevel.updateOne(
      { tenantId, skuId: sku._id, locationId },
      { $inc: { onHand: qty, available: qty }, $setOnInsert: { reserved: 0 } },
      { session, upsert: true },
    );
  }
  await StockMove.create(
    items.map(({ sku, qty }) => ({ tenantId, skuId: sku._id, skuCode: sku.code, locationId, qty, kind: "receive", supplierId, by, note, at })),
    { session, ordered: true },
  );
  await markDirty(items.map(({ sku }) => sku._id), session);
}

/**
 * Sets the count of one SKU at a location to what was physically counted. Held pieces cannot be
 * counted away: the new count must cover them.
 */
export async function adjustStock({ tenantId, locationId, sku, counted, by, note, session, at = new Date() }) {
  if (!Number.isInteger(counted) || counted < 0) throw stockError(400, "The count must be a whole number, 0 or more", "BAD_QTY");
  if (!String(note || "").trim()) throw stockError(400, "Say why the count changed (damaged, found, miscount...)", "NOTE_REQUIRED");
  const level = (await StockLevel.findOne({ tenantId, skuId: sku._id, locationId }).session(session)) || { onHand: 0, reserved: 0 };
  if (counted < level.reserved) throw stockError(409, `${level.reserved} piece(s) of ${sku.code} are held for orders; the count cannot be below that.`, "BELOW_HELD");
  const change = counted - level.onHand;
  if (!change) return 0;
  // Conditional on the numbers just read: if an order held or sold a piece meanwhile, nothing changes.
  const written = await StockLevel.updateOne(
    { tenantId, skuId: sku._id, locationId, onHand: level.onHand, reserved: level.reserved },
    { $set: { onHand: counted, available: counted - level.reserved } },
    { session, upsert: level.onHand === 0 && level.reserved === 0 },
  );
  if (!written.matchedCount && !written.upsertedCount) throw stockError(409, "Stock changed while counting; count again.", "STOCK_CHANGED");
  await StockMove.create([{ tenantId, skuId: sku._id, skuCode: sku.code, locationId, qty: change, kind: "adjust", by, note, at }], { session });
  await markDirty([sku._id], session);
  return change;
}

/** Moves pieces from one location to another (only pieces not held for orders). */
export async function transferStock({ tenantId, fromLocationId, toLocationId, items, by, note = "", session, at = new Date() }) {
  if (String(fromLocationId) === String(toLocationId)) throw stockError(400, "Pick two different locations", "SAME_LOCATION");
  const short = [];
  for (const { sku, qty } of items) {
    const taken = await StockLevel.updateOne(
      { tenantId, skuId: sku._id, locationId: fromLocationId, available: mongoose.trusted({ $gte: qty }) },
      { $inc: { onHand: -qty, available: -qty } },
      { session },
    );
    if (!taken.modifiedCount) short.push(sku.code);
  }
  if (short.length) throw stockError(409, `Not enough free stock to move: ${short.join(", ")}`, "OUT_OF_STOCK", { short });
  for (const { sku, qty } of items) {
    await StockLevel.updateOne({ tenantId, skuId: sku._id, locationId: toLocationId }, { $inc: { onHand: qty, available: qty }, $setOnInsert: { reserved: 0 } }, { session, upsert: true });
  }
  await StockMove.create(
    items.flatMap(({ sku, qty }) => [
      { tenantId, skuId: sku._id, skuCode: sku.code, locationId: fromLocationId, qty: -qty, kind: "transfer_out", by, note, at },
      { tenantId, skuId: sku._id, skuCode: sku.code, locationId: toLocationId, qty, kind: "transfer_in", by, note, at },
    ]),
    { session, ordered: true },
  );
  await markDirty(items.map(({ sku }) => sku._id), session);
}
