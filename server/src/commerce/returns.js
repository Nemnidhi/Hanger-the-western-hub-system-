import mongoose from "mongoose";
import { Invoice, Location, Order, Return, RETURN_REASONS, getSettings, nextNumber } from "../models/index.js";
import { restock } from "./stock.js";
import { issueInvoice } from "./invoices.js";
import { historyEntry, httpError } from "./orders.js";
import { pointsForReturn } from "./loyalty.js";

// Returns: some or all pieces of a delivered order (a WhatsApp or website order, or a store bill) come
// back, each with a reason. Pieces fit to sell go back on the shelf where they came back to; damaged
// ones stay out of stock. Each return gets a GST credit note for exactly its pieces, and the refund
// (or exchange) is recorded. The reasons feed the reports and the buying desk.

const who = (by) => (typeof by === "string" ? by : by?.name || by?.email || "staff");

export const REASON_LABELS = {
  too_small: "Too small",
  too_big: "Too big",
  fit: "Fit not right",
  looks_different: "Looks different from the photo",
  quality: "Quality / fabric",
  damaged: "Damaged or defective",
  wrong_item: "Wrong piece sent",
  changed_mind: "Changed her mind",
  late: "Came too late",
  other: "Other",
};

/**
 * Takes pieces back. `items`: [{ skuCode, qty, reason, condition }]. `locationId`: where they came
 * back to (default: the order's own location). Returns { ret, creditNote, order }.
 */
export async function returnPieces({ tenantId, order, items, note = "", refund = {}, locationId = null, by, session, now = new Date() }) {
  if (order.status !== "delivered") throw httpError(409, "Only a delivered order (or a store bill) can have pieces returned.", "NOT_DELIVERED");
  if (!items?.length) throw httpError(400, "Choose the pieces that came back.", "NO_ITEMS");
  const settings = await getSettings(tenantId, session);

  // Each piece against the order's line, never more than was bought less what already came back.
  const wanted = new Map();
  for (const item of items) {
    const code = String(item.skuCode || "").toUpperCase();
    if (!RETURN_REASONS.includes(item.reason)) throw httpError(400, `Say why ${code} came back.`, "REASON_REQUIRED");
    const key = `${code}|${item.condition === "damaged" ? "damaged" : "resell"}|${item.reason}`;
    const row = wanted.get(key) || { code, qty: 0, reason: item.reason, condition: item.condition === "damaged" ? "damaged" : "resell" };
    row.qty += Math.max(0, Math.floor(Number(item.qty) || 0));
    wanted.set(key, row);
  }
  const lines = [];
  const taking = new Map();
  for (const row of wanted.values()) {
    if (!row.qty) continue;
    const line = order.lines.find((candidate) => candidate.skuCode === row.code);
    if (!line) throw httpError(400, `${row.code} is not on this order.`, "NOT_ON_ORDER");
    const already = (line.returnedQty || 0) + (taking.get(row.code) || 0);
    if (already + row.qty > line.qty) throw httpError(409, `Only ${line.qty - already} of ${row.code} can still come back.`, "TOO_MANY");
    taking.set(row.code, (taking.get(row.code) || 0) + row.qty);
    lines.push({ skuId: line.skuId, skuCode: line.skuCode, styleCode: line.styleCode, name: line.name, size: line.size, qty: row.qty, unitPaise: line.unitPaise, gstRate: line.gstRate, hsn: line.hsn, reason: row.reason, condition: row.condition });
  }
  if (!lines.length) throw httpError(400, "Choose how many pieces came back.", "NO_ITEMS");

  const location = locationId ? await Location.findOne({ _id: locationId, tenantId, active: true }).session(session) : await Location.findById(order.locationId).session(session);
  if (!location) throw httpError(404, "Location not found", "NO_LOCATION");
  const amountPaise = lines.reduce((sum, line) => sum + line.unitPaise * line.qty, 0);
  const method = refund.method || (order.channel === "store" ? "cash" : "original");

  const [ret] = await Return.create(
    [
      {
        tenantId,
        number: await nextNumber(`return:${tenantId}`, session),
        orderId: order._id,
        orderNumber: order.number,
        channel: order.channel,
        contactId: order.contactId || null,
        locationId: location._id,
        lines,
        note: String(note || "").slice(0, 300),
        refund: { method, amountPaise, note: String(refund.note || "").slice(0, 200) },
        by: who(by),
        at: now,
      },
    ],
    { session },
  );

  const resell = lines.filter((line) => line.condition === "resell");
  if (resell.length) {
    await restock({ tenantId, locationId: location._id, lines: resell, orderId: order._id, kind: "return", by: who(by), note: `return ${ret.number}: ${resell.map((line) => REASON_LABELS[line.reason]).join(", ")}`, session, at: now });
  }
  const invoice = order.invoiceId ? await Invoice.findById(order.invoiceId).session(session) : null;
  const creditNote = invoice ? await issueInvoice({ tenantId, order, settings, kind: "credit_note", lines, returnId: ret._id, session, at: now }) : null;
  ret.creditNoteId = creditNote?._id || null;
  await ret.save({ session });

  for (const line of order.lines) line.returnedQty = (line.returnedQty || 0) + (taking.get(line.skuCode) || 0);
  order.markModified("lines");
  order.returnIds.push(ret._id);
  const allBack = order.lines.every((line) => (line.returnedQty || 0) >= line.qty);
  if (allBack) {
    order.status = "returned";
    order.stockState = "released";
    if (!["exchange", "store_credit", "none"].includes(method)) order.payment.status = "refunded";
  }
  const summary = lines.map((line) => `${line.qty} x ${line.skuCode} (${REASON_LABELS[line.reason].toLowerCase()}${line.condition === "damaged" ? ", damaged" : ""})`).join(", ");
  order.history.push(historyEntry(by, allBack ? "returned" : "part_returned", `${summary}${note ? `. ${note}` : ""}`, now));
  await order.save({ session });
  await pointsForReturn({ tenantId, order, ret, settings, session, now });
  return { ret, creditNote, order };
}

/** Delivered orders and store bills matching a search: the order number, invoice number or phone. */
export async function findReturnable({ tenantId, q }) {
  const text = String(q || "").trim();
  if (text.length < 3) return [];
  const or = [];
  const number = Number(text.replace(/^[A-Za-z]+-?/, ""));
  if (Number.isInteger(number) && number > 0 && !text.includes("/")) or.push({ number });
  const digits = text.replace(/\D/g, "");
  if (digits.length >= 10) or.push({ "customer.phone": mongoose.trusted({ $regex: `${digits.slice(-10)}$` }) });
  if (text.includes("/")) {
    const invoice = await Invoice.findOne({ tenantId, kind: "invoice", number: text.toUpperCase() }).lean();
    if (invoice) or.push({ _id: invoice.orderId });
  }
  if (!or.length) return [];
  const orders = await Order.find({ tenantId, status: "delivered", $or: mongoose.trusted(or) }).sort({ createdAt: -1 }).limit(20).lean();
  const invoices = await Invoice.find({ tenantId, kind: "invoice", orderId: mongoose.trusted({ $in: orders.map((order) => order._id) }) }, { number: 1, orderId: 1, date: 1 }).lean();
  const invoiceOf = new Map(invoices.map((invoice) => [String(invoice.orderId), invoice]));
  return orders.map((order) => ({
    _id: order._id,
    number: order.number,
    channel: order.channel,
    customer: order.customer,
    shipToName: order.shipTo?.name || "",
    createdAt: order.createdAt,
    invoiceNumber: invoiceOf.get(String(order._id))?.number || "",
    payment: order.payment?.method || "",
    lines: order.lines.map((line) => ({ skuCode: line.skuCode, name: line.name, size: line.size, qty: line.qty, returnedQty: line.returnedQty || 0, unitPaise: line.unitPaise })),
  }));
}
