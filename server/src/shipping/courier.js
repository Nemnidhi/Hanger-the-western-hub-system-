import express from "express";
import mongoose from "mongoose";
import { Location, Order, WebhookEvent, getSettings, orderLabel } from "../models/index.js";
import { enqueue, RetryableError } from "../jobs/queue.js";
import { isDuplicateKeyError, withTransaction } from "../db.js";
import { httpError } from "../commerce/orders.js";
import { applyTracking, parseCourierTime } from "./tracking.js";
import { isValidWebhookToken } from "./shiprocket.js";

// Booking a courier for a packed order, cancelling it, and taking in tracking updates. The calls to
// the courier service happen outside any database transaction (they can take seconds); each answer
// is saved as soon as it arrives, so a booking that fails half-way picks up where it stopped.

const LOCK_MS = 2 * 60_000;
const POLL_EVERY_MS = 90 * 60_000;

const phone10 = (value) => String(value || "").replace(/\D/g, "").slice(-10);

/** India time as "YYYY-MM-DD HH:mm". */
function istStamp(date) {
  const ist = new Date(date.getTime() + 5.5 * 60 * 60_000);
  return ist.toISOString().slice(0, 16).replace("T", " ");
}

function parcel(settings, weightGrams) {
  const shipping = settings.shipping || {};
  const grams = Number(weightGrams) || shipping.weightGrams || 500;
  return { grams, weightKg: Math.round(grams) / 1000, lengthCm: shipping.lengthCm || 30, breadthCm: shipping.breadthCm || 25, heightCm: shipping.heightCm || 4 };
}

async function pickupPincode(order) {
  const location = await Location.findById(order.locationId).lean();
  if (!location?.pincode) throw httpError(409, "The shipping location has no pincode. Add it in Settings > Locations.", "NO_PICKUP_PINCODE");
  return location.pincode;
}

function needsCourier(courier) {
  if (!courier) throw httpError(409, "Courier booking is not set up. Type the tracking number by hand, or add the Shiprocket settings to the server.", "COURIER_OFF");
}

function checkShippable(order) {
  if (!["confirmed", "packed"].includes(order.status)) throw httpError(409, "Only a confirmed or packed order can be booked with a courier.", "NOT_PACKED");
  if (!/^[1-9]\d{5}$/.test(order.shipTo?.pincode || "")) throw httpError(409, "The delivery address has no pincode.", "NO_PINCODE");
}

/** Couriers that serve this order's pincode, with their price for this weight. */
export async function courierRates({ tenantId, order, courier, weightGrams }) {
  needsCourier(courier);
  checkShippable(order);
  const settings = await getSettings(tenantId);
  const box = parcel(settings, weightGrams);
  const cod = order.payment.method === "cod" && order.payment.status !== "paid";
  const rates = await courier.rates({
    pickupPincode: await pickupPincode(order),
    deliveryPincode: order.shipTo.pincode,
    cod,
    weightKg: box.weightKg,
    declaredRupees: Math.round(order.totals.totalPaise / 100),
    lengthCm: box.lengthCm,
    breadthCm: box.breadthCm,
    heightCm: box.heightCm,
  });
  return { rates, weightGrams: box.grams, cod };
}

/** What Shiprocket needs to create the order: the delivery details and the items, nothing else. */
async function bookingPayload({ order, settings, reference, box, courier, now }) {
  const name = (order.shipTo.name || order.customer.name || "Customer").trim();
  const [first, ...rest] = name.split(/\s+/);
  const phone = phone10(order.customer.phone);
  if (phone.length !== 10) throw httpError(409, "The order has no 10-digit phone number for the courier.", "NO_PHONE");
  const place = await courier.postcode({ pincode: order.shipTo.pincode }).catch(() => null);
  const cod = order.payment.method === "cod" && order.payment.status !== "paid";
  return {
    order_id: reference,
    order_date: istStamp(now),
    pickup_location: settings.shipping.pickupLocation,
    billing_customer_name: first,
    billing_last_name: rest.join(" "),
    billing_address: order.shipTo.address.slice(0, 190),
    billing_city: place?.city || order.shipTo.state || "",
    billing_pincode: order.shipTo.pincode,
    billing_state: place?.state || order.shipTo.state || "",
    billing_country: "India",
    billing_phone: phone,
    shipping_is_billing: true,
    order_items: order.lines.map((line) => ({ name: `${line.name} (${line.size})`.slice(0, 100), sku: line.skuCode, units: line.qty, selling_price: line.unitPaise / 100, tax: line.gstRate, hsn: line.hsn })),
    payment_method: cod ? "COD" : "Prepaid",
    sub_total: order.totals.totalPaise / 100,
    length: box.lengthCm,
    breadth: box.breadthCm,
    height: box.heightCm,
    weight: box.weightKg,
  };
}

/** Takes the booking lock on a packed, unbooked order, or says why it cannot. */
async function claimBooking({ tenantId, orderId, now }) {
  const claimed = await Order.findOneAndUpdate(
    // Operators are marked trusted one by one: the global sanitizeFilter strips untrusted ones.
    mongoose.trusted({
      _id: orderId,
      tenantId,
      status: "packed",
      "shipment.awb": "",
      $or: [{ "shipment.bookingStartedAt": null }, { "shipment.bookingStartedAt": mongoose.trusted({ $lt: new Date(now.getTime() - LOCK_MS) }) }],
    }),
    { $set: { "shipment.bookingStartedAt": now } },
    { new: true },
  );
  if (claimed) return claimed;
  const order = await Order.findOne({ _id: orderId, tenantId });
  if (!order) throw httpError(404, "Order not found");
  if (order.shipment.awb) throw httpError(409, "A courier is already booked for this order.", "ALREADY_BOOKED");
  if (order.status !== "packed") throw httpError(409, "Pack the order before booking the courier.", "NOT_PACKED");
  throw httpError(409, "A booking for this order is already in progress. Wait a moment and refresh.", "BOOKING_BUSY");
}

/**
 * Books the chosen courier: creates the order at Shiprocket (once), gets the tracking number, asks
 * for a pickup and fetches the label. The order stays "packed" until the courier collects it.
 */
export async function bookCourier({ tenantId, orderId, courierId, weightGrams, courier, by, now = new Date() }) {
  needsCourier(courier);
  const settings = await getSettings(tenantId);
  if (!settings.shipping?.pickupLocation) throw httpError(409, "Set the pickup address name (as saved in Shiprocket) in Settings > Shipping first.", "NO_PICKUP_LOCATION");
  let order = await claimBooking({ tenantId, orderId, now });
  const release = () => Order.updateOne({ _id: order._id }, { $set: { "shipment.bookingStartedAt": null } });
  try {
    checkShippable(order);
    // The rate is looked up again here (never taken from the browser), which also checks the courier still serves the pincode.
    const { rates } = await courierRates({ tenantId, order, courier, weightGrams });
    const chosen = rates.find((rate) => rate.courierId === Number(courierId));
    if (!chosen) throw httpError(409, "That courier does not serve this pincode for this order any more. Check the rates again.", "COURIER_UNAVAILABLE");
    const box = parcel(settings, weightGrams);

    if (!order.shipment.shipmentId) {
      const attempts = (order.shipment.attempts || 0) + 1;
      const base = orderLabel(order, settings.orderPrefix);
      const reference = attempts > 1 ? `${base}-${attempts}` : base;
      const created = await courier.createOrder(await bookingPayload({ order, settings, reference, box, courier, now }));
      order = await Order.findOneAndUpdate(
        { _id: order._id },
        { $set: { "shipment.provider": courier.name, "shipment.providerOrderId": created.providerOrderId, "shipment.shipmentId": created.shipmentId, "shipment.attempts": attempts, "shipment.weightGrams": box.grams } },
        { new: true },
      );
    }

    const assigned = await courier.assignAwb({ shipmentId: order.shipment.shipmentId, courierId: chosen.courierId });
    await Order.updateOne(
      { _id: order._id },
      { $set: { "shipment.awb": assigned.awb.slice(0, 40), "shipment.courier": (assigned.courierName || chosen.name).slice(0, 40), "shipment.courierId": assigned.courierId, "shipment.chargePaise": chosen.ratePaise, "shipment.bookedAt": now, "shipment.weightGrams": box.grams } },
    );

    // Pickup and label are worth having but not worth losing the booking over: staff can retry both.
    const pickup = await courier.requestPickup({ shipmentId: order.shipment.shipmentId }).catch((error) => ({ ok: false, note: `pickup not requested: ${error.message}` }));
    const label = await courier.label({ shipmentId: order.shipment.shipmentId }).catch(() => null);

    return withTransaction(async (session) => {
      const fresh = await Order.findById(order._id).session(session);
      fresh.shipment.pickupNote = String(pickup.note || "").slice(0, 200);
      if (label?.url) fresh.shipment.labelUrl = label.url;
      fresh.shipment.bookingStartedAt = null;
      fresh.shipment.trackingStatus = "booked";
      const rupees = chosen.ratePaise !== null ? ` for Rs ${(chosen.ratePaise / 100).toFixed(2)}` : "";
      fresh.history.push({ at: now, by: typeof by === "string" ? by : by?.name || by?.email || "staff", event: "courier_booked", note: `${fresh.shipment.courier} ${fresh.shipment.awb}${rupees}` });
      await fresh.save({ session });
      return fresh;
    });
  } catch (error) {
    await release().catch(() => undefined);
    throw error;
  }
}

/** Fetches the label again (for a booking whose label was not ready the first time). */
export async function refreshLabel({ tenantId, orderId, courier }) {
  needsCourier(courier);
  const order = await Order.findOne({ _id: orderId, tenantId });
  if (!order) throw httpError(404, "Order not found");
  if (!order.shipment.shipmentId || !order.shipment.awb) throw httpError(409, "No courier is booked for this order.", "NOT_BOOKED");
  const label = await courier.label({ shipmentId: order.shipment.shipmentId });
  order.shipment.labelUrl = label.url;
  await order.save();
  return order;
}

/** Cancels the booking before the courier collects the parcel. The order stays packed, ready to rebook. */
export async function cancelBooking({ tenantId, orderId, courier, by, now = new Date() }) {
  needsCourier(courier);
  const order = await Order.findOne({ _id: orderId, tenantId });
  if (!order) throw httpError(404, "Order not found");
  if (!order.shipment.providerOrderId) throw httpError(409, "No courier is booked for this order.", "NOT_BOOKED");
  if (order.status !== "packed" && order.status !== "confirmed") throw httpError(409, "The courier already has the parcel; it cannot be cancelled now.", "ALREADY_SHIPPED");
  await courier.cancelOrders({ providerOrderIds: [order.shipment.providerOrderId] });
  const note = `${order.shipment.courier} ${order.shipment.awb}`.trim();
  return withTransaction(async (session) => {
    const fresh = await Order.findById(order._id).session(session);
    // Every booking field back to empty (the attempt count stays, so a rebooking gets a fresh reference).
    Object.assign(fresh.shipment, {
      courier: "", awb: "", provider: "", providerOrderId: "", shipmentId: "", courierId: null, chargePaise: null, weightGrams: null,
      labelUrl: "", pickupNote: "", bookedAt: null, bookingStartedAt: null, trackingStatus: "", trackedAt: null, outForDeliveryAt: null, rtoStartedAt: null, events: [],
    });
    fresh.history.push({ at: now, by: typeof by === "string" ? by : by?.name || by?.email || "staff", event: "courier_cancelled", note });
    await fresh.save({ session });
    return fresh;
  });
}

/** The jobs: one webhook update, and the hourly check of every booked parcel still on its way. */
export function createShippingHandlers({ config, courier, now = () => new Date() }) {
  const tenantId = config.TENANT_ID;
  return {
    async "shipping.update"({ eventId }) {
      const event = await WebhookEvent.findById(eventId);
      if (!event || event.processedAt) return;
      const body = event.payload || {};
      await withTransaction(async (session) => {
        const order = await Order.findOne({ tenantId, "shipment.awb": String(body.awb || "") }).session(session);
        if (order) {
          await applyTracking({
            tenantId,
            order,
            update: { status: body.current_status || body.shipment_status, statusId: body.shipment_status_id, scans: body.scans, at: parseCourierTime(body.current_timestamp) },
            session,
            now: now(),
          });
        }
        await WebhookEvent.updateOne({ _id: event._id }, { $set: { processedAt: now() } }, { session });
      });
    },

    async "shipping.poll"() {
      if (!courier) return;
      const cutoff = new Date(now().getTime() - POLL_EVERY_MS);
      const due = await Order.find(
        mongoose.trusted({
          tenantId,
          status: mongoose.trusted({ $in: ["packed", "shipped"] }),
          "shipment.provider": courier.name,
          "shipment.awb": mongoose.trusted({ $ne: "" }),
          $or: [{ "shipment.trackedAt": null }, { "shipment.trackedAt": mongoose.trusted({ $lt: cutoff }) }],
        }),
        { _id: 1, "shipment.awb": 1 },
      ).sort({ "shipment.trackedAt": 1 }).limit(100).lean();
      let failures = 0;
      for (const row of due) {
        let update;
        try {
          update = await courier.track({ awb: row.shipment.awb });
        } catch (error) {
          failures += 1;
          if (error.retryable && failures >= 3) throw new RetryableError(`Tracking check stopped: ${error.message}`);
          continue;
        }
        if (!update.status && !update.statusId) continue;
        await withTransaction(async (session) => {
          const order = await Order.findById(row._id).session(session);
          // A poll reads the courier's current state, so it counts as of now.
          if (order) await applyTracking({ tenantId, order, update: { ...update, at: now() }, session, now: now() });
        });
      }
    },
  };
}

/**
 * Shiprocket's tracking webhook. The URL avoids the words Shiprocket rejects ("shiprocket", "sr",
 * "kr"). The token is Shiprocket's x-api-key header. Each update is stored once and applied by a job.
 */
export function createCourierWebhookRouter({ config, logger }) {
  const router = express.Router();
  router.post("/webhooks/courier-updates", express.json({ type: () => true, limit: "512kb" }), async (req, res) => {
    if (config.SHIPPING_PROVIDER === "none") return res.sendStatus(404);
    if (!isValidWebhookToken(req.get("x-api-key"), config.SHIPROCKET_WEBHOOK_TOKEN)) return res.sendStatus(401);
    const body = req.body && typeof req.body === "object" ? req.body : {};
    // Shiprocket's "test webhook" button and other empty calls are acknowledged and ignored.
    if (!body.awb) return res.json({ ok: true });
    const key = `courier:${body.awb}:${body.current_status_id ?? body.shipment_status_id ?? ""}:${body.current_timestamp || ""}`.slice(0, 200);
    try {
      await withTransaction(async (session) => {
        const [event] = await WebhookEvent.create([{ tenantId: config.TENANT_ID, key, kind: "other", field: "courier", payload: body }], { session });
        await enqueue("shipping.update", { eventId: String(event._id) }, { session });
      });
    } catch (error) {
      if (!isDuplicateKeyError(error)) {
        logger?.error({ err: { message: error?.message } }, "courier webhook could not be stored");
        return res.sendStatus(503);
      }
    }
    return res.json({ ok: true });
  });
  return router;
}
