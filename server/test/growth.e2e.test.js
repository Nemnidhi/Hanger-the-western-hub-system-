import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import mongoose from "mongoose";
import { createApp } from "../src/app.js";
import { createServices } from "../src/services.js";
import { createHandlers } from "../src/handlers.js";
import { drain } from "../src/jobs/runner.js";
import { withTransaction } from "../src/db.js";
import { hashPassword } from "../src/security/password.js";
import { createSession } from "../src/auth/sessions.js";
import { createStyle } from "../src/commerce/catalog.js";
import { receiveStock } from "../src/commerce/stock.js";
import { storeSale } from "../src/commerce/orders.js";
import { purchaseEvent } from "../src/ads/meta.js";
import { matchRule } from "../src/instagram/instagram.js";
import { Contact, Conversation, InstagramComment, InstagramMessage, InstagramThread, Location, Message, Order, Settings, User } from "../src/models/index.js";
import { apiClient, clearCollections, connectTestDb, inboundTextPayload, listen, sign, startFakeMeta, testConfig } from "./helpers.js";

// The later modules: the WhatsApp stylist, purchases to Meta's Conversions API with the ad they came
// from, the Ads page (Meta's spend beside our own sales), and Instagram DMs and comment replies.

const IG = "17841400000000001";
let meta;
let config;
let server;
let baseUrl;
let handlers;
let staff;
let store;
const later = () => new Date(Date.now() + 5 * 60_000);

async function seed() {
  const tenantId = config.TENANT_ID;
  await Settings.create({ tenantId, brandName: "The Hanger", legalName: "The Hanger Western Hub", gstin: "23ABCDE1234F1Z5", stateCode: "23", onlineLocationCode: "ONL", stylist: { enabled: true } });
  const [online, shop] = await Location.create([
    { tenantId, code: "ONL", name: "Online stock room", kind: "warehouse", address: "Indore", pincode: "452001", invoicePrefix: "IN1" },
    { tenantId, code: "ST1", name: "Store", kind: "store", address: "Indore", pincode: "452001", invoicePrefix: "ST1" },
  ]);
  store = shop;
  await withTransaction(async (session) => {
    const make = async (data, sizes) => {
      const made = await createStyle({ tenantId, data: { images: [`https://img.test/${data.code}.jpg`], ...data }, sizes, session });
      made.style.status = "live";
      made.style.liveAt = new Date();
      await made.style.save({ session });
      return made;
    };
    const dress = await make({ code: "DRS-001", name: "Linen midi dress", category: "dresses", pricePaise: 199900, attributes: { colour: "sage green", occasion: ["brunch"] } }, ["S", "M", "L"]);
    const jacket = await make({ code: "JKT-001", name: "Cropped denim jacket", category: "jackets", pricePaise: 249900, attributes: { colour: "blue", occasion: ["brunch"] } }, ["S", "M"]);
    await make({ code: "TOP-001", name: "Satin cami", category: "tops", pricePaise: 89900, attributes: { colour: "black" } }, ["M"]);
    await receiveStock({ tenantId, locationId: online._id, items: [{ sku: dress.skus[0], qty: 3 }, { sku: dress.skus[1], qty: 2 }, { sku: jacket.skus[1], qty: 2 }], by: "test", session });
    await receiveStock({ tenantId, locationId: shop._id, items: [{ sku: dress.skus[1], qty: 2 }], by: "test", session });
  });
}

async function whatsappIn(payload) {
  const raw = JSON.stringify(payload);
  const response = await fetch(`${baseUrl}/webhooks/whatsapp`, { method: "POST", headers: { "content-type": "application/json", "x-hub-signature-256": sign(raw, config.WHATSAPP_APP_SECRET) }, body: raw });
  assert.equal(response.status, 200);
  await drain(handlers);
}

async function instagramIn(body) {
  const raw = JSON.stringify(body);
  const response = await fetch(`${baseUrl}/webhooks/instagram`, { method: "POST", headers: { "content-type": "application/json", "x-hub-signature-256": sign(raw, config.WHATSAPP_APP_SECRET) }, body: raw });
  assert.equal(response.status, 200);
  await drain(handlers, { now: later });
}

test.before(async () => {
  await connectTestDb();
  meta = await startFakeMeta();
  config = testConfig({
    META_GRAPH_BASE: meta.baseUrl,
    META_CATALOG_ID: "555000111",
    STYLIST_STAND_IN: true,
    SHOP_CODE_STAND_IN: true,
    META_PIXEL_ID: "112233445566",
    META_AD_ACCOUNT_ID: "998877",
    META_ADS_TOKEN: "test-ads-token-0123456789",
    INSTAGRAM_ACCOUNT_ID: IG,
    INSTAGRAM_ACCESS_TOKEN: "test-instagram-token-0123456789",
    INSTAGRAM_GRAPH_BASE: meta.baseUrl,
  });
  handlers = createHandlers({ config });
  server = http.createServer(createApp({ config, services: createServices(config), logger: { error() {}, warn() {}, info() {} } }));
  baseUrl = await listen(server);
});
test.beforeEach(async () => {
  await clearCollections();
  meta.requests.length = 0;
  const owner = await User.create({ tenantId: config.TENANT_ID, name: "Owner", email: "owner@hanger.test", role: "owner", status: "active", passwordHash: await hashPassword("Owner-password-1"), mustChangePassword: false, twoFactor: { enabled: true } });
  staff = apiClient(baseUrl);
  staff.setCookie(`hh_session=${await createSession({ user: owner, req: { ip: "", get: () => "" }, twoFactorPending: false })}`);
});
test.after(async () => {
  server.close();
  await meta.close();
  await mongoose.disconnect();
});

test("the stylist answers a question with pieces in stock, hands a return to staff, and keeps quiet after", async () => {
  await seed();
  const from = "919800000051";
  await whatsappIn(inboundTextPayload({ from, id: "wamid.sty.1", text: "Do you have a linen dress for a brunch?" }));
  const answer = await Message.findOne({ purpose: "stylist" });
  assert.ok(answer, "the stylist replied");
  assert.equal(answer.type, "products", "picks as a product list from the catalogue");
  assert.ok(answer.replyTo, "linked to her message");
  const ids = answer.data.products.sections[0].productRetailerIds;
  assert.ok(ids.includes("DRS-001-S") || ids.includes("DRS-001-M"), `in-stock size of the dress, got ${ids}`);
  assert.ok(!ids.some((id) => id.startsWith("TOP-001")), "nothing out of stock");
  const sent = meta.requests.find((request) => request.body?.interactive?.type === "product_list");
  assert.equal(sent.body.interactive.action.catalog_id, "555000111");

  await whatsappIn(inboundTextPayload({ from, id: "wamid.sty.2", text: "The dress I got is damaged, I want to return it" }));
  const conversation = await Conversation.findOne({});
  assert.ok(conversation.stylistOffUntil > new Date(), "handed over");
  assert.match(conversation.stylistNote, /complaint|return/);
  assert.equal(await Message.countDocuments({ purpose: "stylist" }), 2, "she is told a person will reply");

  await whatsappIn(inboundTextPayload({ from, id: "wamid.sty.3", text: "Also any jacket?" }));
  assert.equal(await Message.countDocuments({ purpose: "stylist" }), 2, "quiet while staff have the chat");

  // Staff turn it back on from the inbox; a staff reply then keeps it quiet for the pause.
  const patched = await staff(`/api/conversations/${conversation._id}`, { method: "PATCH", body: { stylist: "on" } });
  assert.equal(patched.status, 200, JSON.stringify(patched.data));
  assert.equal(patched.data.data.stylistOffUntil, null);
  const reply = await staff(`/api/conversations/${conversation._id}/messages`, { method: "POST", body: { text: "Sorry about that, sending a pickup." } });
  assert.equal(reply.status, 202, JSON.stringify(reply.data));
  await whatsappIn(inboundTextPayload({ from, id: "wamid.sty.4", text: "Any denim jacket in M?" }));
  assert.equal(await Message.countDocuments({ purpose: "stylist" }), 2, "staff replied a moment ago");

  // Turned off in Settings: no stylist jobs at all.
  await Settings.updateOne({}, { $set: { "stylist.enabled": false, "stylist.pauseMinutes": 0 } });
  await whatsappIn(inboundTextPayload({ from: "919800000052", id: "wamid.sty.5", text: "Denim jacket?" }));
  assert.equal(await Message.countDocuments({ purpose: "stylist" }), 2);
});

test("a confirmed website order goes to the Conversions API once, with hashed details and the ad click; store sales as physical_store", async () => {
  await seed();
  const shop = apiClient(baseUrl);
  const code = await shop("/api/shop/login/code", { method: "POST", body: { phone: "9800000061" } });
  await shop("/api/shop/login/verify", { method: "POST", body: { phone: "9800000061", code: code.data.devCode } });
  const placed = await shop("/api/shop/orders", {
    method: "POST",
    body: { items: [{ skuCode: "DRS-001-S", qty: 1 }], address: { name: "Asha Jain", address: "Flat 12, Shanti Apartment, Vijay Nagar, Indore", pincode: "452010" }, method: "cod", attribution: { source: "instagram", medium: "paid", campaign: "Diwali Edit", fbclid: "IwAR0abc", landedAt: new Date(Date.now() - 3600_000).toISOString() } },
  });
  assert.equal(placed.status, 201, JSON.stringify(placed.data));
  assert.equal(placed.data.order.status, "confirmed");
  const order = await Order.findById(placed.data.order._id);
  assert.equal(order.attribution.campaign, "Diwali Edit");
  assert.ok(order.attribution.userAgent, "kept for Meta");

  await drain(handlers, { now: later });
  const events = meta.requests.filter((request) => request.url === "/v24.0/112233445566/events");
  assert.equal(events.length, 1);
  const [event] = events[0].body.data;
  assert.equal(events[0].auth, "Bearer test-ads-token-0123456789");
  assert.equal(event.event_name, "Purchase");
  assert.equal(event.action_source, "website");
  assert.equal(event.event_id, `purchase-${order._id}`);
  assert.equal(event.custom_data.value, 1999);
  assert.equal(event.custom_data.currency, "INR");
  assert.match(event.user_data.ph[0], /^[0-9a-f]{64}$/, "phone hashed");
  assert.ok(!JSON.stringify(event).includes("9800000061"), "no plain phone");
  assert.match(event.user_data.fbc, /^fb\.1\.\d+\.IwAR0abc$/);
  assert.equal((await Order.findById(order._id)).metaEvent.status, "sent");
  await drain(handlers, { now: later });
  assert.equal(meta.requests.filter((request) => request.url.endsWith("/events")).length, 1, "once");

  await withTransaction((session) => storeSale({ tenantId: config.TENANT_ID, locationId: store._id, items: [{ skuCode: "DRS-001-M", qty: 1 }], method: "store_upi", customer: { phone: "9800000062", name: "Neha" }, by: "test", session }));
  await drain(handlers, { now: later });
  const storeEvent = meta.requests.filter((request) => request.url.endsWith("/events")).at(-1).body.data[0];
  assert.equal(storeEvent.action_source, "physical_store");

  // A WhatsApp order after a Click-to-WhatsApp ad carries the ad's click id.
  const contact = await Contact.create({ tenantId: config.TENANT_ID, waId: "919800000063", adReferral: { sourceId: "120000111", sourceType: "ad", headline: "New in: linen", ctwaClid: "ARclid", at: new Date() } });
  const ctwa = purchaseEvent({ order: { _id: "x", channel: "whatsapp", contactId: contact._id, customer: { phone: contact.waId }, shipTo: {}, totals: { totalPaise: 100 }, lines: [], attribution: { ctwaClid: "ARclid" }, createdAt: new Date() }, contact, config });
  assert.equal(ctwa.action_source, "business_messaging");
  assert.equal(ctwa.user_data.ctwa_clid, "ARclid");

  // Turned off: skipped, not sent.
  await Settings.updateOne({}, { $set: { "ads.sendPurchases": false } });
  await withTransaction((session) => storeSale({ tenantId: config.TENANT_ID, locationId: store._id, items: [{ skuCode: "DRS-001-M", qty: 1 }], method: "store_cash", by: "test", session }));
  await drain(handlers, { now: later });
  assert.equal(meta.requests.filter((request) => request.url.endsWith("/events")).length, 2);
  assert.equal(await Order.countDocuments({ "metaEvent.status": "skipped" }), 1);
});

test("the Ads page sets Meta's spend per campaign beside our own sales from it", async () => {
  await seed();
  meta.onGet("/v24.0/act_998877/insights", (req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({
      data: [
        { campaign_id: "c1", campaign_name: "Diwali Edit", ad_id: "a1", spend: "500.00", impressions: "20000", clicks: "400", actions: [{ action_type: "purchase", value: "2" }], action_values: [{ action_type: "purchase", value: "3998" }] },
        { campaign_id: "c2", campaign_name: "Click to WhatsApp", ad_id: "120000111", spend: "250.50", impressions: "9000", clicks: "120" },
      ],
    }));
  });
  const tenantId = config.TENANT_ID;
  const make = (number, totalPaise, attribution, channel = "website") =>
    Order.create({ tenantId, number, channel, customer: { phone: "919800000070" }, locationId: store._id, lines: [{ skuId: new mongoose.Types.ObjectId(), skuCode: "DRS-001-S", styleCode: "DRS-001", name: "Linen midi dress", size: "S", qty: 1, unitPaise: totalPaise, hsn: "6204", gstRate: 5 }], totals: { itemsPaise: totalPaise, totalPaise }, status: "confirmed", confirmedAt: new Date(), attribution });
  await make(901, 199900, { source: "instagram", medium: "paid", campaign: "diwali edit" });
  await make(902, 249900, { source: "meta", medium: "whatsapp ad", adId: "120000111", ctwaClid: "x" }, "whatsapp");
  await make(903, 89900, { source: "google", medium: "cpc", campaign: "brand" });
  await make(904, 99900, {});

  const summary = await staff("/api/ads/summary?days=7");
  assert.equal(summary.status, 200, JSON.stringify(summary.data));
  assert.equal(summary.data.connected, true);
  const [diwali, ctwa] = summary.data.campaigns;
  assert.equal(diwali.name, "Diwali Edit");
  assert.equal(diwali.spendPaise, 50000);
  assert.equal(diwali.orders, 1, "matched by name, any case");
  assert.equal(diwali.roas, 4);
  assert.equal(diwali.metaPurchases, 2);
  assert.equal(ctwa.orders, 1, "the WhatsApp ad, matched by ad id");
  assert.deepEqual(summary.data.others.map((row) => row.source).sort(), ["direct", "google"]);
  assert.equal(summary.data.totals.salesPaise, 199900 + 249900 + 89900 + 99900);
  assert.equal((await staff("/api/ads/summary?days=3")).status, 400);
});

test("Instagram: a DM opens a thread, staff reply inside 24 hours, a comment with a keyword gets a private and a public reply", async () => {
  await seed();
  meta.onGet("/v24.0/igsid-501", (req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ username: "asha.styles", name: "Asha" }));
  });
  const dm = { object: "instagram", entry: [{ id: IG, time: Date.now(), messaging: [{ sender: { id: "igsid-501" }, recipient: { id: IG }, timestamp: Date.now(), message: { mid: "ig.mid.1", text: "Is the linen dress available in M?" } }] }] };
  await instagramIn(dm);
  await instagramIn(dm);
  const thread = await InstagramThread.findOne({ igsid: "igsid-501" });
  assert.equal(thread.unread, 1, "the same message twice is stored once");
  assert.equal(thread.username, "asha.styles", "profile filled in");

  const list = await staff("/api/instagram/threads");
  assert.equal(list.data.threads[0].windowOpen, true);
  const reply = await staff(`/api/instagram/threads/${thread._id}/messages`, { method: "POST", body: { text: "Yes! Two left in M." } });
  assert.equal(reply.status, 202, JSON.stringify(reply.data));
  await drain(handlers, { now: later });
  const sent = meta.requests.find((request) => request.url === `/v24.0/${IG}/messages` && request.body.recipient.id === "igsid-501");
  assert.equal(sent.body.message.text, "Yes! Two left in M.");
  assert.equal((await InstagramMessage.findOne({ direction: "out" })).status, "sent");

  // Linked to her phone: her orders show beside the thread.
  await Contact.create({ tenantId: config.TENANT_ID, waId: "919800000080", name: "Asha" });
  const linked = await staff(`/api/instagram/threads/${thread._id}`, { method: "PATCH", body: { phone: "98000 00080" } });
  assert.ok(linked.data.thread.contactId);

  // Outside 24 hours: refused with a reason.
  await InstagramThread.updateOne({ _id: thread._id }, { $set: { lastInboundAt: new Date(Date.now() - 25 * 3600_000) } });
  const late = await staff(`/api/instagram/threads/${thread._id}/messages`, { method: "POST", body: { text: "Hi again" } });
  assert.equal(late.status, 409);

  // Comments: rules on; "price?" matches "price", "priceless" does not.
  assert.ok(matchRule("Price?", [{ keyword: "price" }]));
  assert.equal(matchRule("priceless look", [{ keyword: "price" }]), null);
  await Settings.updateOne({}, { $set: { "instagram.commentReplies": true } });
  const comment = (id, text) => ({ object: "instagram", entry: [{ id: IG, time: Date.now(), changes: [{ field: "comments", value: { id, text, from: { id: "igsid-777", username: "neha.k" }, media: { id: "m1" } } }] }] });
  await instagramIn(comment("c-1", "Price?"));
  await instagramIn(comment("c-2", "Love this"));
  const privateReply = meta.requests.find((request) => request.body?.recipient?.comment_id === "c-1");
  assert.match(privateReply.body.message.text, /https:\/\/store\.hanger\.test\/shop/);
  assert.ok(meta.requests.find((request) => request.url === "/v24.0/c-1/replies"), "public reply under the comment");
  assert.equal(meta.requests.filter((request) => request.body?.recipient?.comment_id).length, 1, "only the keyword comment");
  const saved = await InstagramComment.findOne({ commentId: "c-1" });
  assert.equal(saved.privateReply.status, "sent");
  assert.equal(saved.publicReply.status, "sent");
  const comments = await staff("/api/instagram/comments");
  assert.equal(comments.data.comments.length, 2);
});
