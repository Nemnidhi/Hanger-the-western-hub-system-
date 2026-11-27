import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import mongoose from "mongoose";
import { createApp } from "../src/app.js";
import { createHandlers } from "../src/handlers.js";
import { drain } from "../src/jobs/runner.js";
import { withTransaction } from "../src/db.js";
import { createStyle } from "../src/commerce/catalog.js";
import { nextSendingTime } from "../src/commerce/broadcasts.js";
import { maybeAskOffers } from "../src/commerce/consent.js";
import { createSession } from "../src/auth/sessions.js";
import { hashPassword } from "../src/security/password.js";
import { Broadcast, Contact, Conversation, Location, Message, Order, Settings, Template, User } from "../src/models/index.js";
import { apiClient, clearCollections, connectTestDb, inboundButtonPayload, inboundTextPayload, listen, sign, startFakeMeta, testConfig } from "./helpers.js";

// WhatsApp broadcasts: only to customers who agreed, filtered by what they bought and their size, one
// offer per customer per gap, never twice, STOP and START in the chat, and the offers question.

const DAY = 86_400_000;
let meta;
let config;
let baseUrl;
let server;
let handlers;
let offsetMs = 0;
const now = () => new Date(Date.now() + offsetMs);
let counter = 0;

const BODY = "Hi {{1}}, new {{2}} just landed at The Hanger. Your size {{3}} is in.";

async function seed() {
  const tenantId = config.TENANT_ID;
  await Settings.create({ tenantId, brandName: "The Hanger", onlineLocationCode: "ONL", broadcasts: { minGapDays: 3, dailyLimit: 1000, sendFromHour: 0, sendUntilHour: 24 } });
  const [store] = await Location.create([{ tenantId, code: "MGR", name: "MG Road store", kind: "store", address: "Indore", pincode: "452001", invoicePrefix: "ST1" }]);
  await withTransaction(async (session) => {
    await createStyle({ tenantId, data: { code: "DRS-001", name: "Linen midi dress", category: "dresses", pricePaise: 199900 }, sizes: ["M"], session });
    await createStyle({ tenantId, data: { code: "TOP-001", name: "Poplin shirt", category: "tops", pricePaise: 139900 }, sizes: ["L"], session });
  });
  await Template.create([
    { tenantId, name: "new_drop", language: "en", category: "MARKETING", status: "APPROVED", bodyText: BODY, paramCount: 3, components: [{ type: "BODY", text: BODY }] },
    { tenantId, name: "order_update", language: "en", category: "UTILITY", status: "APPROVED", bodyText: "Order {{1}}", paramCount: 1, components: [{ type: "BODY", text: "Order {{1}}" }] },
  ]);
  const yes = (at = new Date()) => ({ given: true, at, source: "store:test", askedAt: at });
  const [asha, bela] = await Contact.create([
    { tenantId, waId: "919800000001", name: "Asha Verma", consents: { offers: yes() }, fit: { usualSize: "M" }, lastAddress: { pincode: "452010" } },
    { tenantId, waId: "919800000002", profileName: "Bela", consents: { offers: yes() }, fit: { usualSize: "L" }, lastAddress: { pincode: "400001" } },
    { tenantId, waId: "919800000003", name: "Chitra", consents: { offers: { given: false } } },
  ]);
  const dia = await Contact.create({ tenantId, waId: "919800000004", name: "Dia", consents: { offers: yes() } });
  // Dia had picks yesterday: held back by the 3-day gap.
  const chat = await Conversation.create({ tenantId, contactId: dia._id, status: "open" });
  await Message.create({ tenantId, conversationId: chat._id, contactId: dia._id, direction: "out", type: "template", status: "delivered", purpose: "picks", createdAt: new Date(Date.now() - DAY) });
  // Asha bought a dress in the store 20 days ago (matched by her phone number).
  await Order.create({
    tenantId, number: 901, channel: "store", customer: { name: "Asha", phone: "9800000001" }, locationId: store._id, status: "delivered", stockState: "committed", createdAt: new Date(Date.now() - 20 * DAY),
    totals: { itemsPaise: 199900, totalPaise: 199900 },
    lines: [{ skuId: new mongoose.Types.ObjectId(), skuCode: "DRS-001-M", styleCode: "DRS-001", name: "Linen midi dress", size: "M", qty: 1, unitPaise: 199900, gstRate: 5, hsn: "6204" }],
  });
  return { asha, bela, dia };
}

async function login(role) {
  const user = await User.create({ tenantId: config.TENANT_ID, name: role, email: `${role}@hanger.test`, role, status: "active", passwordHash: await hashPassword("Owner-password-1"), mustChangePassword: false, twoFactor: { enabled: role !== "staff" } });
  const api = apiClient(baseUrl);
  api.setCookie(`hh_session=${await createSession({ user, req: { ip: "", get: () => "" }, twoFactorPending: false })}`);
  return api;
}

async function customer(payload) {
  const raw = Buffer.from(JSON.stringify(payload));
  const response = await fetch(`${baseUrl}/webhooks/whatsapp`, { method: "POST", headers: { "content-type": "application/json", "x-hub-signature-256": sign(raw, config.WHATSAPP_APP_SECRET) }, body: raw });
  assert.equal(response.status, 200);
  await drain(handlers, { now });
}

test.before(async () => {
  await connectTestDb();
  meta = await startFakeMeta();
  config = testConfig({ META_GRAPH_BASE: meta.baseUrl });
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

test("sending hours are India hours", () => {
  const hours = { sendFromHour: 10, sendUntilHour: 20 };
  const at = (iso) => nextSendingTime(new Date(iso), hours).toISOString();
  assert.equal(at("2026-11-27T06:00:00Z"), "2026-11-27T06:00:00.000Z", "11:30 in India: now");
  assert.equal(at("2026-11-27T02:00:00Z"), "2026-11-27T04:30:00.000Z", "07:30 in India: at 10:00");
  assert.equal(at("2026-11-27T16:00:00Z"), "2026-11-28T04:30:00.000Z", "21:30 in India: 10:00 tomorrow");
});

test("audience: only customers who agreed, the filters, and the gap between offers", async () => {
  await seed();
  const api = await login("owner");
  const reach = async (audience) => (await api("/api/broadcasts/audience", { method: "POST", body: { audience } })).data;
  const everyone = await reach({});
  assert.deepEqual(everyone.counts, { customers: 4, agreed: 3, matching: 3, heldBack: 1, reach: 2 });
  assert.equal((await reach({ categories: ["Dresses"] })).counts.reach, 1, "only Asha bought a dress");
  assert.deepEqual((await reach({ sizes: ["l"] })).sample, ["Bela"]);
  assert.equal((await reach({ neverBought: true })).counts.reach, 1);
  assert.equal((await reach({ notBoughtForDays: 30 })).counts.reach, 0, "Asha bought 20 days ago");
  assert.equal((await reach({ lastBoughtWithinDays: 30, minSpend: 1500 })).counts.reach, 1);
  assert.equal((await reach({ pincodePrefixes: ["452"] })).counts.reach, 1);

  const staff = await login("staff");
  assert.equal((await staff("/api/broadcasts/audience", { method: "POST", body: {} })).status, 403);
});

test("a broadcast goes once to each customer with her name and size, and STOP is respected", async () => {
  const { asha, bela } = await seed();
  const api = await login("owner");
  const bad = await api("/api/broadcasts", { method: "POST", body: { name: "Order", template: { name: "order_update", language: "en" }, params: ["1"] } });
  assert.equal(bad.status, 409);
  assert.equal(bad.data.error, "NOT_MARKETING");
  const short = await api("/api/broadcasts", { method: "POST", body: { name: "Drop", template: { name: "new_drop", language: "en" }, params: ["{first_name}"] } });
  assert.equal(short.status, 400);

  const created = await api("/api/broadcasts", { method: "POST", body: { name: "Winter drop", template: { name: "new_drop", language: "en" }, params: ["{first_name}", "winter jackets", "{size}"] } });
  assert.equal(created.status, 201, JSON.stringify(created.data));
  const id = created.data.broadcast._id;
  const detail = await api(`/api/broadcasts/${id}`);
  assert.equal(detail.data.preview, "Hi Priya, new winter jackets just landed at The Hanger. Your size M is in.");

  // Bela says STOP before it goes: she is left out.
  await customer(inboundTextPayload({ from: bela.waId, id: `wamid.in.${(counter += 1)}`, text: "STOP" }));
  assert.equal((await Contact.findById(bela._id)).consents.offers.given, false);
  assert.match(meta.requests.at(-1).body.text.body, /no more offers/);

  const sent = await api(`/api/broadcasts/${id}/send`, { method: "POST", body: {} });
  assert.equal(sent.status, 200, JSON.stringify(sent.data));
  await drain(handlers, { now });
  offsetMs += 31_000;
  await drain(handlers, { now });

  const templates = meta.requests.filter((request) => request.body?.type === "template");
  assert.equal(templates.length, 1, "Asha only (Bela stopped, Chitra never agreed, Dia had picks yesterday)");
  assert.equal(templates[0].body.to, asha.waId);
  assert.deepEqual(templates[0].body.template.components[0].parameters.map((part) => part.text), ["Asha", "winter jackets", "M"]);
  const broadcast = await Broadcast.findById(id);
  assert.equal(broadcast.status, "done");
  assert.equal(broadcast.counts.audience, 1);
  assert.equal(await Message.countDocuments({ offerId: broadcast._id }), 1);

  assert.equal((await api(`/api/broadcasts/${id}/send`, { method: "POST", body: {} })).status, 409, "a broadcast is sent once");
  const list = await api("/api/broadcasts");
  assert.equal(list.data.broadcasts[0].results.messages.sent + list.data.broadcasts[0].results.messages.queued, 1);
  assert.equal(list.data.broadcasts[0].recipients, undefined, "the recipient list stays on the server");

  // She replies START later: offers again.
  await customer(inboundTextPayload({ from: bela.waId, id: `wamid.in.${(counter += 1)}`, text: "start" }));
  assert.equal((await Contact.findById(bela._id)).consents.offers.given, true);
});

test("the offers question is asked once, only inside the chat window, and its buttons record the answer", async () => {
  await seed();
  const tenantId = config.TENANT_ID;
  const fresh = await Contact.create({ tenantId, waId: "919800000009", name: "Esha" });
  // Never messaged: no window, no question.
  assert.equal(await withTransaction((session) => maybeAskOffers({ tenantId, contact: fresh, brandName: "The Hanger", session })), null);
  await customer(inboundTextPayload({ from: fresh.waId, id: `wamid.in.${(counter += 1)}`, text: "Hi" }));
  const asked = await withTransaction(async (session) => maybeAskOffers({ tenantId, contact: await Contact.findById(fresh._id).session(session), brandName: "The Hanger", session }));
  assert.ok(asked, "asked inside the window");
  assert.equal(await withTransaction(async (session) => maybeAskOffers({ tenantId, contact: await Contact.findById(fresh._id).session(session), brandName: "The Hanger", session })), null, "asked only once");
  await customer(inboundButtonPayload({ from: fresh.waId, id: `wamid.in.${(counter += 1)}`, buttonId: "offers_yes", title: "Yes, tell me" }));
  const contact = await Contact.findById(fresh._id);
  assert.equal(contact.consents.offers.given, true);
  assert.equal(contact.consents.offers.source, "whatsapp:button");
});
