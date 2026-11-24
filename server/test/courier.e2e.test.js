import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import mongoose from "mongoose";
import { createApp } from "../src/app.js";
import { createHandlers } from "../src/handlers.js";
import { drain } from "../src/jobs/runner.js";
import { withTransaction } from "../src/db.js";
import { createStyle } from "../src/commerce/catalog.js";
import { receiveStock } from "../src/commerce/stock.js";
import { createSession } from "../src/auth/sessions.js";
import { hashPassword } from "../src/security/password.js";
import { createFakeShiprocket } from "../src/shipping/fakeShiprocket.js";
import { Invoice, Location, Order, Settings, Sku, StockLevel, User } from "../src/models/index.js";
import { apiClient, clearCollections, connectTestDb, inboundButtonPayload, inboundCartPayload, inboundTextPayload, listen, sign, startFakeMeta, testConfig } from "./helpers.js";

// Courier booking through Shiprocket (a local stand-in): rates, booking, label, cancelling and
// rebooking, and tracking updates by webhook and by the hourly poll moving the order along.

const WEBHOOK_TOKEN = "courier-webhook-token-0123456789";
const SKU = "DRS-001-M";
const ADDRESS = "Asha Jain, Flat 12, Shanti Apartment, Vijay Nagar main road, near C21 mall, Indore 452010";

let meta;
let fake;
let config;
let baseUrl;
let server;
let handlers;
let offsetMs = 0;
let counter = 0;
const now = () => new Date(Date.now() + offsetMs);
const nextId = () => `wamid.in.c${(counter += 1)}`;

async function customer(payload) {
  const raw = Buffer.from(JSON.stringify(payload));
  const response = await fetch(`${baseUrl}/webhooks/whatsapp`, { method: "POST", headers: { "content-type": "application/json", "x-hub-signature-256": sign(raw, config.WHATSAPP_APP_SECRET) }, body: raw });
  assert.equal(response.status, 200);
  await drain(handlers, { now });
}

function lastSentTo(waId) {
  const body = meta.requests.filter((request) => request.body?.to === waId).at(-1)?.body;
  return body?.text?.body || body?.interactive?.body?.text || "";
}

async function seed() {
  await Settings.create({ tenantId: config.TENANT_ID, brandName: "The Hanger", legalName: "The Hanger Western Hub", gstin: "23ABCDE1234F1Z5", stateCode: "23", onlineLocationCode: "ONL" });
  const [online] = await Location.create([{ tenantId: config.TENANT_ID, code: "ONL", name: "Online stock room", kind: "warehouse", address: "Indore", pincode: "452001", invoicePrefix: "IN1" }]);
  await withTransaction(async (session) => {
    const { style, skus } = await createStyle({ tenantId: config.TENANT_ID, data: { code: "DRS-001", name: "Linen midi dress", category: "dresses", pricePaise: 199900, images: ["https://img.test/1.jpg"] }, sizes: ["M"], session });
    style.status = "live";
    await style.save({ session });
    await receiveStock({ tenantId: config.TENANT_ID, locationId: online._id, items: [{ sku: skus[0], qty: 3 }], by: "test", session });
  });
}

/** A WhatsApp COD order, confirmed and packed, ready for the courier. */
async function packedOrder(api, waId = "919800000001") {
  await customer(inboundCartPayload({ from: waId, id: nextId(), items: [{ skuCode: SKU, qty: 1 }] }));
  await customer(inboundTextPayload({ from: waId, id: nextId(), text: ADDRESS }));
  await customer(inboundButtonPayload({ from: waId, id: nextId(), buttonId: "pay_cod" }));
  const order = await Order.findOne({ "customer.phone": waId });
  assert.equal(order.status, "confirmed");
  const packed = await api(`/api/orders/${order._id}/pack`, { method: "POST", body: {} });
  assert.equal(packed.status, 200, JSON.stringify(packed.data));
  return order._id;
}

async function ownerApi() {
  const owner = await User.create({ tenantId: config.TENANT_ID, name: "Owner", email: "owner@hanger.test", role: "owner", status: "active", passwordHash: await hashPassword("Owner-password-1"), mustChangePassword: false, twoFactor: { enabled: true } });
  const api = apiClient(baseUrl);
  api.setCookie(`hh_session=${await createSession({ user: owner, req: { ip: "", get: () => "" }, twoFactorPending: false })}`);
  return api;
}

const postTracking = (body, token = WEBHOOK_TOKEN) => fetch(`${baseUrl}/webhooks/courier-updates`, { method: "POST", headers: { "content-type": "application/json", "x-api-key": token }, body: JSON.stringify(body) });

test.before(async () => {
  await connectTestDb();
  meta = await startFakeMeta();
  fake = createFakeShiprocket();
  const fakeBase = await fake.listen();
  config = testConfig({ META_GRAPH_BASE: meta.baseUrl, SHIPPING_PROVIDER: "shiprocket", SHIPROCKET_EMAIL: fake.credentials.email, SHIPROCKET_PASSWORD: fake.credentials.password, SHIPROCKET_WEBHOOK_TOKEN: WEBHOOK_TOKEN, SHIPROCKET_API_BASE: fakeBase });
  handlers = createHandlers({ config, now });
  server = http.createServer(createApp({ config, logger: { error: (info, message) => console.error(message, info?.err?.stack || info?.err?.message), warn() {}, info() {} } }));
  baseUrl = await listen(server);
  fake.setWebhook(`${baseUrl}/webhooks/courier-updates`, WEBHOOK_TOKEN);
});

test.beforeEach(async () => {
  await clearCollections();
  meta.requests.length = 0;
  fake.calls.length = 0;
  fake.orders.clear();
  fake.state.failAssign = false;
  offsetMs = 0;
});

test.after(async () => {
  server?.close();
  await meta.close();
  await fake.close();
  await mongoose.disconnect();
});

test("book a courier for a packed COD order, then the webhook and the poll move it to delivered", async () => {
  await seed();
  const api = await ownerApi();
  const orderId = await packedOrder(api);

  const rates = await api(`/api/orders/${orderId}/courier-rates?weight=500`);
  assert.equal(rates.status, 200, JSON.stringify(rates.data));
  assert.equal(rates.data.cod, true);
  assert.deepEqual(rates.data.rates.map((rate) => rate.courierId), [51, 43, 24], "cheapest first");
  assert.equal(rates.data.rates[1].ratePaise, 9700, "Rs 62 + Rs 35 COD charge");
  assert.ok(rates.data.rates.find((rate) => rate.courierId === 43).recommended);
  const query = fake.calls.find((call) => call.path === "/courier/serviceability").query;
  assert.deepEqual([query.pickup_postcode, query.delivery_postcode, query.cod, query.weight], ["452001", "452010", "1", "0.5"]);

  const early = await api(`/api/orders/${orderId}/book-courier`, { method: "POST", body: { courierId: 43 } });
  assert.equal(early.status, 409);
  assert.equal(early.data.error, "NO_PICKUP_LOCATION");
  const saved = await api("/api/settings", { method: "PATCH", body: { shipping: { pickupLocation: "Hanger online stock room", weightGrams: 600 } } });
  assert.equal(saved.status, 200, JSON.stringify(saved.data));
  const pickups = await api("/api/shipping/pickup-locations");
  assert.deepEqual(pickups.data.locations.map((row) => row.name), ["Hanger online stock room"]);

  const booked = await api(`/api/orders/${orderId}/book-courier`, { method: "POST", body: { courierId: 43 } });
  assert.equal(booked.status, 200, JSON.stringify(booked.data));
  const shipment = booked.data.order.shipment;
  assert.equal(booked.data.order.status, "packed", "packed until the courier collects it");
  assert.equal(shipment.courier, "Delhivery Surface");
  assert.match(shipment.awb, /^43\d+/);
  assert.equal(shipment.chargePaise, 15900, "600 g is two half-kilo slabs: 2 x Rs 62 + Rs 35 COD");
  assert.equal(shipment.weightGrams, 600, "the default weight from settings");
  assert.match(shipment.labelUrl, /\/labels\/\d+\.pdf$/);
  assert.match(shipment.pickupNote, /^pickup \d{4}-\d{2}-\d{2}/);
  const created = fake.calls.find((call) => call.path === "/orders/create/adhoc").body;
  const order = await Order.findById(orderId);
  assert.equal(created.order_id, `HWH-${order.number}`);
  assert.equal(created.payment_method, "COD");
  assert.equal(created.billing_phone, "9800000001");
  assert.equal(created.billing_customer_name, "Asha");
  assert.equal(created.billing_last_name, "Jain");
  assert.equal(created.billing_city, "Indore");
  assert.equal(created.sub_total, 1999);
  assert.equal(created.weight, 0.6);
  assert.equal(created.billing_email, undefined, "nothing beyond what the booking needs");

  const label = await fetch(shipment.labelUrl);
  assert.equal(label.headers.get("content-type"), "application/pdf");
  assert.ok((await label.text()).startsWith("%PDF-1.4"));

  const again = await api(`/api/orders/${orderId}/book-courier`, { method: "POST", body: { courierId: 51 } });
  assert.equal(again.data.error, "ALREADY_BOOKED");
  const cancelOrder = await api(`/api/orders/${orderId}/cancel`, { method: "POST", body: { reason: "customer changed her mind" } });
  assert.equal(cancelOrder.data.error, "COURIER_BOOKED", "the courier booking is cancelled first");

  assert.equal((await postTracking({ awb: shipment.awb, current_status: "PICKED UP" }, "wrong-token-wrong-token")).status, 401);
  assert.equal((await postTracking({})).status, 200, "Shiprocket's test call is acknowledged");

  assert.equal((await fake.advance(shipment.awb, "PICKED UP")).status, 200);
  await drain(handlers, { now });
  let fresh = await Order.findById(orderId);
  assert.equal(fresh.status, "shipped");
  assert.equal(fresh.shipment.trackingStatus, "PICKED UP");
  assert.match(lastSentTo("919800000001"), new RegExp(`Track it here: https://shiprocket.co/tracking/${shipment.awb}`));

  await fake.advance(shipment.awb, "OUT FOR DELIVERY");
  await drain(handlers, { now });
  fresh = await Order.findById(orderId);
  assert.ok(fresh.shipment.outForDeliveryAt);
  assert.match(lastSentTo("919800000001"), /out for delivery today with Delhivery Surface\. Please keep Rs 1,999(\.00)? ready/);

  // A webhook that never arrives: the hourly poll reads the courier's state instead.
  await fake.advance(shipment.awb, "DELIVERED", { push: false });
  await handlers["shipping.poll"]();
  assert.equal((await Order.findById(orderId)).status, "shipped", "checked recently: not polled yet");
  offsetMs = 2 * 60 * 60_000;
  await handlers["shipping.poll"]();
  fresh = await Order.findById(orderId);
  assert.equal(fresh.status, "delivered");
  assert.equal(fresh.payment.status, "paid", "COD collected on delivery");
  assert.ok(fresh.shipment.events.length >= 3);
  assert.equal(fresh.shipment.events[0].status, "DELIVERED", "newest scan first");

  // A late, older update changes nothing.
  await postTracking({ awb: shipment.awb, current_status: "IN TRANSIT", shipment_status_id: 18, current_timestamp: "01 01 2026 10:00:00" });
  await drain(handlers, { now });
  assert.equal((await Order.findById(orderId)).shipment.trackingStatus, "DELIVERED");
});

test("cancel a booking and rebook; a failed booking resumes without a second courier order; RTO comes back to stock", async () => {
  await seed();
  await Settings.updateOne({}, { $set: { "shipping.pickupLocation": "Hanger online stock room" } });
  const api = await ownerApi();
  const orderId = await packedOrder(api);

  const first = await api(`/api/orders/${orderId}/book-courier`, { method: "POST", body: { courierId: 51 } });
  assert.equal(first.status, 200, JSON.stringify(first.data));
  const cancelled = await api(`/api/orders/${orderId}/cancel-courier`, { method: "POST", body: {} });
  assert.equal(cancelled.status, 200, JSON.stringify(cancelled.data));
  assert.equal(cancelled.data.order.shipment.awb, "");
  assert.equal(cancelled.data.order.shipment.providerOrderId, "");
  assert.equal(cancelled.data.order.status, "packed");
  assert.deepEqual(fake.calls.find((call) => call.path === "/orders/cancel").body.ids, [Number(first.data.order.shipment.providerOrderId)]);

  // The courier refuses the AWB: the Shiprocket order is kept and the lock released.
  fake.state.failAssign = true;
  const failed = await api(`/api/orders/${orderId}/book-courier`, { method: "POST", body: { courierId: 43 } });
  assert.equal(failed.status, 422);
  assert.match(failed.data.message, /Courier not serviceable right now/);
  let order = await Order.findById(orderId);
  assert.ok(order.shipment.shipmentId);
  assert.equal(order.shipment.bookingStartedAt, null);
  fake.state.failAssign = false;
  const retried = await api(`/api/orders/${orderId}/book-courier`, { method: "POST", body: { courierId: 43 } });
  assert.equal(retried.status, 200, JSON.stringify(retried.data));
  const creates = fake.calls.filter((call) => call.path === "/orders/create/adhoc").map((call) => call.body.order_id);
  order = await Order.findById(orderId);
  assert.deepEqual(creates, [`HWH-${order.number}`, `HWH-${order.number}-2`], "a fresh reference after the cancelled one, created once");

  const { awb } = retried.data.order.shipment;
  await fake.advance(awb, "IN TRANSIT");
  await fake.advance(awb, "RTO INITIATED");
  await drain(handlers, { now });
  order = await Order.findById(orderId);
  assert.equal(order.status, "shipped");
  assert.ok(order.shipment.rtoStartedAt);
  assert.ok(order.history.some((entry) => entry.event === "rto_started"));

  await fake.advance(awb, "RTO DELIVERED");
  await drain(handlers, { now });
  order = await Order.findById(orderId);
  assert.equal(order.status, "rto");
  const sku = await Sku.findOne({ code: SKU });
  assert.equal((await StockLevel.findOne({ skuId: sku._id })).onHand, 3, "the piece is back on the shelf");
  assert.ok(await Invoice.findOne({ kind: "credit_note", orderId }), "credit note written");
});
