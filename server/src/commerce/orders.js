import mongoose from "mongoose";
import { Contact, Conversation, Location, Order, OPEN_STATUSES, Sku, Style, getSettings, nextNumber } from "../models/index.js";
import { enqueue } from "../jobs/queue.js";
import { queueOutbound } from "../whatsapp/outbound.js";
import { rateForPiece } from "./gst.js";
import { findPincode, stateForAddress } from "./pincode.js";
import { codBand, codRiskScore } from "./codRisk.js";
import { commitStock, holdStock, releaseStock, restock } from "./stock.js";
import { issueInvoice } from "./invoices.js";
import * as say from "./messages.js";

// The life of an order. Every function runs inside the caller's transaction (`session`), so the
// order, its stock, its invoice, its customer message and its follow-up jobs change together or not at all.

const DAY_MS = 24 * 60 * 60 * 1000;
export const httpError = (status, message, code, extra = {}) => Object.assign(new Error(message), { status, code, ...extra });
const who = (by) => (typeof by === "string" ? by : by?.name || by?.email || "staff");

export function historyEntry(by, event, note = "", at = new Date()) {
  return { at, by: who(by), event, note };
}

/** Sends an order message to the customer: free text inside the 24-hour window, else the template. */
export async function tellCustomer({ tenantId, order, content, settings, session, now = new Date() }) {
  if (!order.conversationId) return null;
  const conversation = await Conversation.findById(order.conversationId).session(session);
  const tags = { purpose: "order", orderId: order._id };
  if (conversation?.lastInboundAt && now - conversation.lastInboundAt < DAY_MS) {
    return queueOutbound({ tenantId, session }, { conversationId: order.conversationId, content: { ...content, ...tags } });
  }
  const template = settings.templates?.orderUpdate;
  if (template?.name) {
    const contact = await Contact.findById(order.contactId).session(session);
    const params = [(contact?.name || contact?.profileName || "there").split(" ")[0], `${settings.orderPrefix}-${order.number}`, say.statusWords(order)];
    return queueOutbound(
      { tenantId, session },
      { conversationId: order.conversationId, content: { template: { name: template.name, language: template.language || "en", components: [{ type: "body", parameters: params.map((text) => ({ type: "text", text })) }] }, ...tags } },
    );
  }
  order.history.push(historyEntry("system", "message_not_sent", "More than 24 hours since the customer's last message and no order-update template is set."));
  return null;
}

/** Prices a cart from our own catalogue: [{ skuCode, qty }] -> order lines. Only live styles sell. */
export async function priceLines({ tenantId, items, settings, session }) {
  const wanted = new Map();
  for (const item of items) {
    const code = String(item.skuCode || "").toUpperCase();
    const qty = Number(item.qty);
    if (!code || !Number.isInteger(qty) || qty < 1) throw httpError(400, "Each item needs a size code and a quantity", "BAD_ITEM");
    wanted.set(code, (wanted.get(code) || 0) + qty);
  }
  if (!wanted.size) throw httpError(400, "The cart is empty", "EMPTY_CART");
  const skus = await Sku.find({ tenantId, code: mongoose.trusted({ $in: [...wanted.keys()] }) }).session(session);
  const styles = await Style.find({ _id: mongoose.trusted({ $in: skus.map((sku) => sku.styleId) }) }).session(session);
  const styleById = new Map(styles.map((style) => [String(style._id), style]));
  const unknown = [...wanted.keys()].filter((code) => {
    const sku = skus.find((row) => row.code === code);
    return !sku || styleById.get(String(sku.styleId))?.status !== "live";
  });
  if (unknown.length) throw httpError(404, `Not in the current collection: ${unknown.join(", ")}`, "UNKNOWN_ITEMS", { unknown });
  return [...wanted.entries()].map(([code, qty]) => {
    const sku = skus.find((row) => row.code === code);
    const style = styleById.get(String(sku.styleId));
    if (qty > 20) throw httpError(400, `At most 20 pieces of ${code} in one order`, "TOO_MANY");
    return {
      skuId: sku._id,
      skuCode: sku.code,
      styleCode: style.code,
      name: style.name,
      size: sku.size,
      qty,
      unitPaise: sku.pricePaise,
      gstRate: rateForPiece(sku.pricePaise, settings.gstSlabs),
      hsn: style.hsn || settings.defaultHsn,
    };
  });
}

const totalsOf = (lines) => {
  const itemsPaise = lines.reduce((total, line) => total + line.unitPaise * line.qty, 0);
  return { itemsPaise, totalPaise: itemsPaise };
};

export async function onlineLocation({ tenantId, settings, session }) {
  const location = settings.onlineLocationCode
    ? await Location.findOne({ tenantId, code: settings.onlineLocationCode, active: true }).session(session)
    : await Location.findOne({ tenantId, active: true }).sort({ createdAt: 1 }).session(session);
  if (!location) throw httpError(409, "No location is set up to ship online orders (Settings > online location).", "NO_ONLINE_LOCATION");
  return location;
}

async function scheduleExpiry(order, session) {
  await enqueue("order.holdExpiry", { orderId: String(order._id), holdUntil: order.holdUntil.toISOString() }, { session, runAt: order.holdUntil });
}

/** A cart from WhatsApp (or the website): prices it, holds the stock, and asks for the address. */
export async function placeOnlineOrder({ tenantId, channel, contact, conversationId, items, session, now = new Date() }) {
  const settings = await getSettings(tenantId, session);
  const location = await onlineLocation({ tenantId, settings, session });
  const lines = await priceLines({ tenantId, items, settings, session });
  await holdStock({ tenantId, locationId: location._id, lines, session });
  const order = new Order({
    tenantId,
    number: await nextNumber(`order:${tenantId}`, session),
    channel,
    contactId: contact?._id || null,
    conversationId: conversationId || null,
    customer: { name: contact?.name || contact?.profileName || "", phone: contact?.waId || "" },
    locationId: location._id,
    lines,
    totals: totalsOf(lines),
    status: "draft",
    chatStep: "awaiting_address",
    stockState: "held",
    holdUntil: new Date(now.getTime() + settings.paymentHoldMinutes * 60_000),
    history: [historyEntry("customer", "placed", `${lines.reduce((total, line) => total + line.qty, 0)} piece(s) via ${channel}`, now)],
  });
  await scheduleExpiry(order, session);
  const saved = contact?.lastAddress?.address ? contact.lastAddress : null;
  await tellCustomer({ tenantId, order, content: saved ? say.askSavedAddress(order, settings.orderPrefix, saved) : say.askAddress(order, settings.orderPrefix), settings, session, now });
  await order.save({ session });
  return order;
}

/** Records the delivery address (typed in chat or the saved one) and asks how to pay. */
export async function setAddress({ tenantId, order, address, name = "", razorpayReady, session, now = new Date() }) {
  const settings = await getSettings(tenantId, session);
  const pincode = findPincode(address);
  if (!pincode) throw httpError(400, "The address needs a 6-digit pincode", "NO_PINCODE");
  const state = stateForAddress({ pincode, text: address });
  // "Asha Jain, Flat 12, ..." - a first part of only letters (1-4 words) is the name for delivery.
  const parts = String(address).trim().split(/\s*,\s*/);
  if (parts.length > 2 && /^[A-Za-z][A-Za-z.' ]{1,40}$/.test(parts[0]) && parts[0].split(/\s+/).length <= 4) {
    name = parts.shift();
    address = parts.join(", ");
  }
  order.shipTo = { name: String(name || order.customer.name || "").slice(0, 80), address: String(address).trim().slice(0, 400), pincode, stateCode: state.stateCode, state: state.state, stateSure: state.sure };
  if (order.contactId) await Contact.updateOne({ _id: order.contactId }, { $set: { lastAddress: { name: order.shipTo.name, address: order.shipTo.address, pincode } } }, { session });
  order.chatStep = "awaiting_payment_choice";
  order.history.push(historyEntry("customer", "address", `${pincode}${state.state ? `, ${state.state}` : ""}`, now));
  const options = paymentOptions(order, settings, razorpayReady);
  await tellCustomer({ tenantId, order, content: options.codAllowed || options.prepaidAllowed ? say.askPayment(order, options) : say.noPaymentOption(), settings, session, now });
  await order.save({ session });
  return order;
}

export function paymentOptions(order, settings, razorpayReady) {
  const codAllowed = settings.cod.enabled && (!settings.cod.maxOrderPaise || order.totals.totalPaise <= settings.cod.maxOrderPaise);
  return { codAllowed, prepaidAllowed: Boolean(razorpayReady) };
}

/** The COD risk score from the customer's and the pincode's own record. */
export async function scoreCod({ tenantId, order, session, now = new Date() }) {
  const count = (filter) => Order.countDocuments({ tenantId, ...filter }).session(session);
  const deliveredStates = mongoose.trusted({ $in: ["delivered", "returned"] });
  // One after another: operations inside one transaction must not run in parallel.
  const delivered = order.contactId ? await count({ contactId: order.contactId, "payment.method": "cod", status: deliveredStates }) : 0;
  const refused = order.contactId ? await count({ contactId: order.contactId, "payment.method": "cod", status: "rto" }) : 0;
  const pinDelivered = await count({ "shipTo.pincode": order.shipTo.pincode, status: deliveredStates });
  const pinRto = await count({ "shipTo.pincode": order.shipTo.pincode, status: "rto" });
  return codRiskScore({
    history: { delivered, refused },
    pincode: { delivered: pinDelivered, rto: pinRto },
    order: { valuePaise: order.totals.totalPaise, pieces: order.lines.reduce((total, line) => total + line.qty, 0), address: order.shipTo.address, at: now },
  });
}

/** The customer chose how to pay. Prepaid: a payment link. COD: scored, then shipped, confirmed first, or prepaid only. */
export async function choosePayment({ tenantId, order, method, razorpayReady, by = "customer", session, now = new Date() }) {
  if (!OPEN_STATUSES.includes(order.status) || order.stockState !== "held") throw httpError(409, "This order can no longer change its payment.", "NOT_OPEN");
  if (!order.shipTo?.pincode) throw httpError(409, "The delivery address is needed first.", "NO_ADDRESS");
  const settings = await getSettings(tenantId, session);
  const options = paymentOptions(order, settings, razorpayReady);

  if (method === "prepaid") {
    if (!options.prepaidAllowed) throw httpError(409, "Online payment is not set up.", "NO_PAYMENTS");
    order.payment.method = "prepaid";
    order.payment.status = "pending";
    order.status = "awaiting_payment";
    order.chatStep = "";
    order.holdUntil = new Date(now.getTime() + settings.paymentHoldMinutes * 60_000);
    order.history.push(historyEntry(by, "payment_chosen", "prepaid", now));
    await scheduleExpiry(order, session);
    await enqueue("payment.createLink", { orderId: String(order._id) }, { session, dedupeKey: `paylink:${order._id}` });
    await order.save({ session });
    return order;
  }

  if (method !== "cod") throw httpError(400, "Payment must be prepaid or cod", "BAD_METHOD");
  if (!options.codAllowed) throw httpError(409, "Cash on delivery is not available for this order.", "NO_COD");
  const { score, reasons } = await scoreCod({ tenantId, order, session, now });
  const band = codBand(score, settings.cod);
  order.payment.method = "cod";
  order.cod = { score, band, reasons, confirmedAt: null };
  order.history.push(historyEntry(by, "payment_chosen", `cash on delivery, risk ${score} (${band}): ${reasons.join("; ")}`, now));

  if (band === "low") return confirmOrder({ tenantId, order, by: "system", session, now });

  order.status = "awaiting_confirmation";
  order.chatStep = "awaiting_cod_confirm";
  order.holdUntil = new Date(now.getTime() + settings.cod.confirmHours * 3600_000);
  await scheduleExpiry(order, session);
  const content = band === "high" ? say.codPrepayOnly(order, settings.orderPrefix) : say.codConfirm(order, settings.orderPrefix);
  if (!options.prepaidAllowed) content.buttons = content.buttons.filter((button) => button.id !== "pay_prepaid");
  await tellCustomer({ tenantId, order, content, settings, session, now });
  await order.save({ session });
  return order;
}

/** The order is final: stock leaves the shelf, the GST invoice is written, the customer is told. */
export async function confirmOrder({ tenantId, order, by, session, now = new Date() }) {
  if (!OPEN_STATUSES.includes(order.status) || order.stockState !== "held") throw httpError(409, "Only an open order can be confirmed.", "NOT_OPEN");
  if (!order.shipTo?.pincode && order.channel !== "store") throw httpError(409, "The delivery address is needed first.", "NO_ADDRESS");
  if (order.payment.method === "prepaid" && order.payment.status !== "paid") throw httpError(409, "This order is waiting for its payment.", "NOT_PAID");
  if (order.payment.method === "cod" && order.cod.band === "high" && who(by) === "customer") throw httpError(409, "This order needs online payment.", "PREPAY_ONLY");
  const settings = await getSettings(tenantId, session);
  await commitStock({ tenantId, locationId: order.locationId, lines: order.lines, orderId: order._id, by: who(by), session, at: now });
  order.stockState = "committed";
  order.status = "confirmed";
  order.chatStep = "";
  order.holdUntil = null;
  order.confirmedAt = now;
  if (order.payment.method === "cod") order.cod.confirmedAt = now;
  order.history.push(historyEntry(by, "confirmed", "", now));
  try {
    const invoice = await issueInvoice({ tenantId, order, settings, session, at: now });
    order.invoiceId = invoice._id;
  } catch (error) {
    if (error.code !== "STATE_UNSURE") throw error;
    order.history.push(historyEntry("system", "invoice_waiting", error.message, now));
  }
  await tellCustomer({ tenantId, order, content: say.confirmed(order, settings.orderPrefix), settings, session, now });
  await order.save({ session });
  return order;
}

/** Staff fix the delivery state when the pincode was ambiguous; the invoice follows. */
export async function setDeliveryState({ tenantId, order, stateCode, state, by, session, now = new Date() }) {
  order.shipTo.stateCode = stateCode;
  order.shipTo.state = state;
  order.shipTo.stateSure = true;
  order.history.push(historyEntry(by, "state_set", state, now));
  if (order.stockState === "committed" && !order.invoiceId) {
    const settings = await getSettings(tenantId, session);
    order.invoiceId = (await issueInvoice({ tenantId, order, settings, session, at: now }))._id;
  }
  await order.save({ session });
  return order;
}

/** A payment arrived for an order waiting for it. A repeat (or a late one) changes nothing. */
export async function paymentReceived({ tenantId, order, by = "razorpay", session, now = new Date() }) {
  if (order.payment.status === "paid") return order;
  order.payment.status = "paid";
  order.payment.paidAt = now;
  if (order.status === "awaiting_payment" && order.stockState === "held") return confirmOrder({ tenantId, order, by, session, now });
  // Paid after the hold ran out and the order was cancelled: staff must refund or re-place it.
  order.history.push(historyEntry(by, "paid_late", "Payment arrived after the order was cancelled: refund it or place it again by hand.", now));
  await order.save({ session });
  return order;
}

/** Cancels an order that has not shipped: held stock is released, taken stock goes back on the shelf. */
export async function cancelOrder({ tenantId, order, by, reason = "", session, now = new Date() }) {
  if (["shipped", "delivered", "rto", "returned", "cancelled"].includes(order.status)) throw httpError(409, "A shipped, delivered or cancelled order cannot be cancelled.", "NOT_CANCELLABLE");
  if (order.shipment?.providerOrderId) throw httpError(409, "A courier is booked for this order. Cancel the courier booking first.", "COURIER_BOOKED");
  const settings = await getSettings(tenantId, session);
  if (order.stockState === "held") {
    await releaseStock({ tenantId, locationId: order.locationId, lines: order.lines, session });
    order.stockState = "released";
  } else if (order.stockState === "committed") {
    await restock({ tenantId, locationId: order.locationId, lines: order.lines, orderId: order._id, kind: "cancel", by: who(by), note: reason, session, at: now });
    order.stockState = "released";
    if (order.invoiceId) order.creditNoteId = (await issueInvoice({ tenantId, order, settings, kind: "credit_note", session, at: now }))?._id || null;
  }
  order.status = "cancelled";
  order.chatStep = "";
  order.holdUntil = null;
  order.cancelReason = String(reason || "").slice(0, 200);
  order.history.push(historyEntry(by, "cancelled", order.cancelReason, now));
  await tellCustomer({ tenantId, order, content: say.cancelled(order, settings.orderPrefix), settings, session, now });
  await order.save({ session });
  return order;
}

/** The hold ran out: an order still open is cancelled. An old job for an extended hold does nothing. */
export async function expireHold({ tenantId, order, session, now = new Date() }) {
  if (!OPEN_STATUSES.includes(order.status) || order.stockState !== "held" || !order.holdUntil || order.holdUntil > now) return order;
  const reason = order.status === "awaiting_payment" ? "payment not received in time" : order.status === "awaiting_confirmation" ? "not confirmed in time" : "no address received";
  return cancelOrder({ tenantId, order, by: "system", reason, session, now });
}

export async function markPacked({ tenantId, order, by, session, now = new Date() }) {
  if (order.status !== "confirmed") throw httpError(409, "Only a confirmed order can be packed.", "NOT_CONFIRMED");
  if (!order.invoiceId) throw httpError(409, "Make the invoice first: confirm the delivery state.", "NO_INVOICE");
  order.status = "packed";
  order.history.push(historyEntry(by, "packed", "", now));
  await order.save({ session });
  return order;
}

/** Handed to the courier. `notify: false` when a late tracking update already says it is further along. */
export async function markShipped({ tenantId, order, courier, awb, by, notify = true, session, now = new Date() }) {
  if (order.status !== "packed") throw httpError(409, "Pack the order before shipping it.", "NOT_PACKED");
  if (!courier || !awb) throw httpError(400, "Courier and tracking number are needed.", "NO_TRACKING");
  const settings = await getSettings(tenantId, session);
  order.status = "shipped";
  order.shipment.courier = String(courier).slice(0, 40);
  order.shipment.awb = String(awb).slice(0, 40);
  order.shipment.shippedAt = now;
  order.history.push(historyEntry(by, "shipped", `${order.shipment.courier} ${order.shipment.awb}`, now));
  if (notify) await tellCustomer({ tenantId, order, content: say.shipped(order, settings.orderPrefix), settings, session, now });
  await order.save({ session });
  return order;
}

export async function markDelivered({ tenantId, order, by, session, now = new Date() }) {
  if (order.status !== "shipped") throw httpError(409, "Only a shipped order can be delivered.", "NOT_SHIPPED");
  const settings = await getSettings(tenantId, session);
  order.status = "delivered";
  order.shipment.deliveredAt = now;
  if (order.payment.method === "cod") {
    order.payment.status = "paid";
    order.payment.paidAt = now;
  }
  order.history.push(historyEntry(by, "delivered", "", now));
  await tellCustomer({ tenantId, order, content: say.delivered(order, settings.orderPrefix), settings, session, now });
  await order.save({ session });
  return order;
}

/** Refused or undeliverable: back on the shelf, credit note written. Feeds the COD score of customer and pincode. */
export async function markRto({ tenantId, order, by, note = "", session, now = new Date() }) {
  if (order.status !== "shipped") throw httpError(409, "Only a shipped order can come back undelivered.", "NOT_SHIPPED");
  const settings = await getSettings(tenantId, session);
  await restock({ tenantId, locationId: order.locationId, lines: order.lines, orderId: order._id, kind: "return", by: who(by), note: note || "returned to origin", session, at: now });
  order.status = "rto";
  order.stockState = "released";
  order.shipment.rtoAt = now;
  order.creditNoteId = (await issueInvoice({ tenantId, order, settings, kind: "credit_note", session, at: now }))?._id || null;
  order.history.push(historyEntry(by, "rto", note, now));
  await order.save({ session });
  return order;
}

/** The customer sent a delivered order back. The refund itself is made in the payment gateway. */
export async function markReturned({ tenantId, order, by, reason, session, now = new Date() }) {
  if (order.status !== "delivered") throw httpError(409, "Only a delivered order can be returned.", "NOT_DELIVERED");
  if (!String(reason || "").trim()) throw httpError(400, "Say why it came back (too small, too big, looks different, quality...).", "REASON_REQUIRED");
  const settings = await getSettings(tenantId, session);
  await restock({ tenantId, locationId: order.locationId, lines: order.lines, orderId: order._id, kind: "return", by: who(by), note: reason, session, at: now });
  order.status = "returned";
  order.stockState = "released";
  order.creditNoteId = (await issueInvoice({ tenantId, order, settings, kind: "credit_note", session, at: now }))?._id || null;
  order.history.push(historyEntry(by, "returned", reason, now));
  await order.save({ session });
  return order;
}

/** A sale at the store counter: priced, taken off the shelf and invoiced in one step. */
export async function storeSale({ tenantId, locationId, items, method, customer = {}, by, session, now = new Date() }) {
  if (!["store_cash", "store_upi", "store_card"].includes(method)) throw httpError(400, "Payment must be store_cash, store_upi or store_card", "BAD_METHOD");
  const settings = await getSettings(tenantId, session);
  const location = await Location.findOne({ _id: locationId, tenantId, active: true }).session(session);
  if (!location) throw httpError(404, "Location not found", "NO_LOCATION");
  const lines = await priceLines({ tenantId, items, settings, session });
  await holdStock({ tenantId, locationId: location._id, lines, session });
  const order = new Order({
    tenantId,
    number: await nextNumber(`order:${tenantId}`, session),
    channel: "store",
    customer: { name: String(customer.name || "").slice(0, 80), phone: String(customer.phone || "").replace(/\D/g, "").slice(0, 15) },
    locationId: location._id,
    lines,
    totals: totalsOf(lines),
    payment: { method, status: "paid", paidAt: now },
    status: "awaiting_payment",
    stockState: "held",
    history: [historyEntry(by, "store_sale", location.code, now)],
  });
  await confirmOrder({ tenantId, order, by, session, now });
  order.status = "delivered";
  order.shipment.deliveredAt = now;
  await order.save({ session });
  return order;
}
