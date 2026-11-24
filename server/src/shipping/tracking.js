import { getSettings } from "../models/index.js";
import { historyEntry, markDelivered, markRto, markShipped, tellCustomer } from "../commerce/orders.js";
import * as say from "../commerce/messages.js";

// Tracking updates (Shiprocket's webhook, or the hourly poll) move a booked order along by itself:
// picked up -> shipped, delivered -> delivered (COD counted as paid), back at the store -> RTO with
// the stock restocked and a credit note. Updates that arrive late or twice change nothing.

const KEEP_EVENTS = 40;

// Shiprocket's shipment status codes (tracking API), for when only the number is sent.
const BY_CODE = {
  1: "booked", 2: "booked", 3: "booked", 4: "booked", 5: "booked", 13: "booked", 15: "booked", 19: "booked", 20: "booked",
  6: "in_transit", 18: "in_transit", 42: "in_transit",
  7: "delivered",
  8: "cancelled",
  9: "rto_started",
  10: "rto_delivered", 14: "rto_delivered",
  17: "out_for_delivery",
  21: "undelivered",
};

/** One word for what the courier says: booked, in_transit, out_for_delivery, delivered, undelivered, rto_started, rto_delivered, cancelled or other. */
export function classify({ status = "", statusId = null } = {}) {
  const text = String(status).toUpperCase().replace(/[_-]+/g, " ").replace(/\s+/g, " ").trim();
  if (text) {
    if (/\bRTO\b|RETURN TO ORIGIN/.test(text)) return /DELIVERED|ACKNOWLEDGED/.test(text) ? "rto_delivered" : "rto_started";
    if (/UNDELIVERED|NOT DELIVERED|DELIVERY FAILED|FAILED DELIVERY|\bNDR\b/.test(text)) return "undelivered";
    if (/OUT FOR DELIVERY/.test(text)) return "out_for_delivery";
    if (/\bDELIVERED\b/.test(text)) return "delivered";
    if (/CANCEL/.test(text)) return "cancelled";
    if (/PICKED UP|SHIPPED|IN TRANSIT|REACHED|DESTINATION|MISROUTED|DELAYED|HUB/.test(text)) return "in_transit";
    if (/AWB|LABEL|MANIFEST|PICKUP|NEW|BOOKED/.test(text)) return "booked";
  }
  return BY_CODE[Number(statusId)] || "other";
}

/** "2023-05-19 11:59:16" or "23 05 2023 11:43:52", India time -> Date. */
export function parseCourierTime(value) {
  const text = String(value || "").trim();
  let match = text.match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?/);
  if (match) return new Date(`${match[1]}-${match[2]}-${match[3]}T${match[4]}:${match[5]}:${match[6] || "00"}+05:30`);
  match = text.match(/^(\d{2})[ -/](\d{2})[ -/](\d{4})[ T](\d{2}):(\d{2})(?::(\d{2}))?/);
  if (match) return new Date(`${match[3]}-${match[2]}-${match[1]}T${match[4]}:${match[5]}:${match[6] || "00"}+05:30`);
  return null;
}

function eventsFrom(scans) {
  return (Array.isArray(scans) ? scans : [])
    .map((scan) => ({ at: parseCourierTime(scan?.date), status: String(scan?.["sr-status-label"] && scan["sr-status-label"] !== "NA" ? scan["sr-status-label"] : scan?.status || "").slice(0, 60), activity: String(scan?.activity || "").slice(0, 160), location: String(scan?.location || "").slice(0, 100) }))
    .filter((event) => event.at && !Number.isNaN(event.at.getTime()))
    .sort((a, b) => b.at - a.at)
    .slice(0, KEEP_EVENTS);
}

/**
 * Applies one tracking update to an order inside the caller's transaction.
 * `update`: { status, statusId, scans, at } where `at` is when the courier recorded it.
 */
export async function applyTracking({ tenantId, order, update, session, now = new Date() }) {
  const at = update.at && !Number.isNaN(update.at.getTime()) ? update.at : now;
  // An update older than the one we already have (webhooks can arrive out of order) is ignored.
  if (order.shipment.trackedAt && at < order.shipment.trackedAt) return { order, kind: "stale" };
  const kind = classify(update);
  const statusText = String(update.status || "").slice(0, 60) || kind.replace(/_/g, " ");
  const changed = statusText !== order.shipment.trackingStatus;
  order.shipment.trackingStatus = statusText;
  order.shipment.trackedAt = at;
  const events = eventsFrom(update.scans);
  if (events.length) order.shipment.events = events;

  const by = "courier";
  const { courier, awb } = order.shipment;
  const ship = async (notify) => {
    if (order.status === "packed" && courier && awb) await markShipped({ tenantId, order, courier, awb, by, notify, session, now: at });
  };
  if (kind === "in_transit") await ship(true);
  else if (kind === "out_for_delivery") {
    await ship(true);
    if (order.status === "shipped" && !order.shipment.outForDeliveryAt) {
      order.shipment.outForDeliveryAt = at;
      order.history.push(historyEntry(by, "out_for_delivery", "", at));
      const settings = await getSettings(tenantId, session);
      await tellCustomer({ tenantId, order, content: say.outForDelivery(order, settings.orderPrefix), settings, session, now });
    }
  } else if (kind === "delivered") {
    await ship(false);
    if (order.status === "shipped") await markDelivered({ tenantId, order, by, session, now: at });
  } else if (kind === "rto_started") {
    await ship(false);
    if (order.status === "shipped" && !order.shipment.rtoStartedAt) {
      order.shipment.rtoStartedAt = at;
      order.history.push(historyEntry(by, "rto_started", statusText, at));
    }
  } else if (kind === "rto_delivered") {
    await ship(false);
    if (order.status === "shipped") await markRto({ tenantId, order, by, note: "returned by the courier", session, now: at });
  } else if (changed && (kind === "undelivered" || kind === "cancelled")) {
    // A failed delivery attempt or a cancelled pickup: staff should call the customer / rebook.
    const activity = events[0]?.activity || statusText;
    order.history.push(historyEntry(by, kind === "undelivered" ? "delivery_failed" : "courier_cancelled", activity, at));
  }
  await order.save({ session });
  return { order, kind };
}
