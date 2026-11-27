import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import mongoose from "mongoose";
import { createApp } from "../src/app.js";
import { createServices } from "../src/services.js";
import { createHandlers } from "../src/handlers.js";
import { drain } from "../src/jobs/runner.js";
import { withTransaction } from "../src/db.js";
import { createStyle } from "../src/commerce/catalog.js";
import { receiveStock } from "../src/commerce/stock.js";
import { Contact, Conversation, Creator, Invoice, Job, Location, LoginCode, Message, Order, Settings, Style } from "../src/models/index.js";
import { apiClient, clearCollections, connectTestDb, listen, startFakeMeta, testConfig } from "./helpers.js";

// The website storefront's API: the collection with sizes in stock online, search, size charts,
// sign-in with a WhatsApp code, the bag's price, website orders (COD and prepaid), the picks after a
// bag she left, and the Google product feed.

let meta;
let razorpay;
let config;
let server;
let baseUrl;
let handlers;
const PHONE = "9800000042";
const WA = "919800000042";

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

async function seed() {
  const tenantId = config.TENANT_ID;
  await Settings.create({ tenantId, brandName: "The Hanger", legalName: "The Hanger Western Hub", gstin: "23ABCDE1234F1Z5", stateCode: "23", onlineLocationCode: "ONL" });
  const [online] = await Location.create([
    { tenantId, code: "ONL", name: "Online stock room", kind: "warehouse", address: "Indore", pincode: "452001", invoicePrefix: "IN1" },
    { tenantId, code: "ST1", name: "Store", kind: "store", address: "Indore", pincode: "452001", invoicePrefix: "ST1" },
  ]);
  await withTransaction(async (session) => {
    const make = async (data, sizes, live = true) => {
      const made = await createStyle({ tenantId, data: { images: [`https://img.test/${data.code}.jpg`], ...data }, sizes, session });
      if (live) {
        made.style.status = "live";
        made.style.liveAt = new Date();
        await made.style.save({ session });
      }
      return made;
    };
    const dress = await make({ code: "DRS-001", name: "Linen midi dress", category: "dresses", pricePaise: 199900, description: "Breezy linen for summer brunches", attributes: { colour: "sage green", fabric: "linen", occasion: ["brunch", "vacation"] }, pairsWith: ["JKT-001"] }, ["S", "M", "L"]);
    const jacket = await make({ code: "JKT-001", name: "Cropped denim jacket", category: "jackets", pricePaise: 249900, attributes: { colour: "blue", fabric: "denim", occasion: ["brunch"] } }, ["S", "M"]);
    const soldOut = await make({ code: "TOP-001", name: "Satin cami", category: "tops", pricePaise: 89900, attributes: { colour: "black", occasion: ["party"] } }, ["M"]);
    await make({ code: "TOP-002", name: "Draft top", category: "tops", pricePaise: 99900 }, ["M"], false);
    await receiveStock({ tenantId, locationId: online._id, items: [{ sku: dress.skus[0], qty: 3 }, { sku: dress.skus[1], qty: 1 }, { sku: jacket.skus[1], qty: 2 }], by: "test", session });
    void soldOut;
  });
}

const shopApi = () => apiClient(baseUrl);

async function signIn(api) {
  const asked = await api("/api/shop/login/code", { method: "POST", body: { phone: PHONE } });
  assert.equal(asked.status, 200, JSON.stringify(asked.data));
  const verified = await api("/api/shop/login/verify", { method: "POST", body: { phone: PHONE, code: asked.data.devCode, offers: true } });
  assert.equal(verified.status, 200, JSON.stringify(verified.data));
  return verified.data.account;
}

test.before(async () => {
  await connectTestDb();
  meta = await startFakeMeta();
  razorpay = await startFakeRazorpay();
  config = testConfig({ META_GRAPH_BASE: meta.baseUrl, RAZORPAY_KEY_ID: "rzp_test_key", RAZORPAY_KEY_SECRET: "rzp-test-secret", RAZORPAY_WEBHOOK_SECRET: "rzp-webhook-secret", RAZORPAY_API_BASE: razorpay.url, SHOP_CODE_STAND_IN: true });
  handlers = createHandlers({ config });
  server = http.createServer(createApp({ config, services: createServices(config), logger: { error() {}, warn() {}, info() {} } }));
  baseUrl = await listen(server);
});
test.beforeEach(async () => {
  await clearCollections();
  razorpay.requests.length = 0;
});
test.after(async () => {
  server.close();
  await meta.close();
  await razorpay.close();
  await mongoose.disconnect();
});

test("the collection shows live styles with sizes in stock online, sold-out last; search and the style page", async () => {
  await seed();
  const api = shopApi();
  const catalog = await api("/api/shop/catalog");
  assert.equal(catalog.status, 200);
  const codes = catalog.data.styles.map((style) => style.code);
  assert.ok(!codes.includes("TOP-002"), "drafts stay hidden");
  assert.equal(codes.at(-1), "TOP-001", "sold out goes last");
  const dress = catalog.data.styles.find((style) => style.code === "DRS-001");
  assert.deepEqual(dress.sizes.map((size) => [size.size, size.inStock, size.few]), [["S", true, false], ["M", true, true], ["L", false, false]]);
  assert.equal(dress.costPaise, undefined, "no costs on the website");
  assert.deepEqual(catalog.data.facets.categories, ["dresses", "jackets", "tops"]);

  const inM = await api("/api/shop/catalog?size=S");
  assert.deepEqual(inM.data.styles.map((style) => style.code), ["DRS-001"], "only S in stock: the dress");

  const search = await api("/api/shop/search?q=green%20dresses");
  assert.equal(search.data.styles[0].code, "DRS-001");
  assert.equal((await api("/api/shop/search?q=denim")).data.styles[0].code, "JKT-001");

  const page = await api("/api/shop/styles/drs-001");
  assert.equal(page.status, 200);
  assert.deepEqual(page.data.pairs.map((style) => style.code), ["JKT-001"]);
  assert.equal(page.data.sizeChart.columns[1], "Bust");
  assert.equal((await api("/api/shop/styles/TOP-002")).status, 404);
});

test("sign-in with a WhatsApp code: one a minute, five tries, a 60-day session, the template when set", async () => {
  await seed();
  const api = shopApi();
  assert.equal((await api("/api/shop/me")).data.account, null);
  const asked = await api("/api/shop/login/code", { method: "POST", body: { phone: PHONE } });
  assert.equal(asked.data.via, "stand-in");
  assert.match(asked.data.devCode, /^\d{6}$/);
  assert.equal((await api("/api/shop/login/code", { method: "POST", body: { phone: PHONE } })).status, 429, "one a minute");
  assert.equal((await api("/api/shop/login/code", { method: "POST", body: { phone: PHONE }, appHeader: false })).status, 403);

  const wrong = await api("/api/shop/login/verify", { method: "POST", body: { phone: PHONE, code: asked.data.devCode === "000000" ? "111111" : "000000" } });
  assert.equal(wrong.status, 400);
  assert.match(wrong.data.message, /4 tries left/);
  const ok = await api("/api/shop/login/verify", { method: "POST", body: { phone: PHONE, code: asked.data.devCode, offers: true } });
  assert.equal(ok.status, 200, JSON.stringify(ok.data));
  assert.equal(ok.data.account.phone, WA);
  assert.match(ok.headers.get("set-cookie"), /hh_shop=.+HttpOnly/i);
  assert.equal((await api("/api/shop/me")).data.account.phone, WA);
  assert.equal((await Contact.findOne({ waId: WA })).consents.offers.source, "website:sign-in");
  assert.equal((await api("/api/shop/login/verify", { method: "POST", body: { phone: PHONE, code: asked.data.devCode } })).status, 400, "a code works once");

  // With the authentication template set, the code goes on WhatsApp and is never returned.
  await Settings.updateOne({}, { $set: { "shop.loginTemplate": { name: "hanger_login", language: "en" } } });
  await LoginCode.deleteMany({});
  const other = await api("/api/shop/login/code", { method: "POST", body: { phone: "9800000043" } });
  assert.equal(other.data.via, "template");
  assert.equal(other.data.devCode, undefined);
  const message = await Message.findOne({ purpose: "login" });
  assert.equal(message.template.name, "hanger_login");

  await api("/api/shop/logout", { method: "POST", body: {} });
  assert.equal((await api("/api/shop/me")).data.account, null);
});

test("a website order: COD at low risk is confirmed with its invoice; a creator code comes off; prepaid gets a link that returns to the site", async () => {
  await seed();
  const api = shopApi();
  assert.equal((await api("/api/shop/orders", { method: "POST", body: { items: [{ skuCode: "DRS-001-S", qty: 1 }], address: { name: "Asha", address: "Flat 12, Vijay Nagar, Indore", pincode: "452010" }, method: "cod" } })).status, 401);
  await signIn(api);
  await Creator.create({ tenantId: config.TENANT_ID, name: "Riya", code: "RIYA10", discountPct: 10 });

  const quote = await api("/api/shop/quote", { method: "POST", body: { items: [{ skuCode: "DRS-001-S", qty: 1 }], code: "RIYA10" } });
  assert.equal(quote.status, 200, JSON.stringify(quote.data));
  assert.equal(quote.data.totalPaise, 199900 - 19990);
  assert.equal(quote.data.codAllowed, true);
  assert.equal(quote.data.prepaidAllowed, true);

  const placed = await api("/api/shop/orders", { method: "POST", body: { items: [{ skuCode: "DRS-001-S", qty: 1 }], address: { name: "Asha Jain", address: "Flat 12, Shanti Apartment, Vijay Nagar, Indore", pincode: "452010" }, method: "cod", code: "RIYA10" } });
  assert.equal(placed.status, 201, JSON.stringify(placed.data));
  assert.equal(placed.data.order.status, "confirmed");
  assert.equal(placed.data.order.totalPaise, 179910);
  const order = await Order.findById(placed.data.order._id);
  assert.equal(order.channel, "website");
  assert.equal(order.discount.code, "RIYA10");
  assert.ok(await Invoice.findById(order.invoiceId), "GST invoice written");
  assert.equal((await Contact.findOne({ waId: WA })).lastAddress.pincode, "452010");

  const prepaid = await api("/api/shop/orders", { method: "POST", body: { items: [{ skuCode: "JKT-001-M", qty: 1 }], address: { name: "Asha Jain", address: "Flat 12, Shanti Apartment, Vijay Nagar, Indore", pincode: "452010" }, method: "prepaid" } });
  assert.equal(prepaid.data.order.status, "awaiting_payment");
  await drain(handlers);
  assert.equal(razorpay.requests.length, 1);
  assert.equal(razorpay.requests[0].body.callback_url, `https://store.hanger.test/account/orders/${prepaid.data.order._id}`);
  const view = await api(`/api/shop/orders/${prepaid.data.order._id}`);
  assert.equal(view.data.order.payment.url, "https://rzp.test/i/1");
  assert.equal((await api("/api/shop/orders")).data.orders.length, 2);

  // Someone else's order is not hers.
  const stranger = shopApi();
  assert.equal((await stranger(`/api/shop/orders/${prepaid.data.order._id}`)).status, 401);
});

test("medium-risk COD waits for her to confirm on the page; a bag she left queues the picks, which an order since cancels", async () => {
  await seed();
  await Settings.updateOne({}, { $set: { "cod.lowBelow": 0, "cod.highFrom": 0.95, "picks.autoSend": true } });
  const api = shopApi();
  await signIn(api);
  const placed = await api("/api/shop/orders", { method: "POST", body: { items: [{ skuCode: "DRS-001-M", qty: 1 }], address: { name: "Asha Jain", address: "Flat 12, Shanti Apartment, Vijay Nagar, Indore", pincode: "452010" }, method: "cod" } });
  assert.equal(placed.data.order.status, "awaiting_confirmation");
  assert.equal(placed.data.order.cod.needsConfirm, true);
  const confirmed = await api(`/api/shop/orders/${placed.data.order._id}/confirm-cod`, { method: "POST", body: {} });
  assert.equal(confirmed.status, 200, JSON.stringify(confirmed.data));
  assert.equal(confirmed.data.order.status, "confirmed");

  const left = await api("/api/shop/bag-left", { method: "POST", body: { pieces: ["DRS-001-S"] } });
  assert.equal(left.data.queued, true);
  const job = await Job.findOne({ name: "picks.followUp" });
  assert.ok(job.payload.since);
  // Her chat is open, so picks can go as plain messages. No order since she left the bag: they go.
  await Conversation.updateOne({}, { $set: { lastInboundAt: new Date() } });
  await handlers["picks.followUp"](job.payload);
  assert.equal(await Message.countDocuments({ purpose: "picks" }), 1);
  // An order after she left the bag: the picks do nothing.
  await Contact.updateOne({ waId: WA }, { $set: { "picks.lastSentAt": null } });
  await Order.collection.updateOne({ _id: new mongoose.Types.ObjectId(placed.data.order._id) }, { $set: { createdAt: new Date(Date.now() + 60_000) } });
  await handlers["picks.followUp"]({ ...job.payload, since: new Date().toISOString() });
  assert.equal(await Message.countDocuments({ purpose: "picks" }), 1, "nothing more");
});

test("the Google product feed lists every size with availability, the sale price on a public markdown", async () => {
  await seed();
  await Style.updateOne({ code: "DRS-001" }, { $set: { markdown: { kind: "public", listPaise: 249900, pct: 20 } } });
  const response = await fetch(`${baseUrl}/feeds/google-products.xml`);
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type"), /xml/);
  const text = await response.text();
  assert.match(text, /<g:id>DRS-001-S<\/g:id>/);
  assert.match(text, /<g:id>DRS-001-L<\/g:id>[\s\S]*?<g:availability>out_of_stock<\/g:availability>/);
  assert.match(text, /<g:price>2499.00 INR<\/g:price><g:sale_price>1999.00 INR<\/g:sale_price>/);
  assert.match(text, /<link>https:\/\/store.hanger.test\/p\/drs-001\?size=S<\/link>/);
  assert.ok(!text.includes("TOP-002"));
});
