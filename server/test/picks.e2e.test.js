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
import { schedulePicksFollowUp } from "../src/commerce/picksSend.js";
import { createSession } from "../src/auth/sessions.js";
import { hashPassword } from "../src/security/password.js";
import { Contact, Conversation, Job, Location, Message, Order, Settings, User } from "../src/models/index.js";
import { apiClient, clearCollections, connectTestDb, listen, startFakeMeta, testConfig } from "./helpers.js";

// Outfit picks through the API: the trial room asks what to bring next from the store floor, and
// staff send the picks to her WhatsApp (a catalogue product list inside 24 hours, a template after).

const PHONE = "9826012345";
const WA_ID = "919826012345";
let meta;
let config;
let baseUrl;
let server;
let handlers;
let offsetMs = 0;
const now = () => new Date(Date.now() + offsetMs);
const DAY = 86_400_000;

const STYLES = [
  { code: "TOP-040", name: "Poplin shirt", category: "tops", price: 139900, colour: "white", occasion: ["work"], pairsWith: ["BTM-012", "JKT-010"], sizes: { S: 2, M: 3, L: 2 }, days: 6 },
  { code: "BTM-012", name: "Straight trousers", category: "trousers", price: 199900, colour: "taupe", occasion: ["work"], pairsWith: ["TOP-040"], sizes: { 28: 2, 30: 2, 32: 1 }, days: 60 },
  { code: "JKT-010", name: "Linen blazer", category: "jackets", price: 349900, colour: "ivory", occasion: ["work", "date"], pairsWith: ["BTM-012"], sizes: { S: 1, M: 2, L: 1 }, days: 9 },
  { code: "JKT-015", name: "Soft cardigan", category: "cardigans", price: 189900, colour: "dusty rose", occasion: ["brunch"], sizes: { S: 2, M: 0, L: 2 }, days: 30 },
  { code: "SKT-008", name: "Pleated midi skirt", category: "skirts", price: 149900, colour: "black", occasion: ["work", "date"], sizes: { S: 2, M: 4, L: 1 }, days: 50 },
  { code: "DRS-002", name: "Satin slip dress", category: "dresses", price: 249900, colour: "wine", occasion: ["date"], sizing: "runs_small", sizes: { S: 1, M: 2, L: 1 }, days: 7 },
];

async function seed() {
  await Settings.create({ tenantId: config.TENANT_ID, brandName: "The Hanger", onlineLocationCode: "ONL" });
  const [store, online] = await Location.create([
    { tenantId: config.TENANT_ID, code: "MGR", name: "MG Road store", kind: "store", address: "Indore", pincode: "452001", invoicePrefix: "ST1" },
    { tenantId: config.TENANT_ID, code: "ONL", name: "Online stock room", kind: "warehouse", address: "Indore", pincode: "452001", invoicePrefix: "IN1" },
  ]);
  await withTransaction(async (session) => {
    for (const row of STYLES) {
      const { style, skus } = await createStyle({
        tenantId: config.TENANT_ID,
        data: { code: row.code, name: row.name, category: row.category, pricePaise: row.price, attributes: { colour: row.colour, occasion: row.occasion }, pairsWith: row.pairsWith || [], sizing: row.sizing || "true" },
        sizes: Object.keys(row.sizes),
        session,
      });
      style.status = "live";
      style.liveAt = new Date(Date.now() - row.days * DAY);
      await style.save({ session });
      const items = skus.map((sku) => ({ sku, qty: row.sizes[sku.size] })).filter((item) => item.qty > 0);
      if (items.length) await receiveStock({ tenantId: config.TENANT_ID, locationId: store._id, items, by: "test", session });
      // The online room has one of each, so the two locations differ.
      await receiveStock({ tenantId: config.TENANT_ID, locationId: online._id, items: skus.map((sku) => ({ sku, qty: 1 })), by: "test", session });
    }
  });
  return { store, online };
}

async function ownerApi() {
  const owner = await User.create({ tenantId: config.TENANT_ID, name: "Owner", email: "owner@hanger.test", role: "owner", status: "active", passwordHash: await hashPassword("Owner-password-1"), mustChangePassword: false, twoFactor: { enabled: true } });
  const api = apiClient(baseUrl);
  api.setCookie(`hh_session=${await createSession({ user: owner, req: { ip: "", get: () => "" }, twoFactorPending: false })}`);
  return api;
}

/** A past store sale for her: a satin wrap top she kept, in M, so her size and spend are known. */
async function pastStoreSale(store) {
  await Order.create({
    tenantId: config.TENANT_ID, number: 900, channel: "store", customer: { name: "Riya", phone: PHONE }, locationId: store._id, status: "delivered", stockState: "committed",
    lines: [{ skuId: new mongoose.Types.ObjectId(), skuCode: "TOP-014-M", styleCode: "TOP-014", name: "Satin wrap top", size: "M", qty: 1, unitPaise: 129900, gstRate: 5, hsn: "6206" },
      { skuId: new mongoose.Types.ObjectId(), skuCode: "JNS-030-30", styleCode: "JNS-030", name: "Wide-leg jeans", size: "30", qty: 1, unitPaise: 179900, gstRate: 5, hsn: "6204" }],
  });
}

test.before(async () => {
  await connectTestDb();
  meta = await startFakeMeta();
  config = testConfig({ META_GRAPH_BASE: meta.baseUrl, META_CATALOG_ID: "999" });
  handlers = createHandlers({ config, now });
  server = http.createServer(createApp({ config, logger: { error: (info, message) => console.error(message, info?.err?.stack || info?.err?.message), warn() {}, info() {} } }));
  baseUrl = await listen(server);
});

test.beforeEach(async () => {
  await clearCollections();
  meta.requests.length = 0;
  offsetMs = 0;
});

test.after(async () => {
  server?.close();
  await meta.close();
  await mongoose.disconnect();
});

test("trial room: picks come from the store floor in her size, using her history", async () => {
  const { store } = await seed();
  await pastStoreSale(store);
  const api = await ownerApi();

  const picks = await api("/api/picks", { method: "POST", body: { pieces: ["TOP-040-M"], phone: PHONE, location: "MGR" } });
  assert.equal(picks.status, 200, JSON.stringify(picks.data));
  const { customer, complete, swap, trying } = picks.data;
  assert.deepEqual(trying.map((piece) => piece.styleCode), ["TOP-040"]);
  assert.equal(customer.letter, "M");
  assert.equal(customer.waist, "30");
  assert.deepEqual(customer.band, [110000, 210000]); // to the nearest Rs 100
  // A shirt on its own: a bottom and a layer complete it. The trousers come in her waist, 30.
  const trousers = complete.find((pick) => pick.styleCode === "BTM-012");
  assert.equal(trousers.size, "30");
  assert.equal(trousers.skuCode, "BTM-012-30");
  assert.equal(trousers.left, 2);
  assert.equal(trousers.parts.pair, 1);
  // The cardigan has no M on the floor: offered in the nearest size, and scored lower for it.
  const cardigan = complete.find((pick) => pick.styleCode === "JKT-015");
  assert.notEqual(cardigan.size, "M");
  assert.match(cardigan.why.size, /M is sold out/);
  assert.ok(complete.find((pick) => pick.styleCode === "JKT-010").score > cardigan.score);
  // No dress is offered for a shirt, and nothing is a swap until she has a bottom on.
  assert.ok(!complete.concat(swap).some((pick) => pick.styleCode === "DRS-002"));

  // In the online stock room there is only one of each: the stock part changes.
  const online = await api("/api/picks", { method: "POST", body: { pieces: ["TOP-040"], phone: PHONE } });
  assert.equal(online.data.location.code, "ONL");
  assert.equal(online.data.complete.find((pick) => pick.styleCode === "BTM-012").left, 1);

  // The owner's weights reach the picks.
  const changed = await api("/api/settings", { method: "PATCH", body: { picks: { weights: { size: 30, pair: 0, colour: 15, occasion: 15, taste: 10, push: 40 } } } });
  assert.equal(changed.status, 200, JSON.stringify(changed.data));
  const after = await api("/api/picks", { method: "POST", body: { pieces: ["TOP-040"], phone: PHONE, location: "MGR" } });
  assert.equal(after.data.weights.push, 40);
  assert.equal(after.data.weights.pair, 0);

  const unknown = await api("/api/picks", { method: "POST", body: { pieces: ["NOPE-1"], location: "MGR" } });
  assert.equal(unknown.status, 404);
  assert.match(unknown.data.message || unknown.data.error, /NOPE-1/);
});

test("sending picks: consent first, a product list inside 24 hours, a template outside, nothing without one", async () => {
  await seed();
  const api = await ownerApi();
  const body = { pieces: ["TOP-040"], phone: PHONE, location: "MGR", size: "M", waist: "30" };

  const noConsent = await api("/api/picks/send", { method: "POST", body });
  assert.equal(noConsent.status, 409);
  assert.match(noConsent.data.message || noConsent.data.error, /agreed/);

  // She agrees in the store, but has never messaged the shop: WhatsApp needs a template.
  const noTemplate = await api("/api/picks/send", { method: "POST", body: { ...body, consentNow: true } });
  assert.equal(noTemplate.status, 409);
  assert.match(noTemplate.data.message || noTemplate.data.error, /template/);
  // That request rolled back, consent included: she is asked again next time.
  assert.equal((await Contact.findOne({ waId: WA_ID }))?.consents?.offers?.given ?? false, false);

  await api("/api/settings", { method: "PATCH", body: { picks: { template: { name: "outfit_picks", language: "en" } } } });
  const viaTemplate = await api("/api/picks/send", { method: "POST", body: { ...body, consentNow: true } });
  assert.equal(viaTemplate.status, 201, JSON.stringify(viaTemplate.data));
  assert.equal(viaTemplate.data.via, "template");
  assert.equal(viaTemplate.data.picks.length, 3);
  const contact = await Contact.findOne({ waId: WA_ID });
  assert.equal(contact.consents.offers.given, true);
  assert.match(contact.consents.offers.source, /^store:/);
  await drain(handlers, { now });
  const sentTemplate = meta.requests.find((request) => request.body?.type === "template");
  assert.equal(sentTemplate.body.template.name, "outfit_picks");
  assert.equal(sentTemplate.body.to, WA_ID);

  // Once she has messaged the shop, picks go as a product list from the catalogue, in her sizes.
  await Conversation.updateOne({ contactId: contact._id }, { $set: { lastInboundAt: new Date() } });
  const chosen = await api("/api/picks/send", { method: "POST", body: { ...body, styleCodes: ["BTM-012", "JKT-010"] } });
  assert.equal(chosen.status, 201, JSON.stringify(chosen.data));
  assert.equal(chosen.data.via, "products");
  await drain(handlers, { now });
  const list = meta.requests.find((request) => request.body?.interactive?.type === "product_list");
  assert.equal(list.body.interactive.action.catalog_id, "999");
  assert.deepEqual(list.body.interactive.action.sections[0].product_items.map((item) => item.product_retailer_id), ["BTM-012-30", "JKT-010-M"]);
  const saved = await Message.findOne({ type: "products" });
  assert.equal(saved.purpose, "picks");
  assert.equal(saved.status, "sent");
});

test("automatic picks after a website look: only when switched on, agreed, and not too soon", async () => {
  await seed();
  const api = await ownerApi();
  assert.equal(await schedulePicksFollowUp({ tenantId: config.TENANT_ID, phone: PHONE, pieces: ["TOP-040"] }), null);

  await api("/api/settings", { method: "PATCH", body: { picks: { autoSend: true, autoSendDelayMinutes: 60, minGapDays: 7 } } });
  const job = await schedulePicksFollowUp({ tenantId: config.TENANT_ID, phone: PHONE, pieces: ["TOP-040"], now: now() });
  assert.ok(job.runAt.getTime() - Date.now() > 59 * 60_000);
  // Not agreed: the job runs and sends nothing.
  offsetMs = 61 * 60_000;
  await drain(handlers, { now });
  assert.equal(await Message.countDocuments({ purpose: "picks" }), 0);

  const contact = await Contact.create({ tenantId: config.TENANT_ID, waId: WA_ID, name: "Riya Jain", consents: { offers: { given: true, at: new Date(), source: "checkout" } } });
  await Conversation.create({ tenantId: config.TENANT_ID, contactId: contact._id, lastInboundAt: now() });
  await Job.deleteMany({});
  await schedulePicksFollowUp({ tenantId: config.TENANT_ID, phone: PHONE, pieces: ["TOP-040"], now: now() });
  offsetMs += 61 * 60_000;
  await drain(handlers, { now });
  const sent = await Message.findOne({ purpose: "picks" });
  assert.equal(sent.type, "products");
  assert.match(sent.text, /^Hi Riya!/);

  // A second look the next day: within the 7-day gap, nothing more goes.
  offsetMs += DAY;
  await schedulePicksFollowUp({ tenantId: config.TENANT_ID, phone: PHONE, pieces: ["DRS-002"], now: now() });
  offsetMs += 61 * 60_000;
  await drain(handlers, { now });
  assert.equal(await Message.countDocuments({ purpose: "picks" }), 1);
});

test("staff save her sizes from the trial room; the next picks use them", async () => {
  await seed();
  const api = await ownerApi();
  const saved = await api("/api/customers/sizes", { method: "POST", body: { phone: PHONE, usualSize: "l", waist: "32" } });
  assert.equal(saved.status, 200, JSON.stringify(saved.data));
  assert.equal(saved.data.fit.usualSize, "L");
  const picks = await api("/api/picks", { method: "POST", body: { pieces: ["TOP-040"], phone: PHONE, location: "MGR" } });
  assert.equal(picks.data.customer.letter, "L");
  assert.equal(picks.data.complete.find((pick) => pick.styleCode === "BTM-012").size, "32");
});
