import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { createHmac } from "node:crypto";
import mongoose from "mongoose";
import { createApp } from "../src/app.js";
import { createHandlers } from "../src/handlers.js";
import { drain } from "../src/jobs/runner.js";
import { withTransaction } from "../src/db.js";
import { createStyle } from "../src/commerce/catalog.js";
import { receiveStock } from "../src/commerce/stock.js";
import { financialYear } from "../src/commerce/gst.js";
import { createSession } from "../src/auth/sessions.js";
import { hashPassword } from "../src/security/password.js";
import { Invoice, Location, Message, Order, Settings, Sku, StockLevel, StockMove, User } from "../src/models/index.js";
import { apiClient, clearCollections, connectTestDb, inboundButtonPayload, inboundCartPayload, inboundTextPayload, listen, sign, startFakeMeta, testConfig } from "./helpers.js";

// The whole order path on a real replica set: a WhatsApp cart, the address, the payment choice, the
// GST invoice, payment links, hold expiry, cancellation, and a sale at the store counter.

let meta;
let razorpay;
let config;
let baseUrl;
let server;
let handlers;
let offsetMs = 0;
const now = () => new Date(Date.now() + offsetMs);
const advance = (ms) => (offsetMs += ms);
let messageCounter = 0;
const nextId = () => `wamid.in.${(messageCounter += 1)}`;

const INDORE = "Flat 12, Shanti Apartment, Vijay Nagar main road, near C21 mall, Indore 452010";
const MUMBAI = "Flat 3, Sea View Society, Colaba main road, near the museum, Mumbai 400001";
const SKU = "DRS-001-M";

/** A stand-in for Razorpay's API: every payment link gets the next id. */
async function startFakeRazorpay() {
  const requests = [];
  let count = 0;
  const fake = http.createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      requests.push({ url: req.url, body: JSON.parse(body || "{}") });
      count += 1;
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ id: `plink_${count}`, short_url: `https://rzp.test/i/${count}` }));
    });
  });
  const url = await listen(fake);
  return { url, requests, close: () => new Promise((resolve) => fake.close(resolve)) };
}

async function postWebhook(payload) {
  const raw = Buffer.from(JSON.stringify(payload));
  const response = await fetch(`${baseUrl}/webhooks/whatsapp`, { method: "POST", headers: { "content-type": "application/json", "x-hub-signature-256": sign(raw, config.WHATSAPP_APP_SECRET) }, body: raw });
  assert.equal(response.status, 200);
}

async function postRazorpay(body) {
  const raw = Buffer.from(JSON.stringify(body));
  const signature = createHmac("sha256", config.RAZORPAY_WEBHOOK_SECRET).update(raw).digest("hex");
  return (await fetch(`${baseUrl}/webhooks/razorpay`, { method: "POST", headers: { "content-type": "application/json", "x-razorpay-signature": signature, "x-razorpay-event-id": `evt_${body.payload.payment_link.entity.id}` }, body: raw })).status;
}

/** The customer sends a message (cart, text or button tap) and the worker handles everything it causes. */
async function customer(payload) {
  await postWebhook(payload);
  await drain(handlers, { now });
}

const cart = (from, items = [{ skuCode: SKU, qty: 1 }]) => customer(inboundCartPayload({ from, id: nextId(), items }));
const say = (from, text) => customer(inboundTextPayload({ from, id: nextId(), text }));
const tap = (from, buttonId) => customer(inboundButtonPayload({ from, id: nextId(), buttonId }));

/** The text of the last WhatsApp message sent to a number. */
function lastSentTo(waId) {
  const sent = meta.requests.filter((request) => request.body?.to === waId);
  const body = sent.at(-1)?.body;
  return body?.text?.body || body?.interactive?.body?.text || "";
}

async function stockOf(code, locationCode = "ONL") {
  const sku = await Sku.findOne({ code });
  const location = await Location.findOne({ code: locationCode });
  return StockLevel.findOne({ skuId: sku._id, locationId: location._id }).lean();
}

async function seed({ pieces = 2 } = {}) {
  await Settings.create({ tenantId: config.TENANT_ID, brandName: "The Hanger", legalName: "The Hanger Western Hub", gstin: "23ABCDE1234F1Z5", stateCode: "23", onlineLocationCode: "ONL" });
  const [online] = await Location.create([
    { tenantId: config.TENANT_ID, code: "ONL", name: "Online stock room", kind: "warehouse", address: "Indore", pincode: "452001", invoicePrefix: "IN1" },
    { tenantId: config.TENANT_ID, code: "ST1", name: "Store", kind: "store", address: "Indore", pincode: "452001", invoicePrefix: "ST1" },
  ]);
  await withTransaction(async (session) => {
    const { style, skus } = await createStyle({ tenantId: config.TENANT_ID, data: { code: "DRS-001", name: "Linen midi dress", category: "dresses", pricePaise: 199900, images: ["https://img.test/1.jpg"] }, sizes: ["M", "S", "L"], session });
    style.status = "live";
    await style.save({ session });
    const medium = skus.find((sku) => sku.code === SKU);
    await receiveStock({ tenantId: config.TENANT_ID, locationId: online._id, items: [{ sku: medium, qty: pieces }], by: "test", session });
    const store = await Location.findOne({ code: "ST1" }).session(session);
    await receiveStock({ tenantId: config.TENANT_ID, locationId: store._id, items: [{ sku: medium, qty: 1 }], by: "test", session });
  });
}

async function ownerApi() {
  const owner = await User.create({ tenantId: config.TENANT_ID, name: "Owner", email: "owner@hanger.test", role: "owner", status: "active", passwordHash: await hashPassword("Owner-password-1"), mustChangePassword: false, twoFactor: { enabled: true } });
  const api = apiClient(baseUrl);
  api.setCookie(`hh_session=${await createSession({ user: owner, req: { ip: "", get: () => "" }, twoFactorPending: false })}`);
  return api;
}

test.before(async () => {
  await connectTestDb();
  meta = await startFakeMeta();
  razorpay = await startFakeRazorpay();
  config = testConfig({ META_GRAPH_BASE: meta.baseUrl, RAZORPAY_KEY_ID: "rzp_test_key", RAZORPAY_KEY_SECRET: "rzp-test-secret", RAZORPAY_WEBHOOK_SECRET: "rzp-webhook-secret", RAZORPAY_API_BASE: razorpay.url });
  handlers = createHandlers({ config, now });
  server = http.createServer(createApp({ config }));
  baseUrl = await listen(server);
});

test.beforeEach(async () => {
  await clearCollections();
  meta.requests.length = 0;
  razorpay.requests.length = 0;
  offsetMs = 0;
});

test.after(async () => {
  server?.close();
  await meta.close();
  await razorpay.close();
  await mongoose.disconnect();
});

test("WhatsApp cart -> address -> cash on delivery -> GST invoice with CGST + SGST at 5%", async () => {
  await seed();
  await cart("919800000001");
  let order = await Order.findOne();
  assert.equal(order.status, "draft");
  assert.equal(order.chatStep, "awaiting_address");
  assert.equal(order.totals.totalPaise, 199900);
  assert.match(lastSentTo("919800000001"), /delivery address/);
  assert.deepEqual([(await stockOf(SKU)).onHand, (await stockOf(SKU)).reserved, (await stockOf(SKU)).available], [2, 1, 1]);

  await say("919800000001", "Asha, " + INDORE);
  order = await Order.findOne();
  assert.equal(order.chatStep, "awaiting_payment_choice");
  assert.equal(order.shipTo.pincode, "452010");
  assert.equal(order.shipTo.stateCode, "23");
  assert.equal(order.shipTo.name, "Asha", "a name typed before the address becomes the delivery name");
  assert.ok(order.shipTo.address.startsWith("Flat 12"));
  assert.match(lastSentTo("919800000001"), /How would you like to pay/);

  await tap("919800000001", "pay_cod");
  order = await Order.findOne();
  assert.equal(order.status, "confirmed", `a first order of Rs 1,999 to a good address is low risk (score ${order.cod.score}: ${order.cod.reasons.join("; ")})`);
  assert.equal(order.cod.band, "low");
  assert.equal(order.stockState, "committed");
  const stock = await stockOf(SKU);
  assert.deepEqual([stock.onHand, stock.reserved, stock.available], [1, 0, 1]);
  assert.equal(await StockMove.countDocuments({ kind: "sale" }), 1);

  const invoice = await Invoice.findOne({ orderId: order._id });
  assert.equal(invoice.number, `IN1/${financialYear(now()).replace("-", "").slice(2)}/00001`);
  assert.equal(invoice.interState, false);
  assert.equal(invoice.lines[0].rate, 5);
  assert.equal(invoice.totals.totalPaise, 199900);
  assert.equal(invoice.totals.taxablePaise + invoice.totals.cgstPaise + invoice.totals.sgstPaise, 199900);
  assert.equal(invoice.totals.igstPaise, 0);
  assert.equal(invoice.seller.gstin, "23ABCDE1234F1Z5");

  // The worker ran the intake for each message once: running it again changes nothing.
  for (const message of await Message.find({ direction: "in" })) await handlers["order.intake"]({ messageId: String(message._id) });
  assert.equal(await Order.countDocuments(), 1);
  assert.equal(await Invoice.countDocuments(), 1);
});

test("prepaid: a payment link is sent; Razorpay's paid webhook confirms once; another state gets IGST", async () => {
  await seed();
  await cart("919800000002");
  await say("919800000002", MUMBAI);
  await tap("919800000002", "pay_prepaid");
  let order = await Order.findOne();
  assert.equal(order.status, "awaiting_payment");
  assert.equal(order.payment.linkId, "plink_1");
  assert.equal(razorpay.requests[0].body.amount, 199900);
  assert.match(lastSentTo("919800000002"), /rzp\.test\/i\/1/);

  const paid = { event: "payment_link.paid", payload: { payment_link: { entity: { id: "plink_1" } } } };
  assert.equal(await postRazorpay(paid), 200);
  assert.equal(await postRazorpay(paid), 200, "a repeat delivery is accepted and ignored");
  await drain(handlers, { now });
  order = await Order.findOne();
  assert.equal(order.status, "confirmed");
  assert.equal(order.payment.status, "paid");
  assert.equal(await Invoice.countDocuments(), 1);
  const invoice = await Invoice.findOne();
  assert.equal(invoice.interState, true);
  assert.equal(invoice.placeOfSupply.stateCode, "27");
  assert.equal(invoice.totals.cgstPaise + invoice.totals.sgstPaise, 0);
  assert.equal(invoice.totals.taxablePaise + invoice.totals.igstPaise, 199900);

  // A badly signed webhook is refused.
  const raw = Buffer.from(JSON.stringify(paid));
  const refused = await fetch(`${baseUrl}/webhooks/razorpay`, { method: "POST", headers: { "x-razorpay-signature": "0".repeat(64) }, body: raw });
  assert.equal(refused.status, 401);
});

test("an unpaid cart gives its stock back when the hold runs out", async () => {
  await seed();
  await cart("919800000003");
  assert.equal((await stockOf(SKU)).available, 1);
  advance(31 * 60_000);
  await drain(handlers, { now });
  const order = await Order.findOne();
  assert.equal(order.status, "cancelled");
  assert.equal(order.stockState, "released");
  assert.equal((await stockOf(SKU)).available, 2);
  assert.equal((await stockOf(SKU)).reserved, 0);
});

test("the last piece is never sold twice: the second cart hears it is sold out", async () => {
  await seed({ pieces: 1 });
  await cart("919800000004");
  await cart("919800000005");
  assert.equal(await Order.countDocuments(), 1);
  assert.match(lastSentTo("919800000005"), /sold out/);
  const stock = await stockOf(SKU);
  assert.deepEqual([stock.onHand, stock.reserved, stock.available], [1, 1, 0]);

  // Two holds racing in two transactions: exactly one wins.
  await Order.deleteMany({});
  await StockLevel.updateOne({ _id: stock._id }, { $set: { reserved: 0, available: 1 } });
  const results = await Promise.allSettled([cart("919800000006"), cart("919800000007")]);
  assert.ok(results.every((result) => result.status === "fulfilled"));
  assert.equal(await Order.countDocuments(), 1);
  assert.equal((await stockOf(SKU)).available, 0);
});

test("staff cancel a confirmed order: stock goes back and a credit note is issued", async () => {
  await seed();
  await cart("919800000008");
  await say("919800000008", INDORE);
  await tap("919800000008", "pay_cod");
  const api = await ownerApi();
  const order = await Order.findOne();
  assert.equal(order.status, "confirmed");

  const cancelled = await api(`/api/orders/${order._id}/cancel`, { method: "POST", body: { reason: "customer called to cancel" } });
  assert.equal(cancelled.status, 200, JSON.stringify(cancelled.data));
  assert.equal(cancelled.data.order.status, "cancelled");
  assert.equal((await stockOf(SKU)).onHand, 2);
  const note = await Invoice.findOne({ kind: "credit_note" });
  assert.ok(note, "a credit note is issued against the invoice");
  assert.match(note.number, /^IN1C\//);
  assert.equal(note.totals.totalPaise, 199900);

  const again = await api(`/api/orders/${order._id}/cancel`, { method: "POST", body: { reason: "twice" } });
  assert.equal(again.status, 409);
  assert.equal(await Invoice.countDocuments({ kind: "credit_note" }), 1);
});

test("store counter sale: stock leaves the store, an invoice in the store's series", async () => {
  await seed();
  const api = await ownerApi();
  const sale = await api("/api/store-sales", { method: "POST", body: { location: "ST1", items: [{ skuCode: SKU, qty: 1 }], method: "store_upi" } });
  assert.equal(sale.status, 201, JSON.stringify(sale.data));
  assert.equal(sale.data.order.status, "delivered");
  assert.match(sale.data.invoice.number, /^ST1\//);
  assert.equal(sale.data.invoice.interState, false);
  assert.equal((await stockOf(SKU, "ST1")).onHand, 0);
  assert.equal((await stockOf(SKU, "ONL")).onHand, 2, "online stock is untouched");

  const none = await api("/api/store-sales", { method: "POST", body: { location: "ST1", items: [{ skuCode: SKU, qty: 1 }], method: "store_cash" } });
  assert.equal(none.status, 409);
  assert.equal(none.data.error, "OUT_OF_STOCK");
});

test("catalogue API: a style with sizes, stock received, cannot go live without a photo", async () => {
  await seed();
  const api = await ownerApi();
  const created = await api("/api/styles", { method: "POST", body: { code: "TOP-014", name: "Satin wrap top", category: "tops", price: 1299, sizes: ["l", "s", "m"] } });
  assert.equal(created.status, 201, JSON.stringify(created.data));
  assert.deepEqual(created.data.skus.map((sku) => sku.code), ["TOP-014-S", "TOP-014-M", "TOP-014-L"]);
  assert.equal(created.data.skus[0].pricePaise, 129900);

  const live = await api(`/api/styles/${created.data.style._id}`, { method: "PATCH", body: { status: "live" } });
  assert.equal(live.status, 409);
  const withPhoto = await api(`/api/styles/${created.data.style._id}`, { method: "PATCH", body: { status: "live", images: ["https://img.test/top.jpg"], price: 1399 } });
  assert.equal(withPhoto.status, 200, JSON.stringify(withPhoto.data));
  assert.equal((await Sku.findOne({ code: "TOP-014-M" })).pricePaise, 139900);

  const received = await api("/api/stock/receive", { method: "POST", body: { location: "ONL", items: [{ skuCode: "top-014-m", qty: 4 }] } });
  assert.equal(received.status, 200, JSON.stringify(received.data));
  assert.equal((await stockOf("TOP-014-M")).onHand, 4);

  const counted = await api("/api/stock/count", { method: "POST", body: { location: "ONL", skuCode: "TOP-014-M", counted: 3, note: "one piece damaged" } });
  assert.equal(counted.status, 200, JSON.stringify(counted.data));
  assert.equal((await stockOf("TOP-014-M")).onHand, 3);

  const duplicate = await api("/api/styles", { method: "POST", body: { code: "TOP-014", name: "Again", category: "tops", price: 999, sizes: ["M"] } });
  assert.equal(duplicate.status, 409);
});
