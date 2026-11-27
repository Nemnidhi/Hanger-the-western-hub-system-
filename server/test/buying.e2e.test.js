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
import { storeSale } from "../src/commerce/orders.js";
import { retailPrice } from "../src/commerce/buying.js";
import { createSession } from "../src/auth/sessions.js";
import { hashPassword } from "../src/security/password.js";
import { Location, Markdown, PurchaseOrder, Settings, Sku, StockLevel, Style, Supplier, User } from "../src/models/index.js";
import { apiClient, clearCollections, connectTestDb, listen, testConfig } from "./helpers.js";

// The buying desk: purchase orders received in parts, a graded reorder list with sizes, the shop's
// size mix, the supplier scorecard, test buys, markdowns (public and members-only) and the calendar.

const DAY = 86_400_000;
let config;
let server;
let api;
let store;
let silk;
let indigo;

const ago = (days) => new Date(Date.now() - days * DAY);

async function seed() {
  const tenantId = config.TENANT_ID;
  await Settings.create({ tenantId, brandName: "The Hanger", legalName: "The Hanger Western Hub", gstin: "23ABCDE1234F1Z5", stateCode: "23", onlineLocationCode: "ST1" });
  [store] = await Location.create([{ tenantId, code: "ST1", name: "Store", kind: "store", address: "Indore", pincode: "452001", invoicePrefix: "ST1" }]);
  [silk, indigo] = await Supplier.create([
    { tenantId, name: "Silk Route", city: "Surat", waId: "919800000500" },
    { tenantId, name: "Indigo Works", city: "Jaipur" },
  ]);
  await withTransaction(async (session) => {
    const make = async (code, name, category, pricePaise, costPaise, sizes, supplierId, liveDays) => {
      const { style } = await createStyle({ tenantId, data: { code, name, category, pricePaise, costPaise, supplierId, images: ["https://img.test/x.jpg"] }, sizes, session });
      style.status = "live";
      style.liveAt = ago(liveDays);
      await style.save({ session });
      return style;
    };
    await make("DRS-001", "Linen midi dress", "dresses", 199900, 80000, ["S", "M", "L"], silk._id, 40);
    await make("TOP-001", "Poplin shirt", "tops", 139900, 50000, ["M", "L"], silk._id, 70);
    await make("JMP-001", "Wide-leg jumpsuit", "jumpsuits", 249900, 110000, ["S", "M"], indigo._id, 1);
    const top = await Sku.find({ styleCode: "TOP-001" }).session(session);
    await receiveStock({ tenantId, locationId: store._id, items: top.map((sku) => ({ sku, qty: 3 })), supplierId: silk._id, by: "test", session, at: ago(70) });
  });
}

const sale = (items, at, customer = {}) => withTransaction((session) => storeSale({ tenantId: config.TENANT_ID, locationId: store._id, items, method: "store_upi", customer, by: "test", session, now: at }));
const onHand = async (code) => (await StockLevel.findOne({ skuId: (await Sku.findOne({ code }))._id }))?.onHand ?? 0;

test.before(async () => {
  await connectTestDb();
  config = testConfig();
  server = http.createServer(createApp({ config, services: createServices(config), logger: { error() {}, warn() {}, info() {} } }));
  api = apiClient(await listen(server));
});
test.beforeEach(async () => {
  await clearCollections();
  const owner = await User.create({ tenantId: config.TENANT_ID, name: "Owner", email: "owner@hanger.test", role: "owner", status: "active", passwordHash: await hashPassword("Owner-password-1"), mustChangePassword: false, twoFactor: { enabled: true } });
  api.setCookie(`hh_session=${await createSession({ user: owner, req: { ip: "", get: () => "" }, twoFactorPending: false })}`);
});
test.after(async () => {
  server.close();
  await mongoose.disconnect();
});

test("a purchase order: drafted, sent, received in parts, closed; then the reorder list, sizes and the supplier", async () => {
  await seed();
  const made = await api("/api/purchase-orders", { method: "POST", body: { supplierId: String(silk._id), items: [{ skuCode: "DRS-001-S", qty: 4 }, { skuCode: "drs-001-m", qty: 6 }, { skuCode: "DRS-001-L", qty: 4 }], expectedAt: new Date().toISOString().slice(0, 10) } });
  assert.equal(made.status, 201, JSON.stringify(made.data));
  const poId = made.data.order._id;
  assert.equal(made.data.order.lines[0].costPaise, 80000, "cost from the style");
  assert.equal((await api(`/api/purchase-orders/${poId}/receive`, { method: "POST", body: { items: [{ skuCode: "DRS-001-S", qty: 1 }] } })).data.error, "NOT_SENT");

  const sent = await api(`/api/purchase-orders/${poId}/send`, { method: "POST", body: {} });
  assert.equal(sent.data.order.status, "sent");
  assert.match(sent.data.text, /Order #\d+ from The Hanger/);
  assert.match(sent.data.text, /S x 4, M x 6, L x 4/);

  const first = await api(`/api/purchase-orders/${poId}/receive`, { method: "POST", body: { items: [{ skuCode: "DRS-001-S", qty: 4 }, { skuCode: "DRS-001-M", qty: 6 }] } });
  assert.equal(first.data.order.status, "part_received");
  await api(`/api/purchase-orders/${poId}/receive`, { method: "POST", body: { items: [{ skuCode: "DRS-001-L", qty: 3 }] } });
  assert.equal(await onHand("DRS-001-M"), 6);
  const closed = await api(`/api/purchase-orders/${poId}/cancel`, { method: "POST", body: {} });
  assert.equal(closed.data.order.status, "received", "the missing piece is no longer expected; what came stays");

  // A month of selling: M sells most.
  for (const [code, days] of [["DRS-001-M", 25], ["DRS-001-M", 18], ["DRS-001-M", 9], ["DRS-001-M", 3], ["DRS-001-S", 12], ["DRS-001-S", 4], ["DRS-001-L", 6]]) await sale([{ skuCode: code, qty: 1 }], ago(days));

  const reorder = await api("/api/buying/reorder");
  assert.equal(reorder.status, 200, JSON.stringify(reorder.data));
  assert.deepEqual(reorder.data.rows.map((row) => row.styleCode), ["DRS-001"], "only styles that sell are on the list");
  const dress = reorder.data.rows[0];
  assert.ok(dress.score > 0 && dress.score <= 100);
  assert.equal(dress.why.length, 4);
  const suggest = Object.fromEntries(dress.suggest.sizes.map((row) => [row.size, row.suggest]));
  assert.ok(suggest.M >= suggest.S && suggest.M >= suggest.L, `M first: ${JSON.stringify(suggest)}`);
  assert.ok(dress.suggest.total > 0);

  const mix = await api("/api/buying/size-mix");
  const dresses = mix.data.categories.find((row) => row.category === "dresses");
  assert.equal(dresses.kept, 7);
  assert.equal(Math.round(dresses.sizes.find((row) => row.size === "M").share * 7), 4);

  const draft = await api("/api/purchase-orders/reorder-draft", { method: "POST", body: { supplierId: String(silk._id) } });
  assert.equal(draft.status, 201, JSON.stringify(draft.data));
  assert.equal(draft.data.order.status, "draft");
  assert.ok(draft.data.order.lines.some((line) => line.skuCode === "DRS-001-M"));
  assert.equal((await api("/api/purchase-orders/reorder-draft", { method: "POST", body: { supplierId: String(indigo._id) } })).data.error, "NOTHING_TO_ORDER");

  const cards = await api("/api/buying/suppliers");
  const card = cards.data.suppliers.find((row) => row.name === "Silk Route");
  assert.equal(card.styles, 2);
  assert.equal(card.received, 13 + 6);
  assert.equal(card.fill, 13 / 14);
  assert.equal(card.onTime, 1);
  assert.ok(card.score > 0);
  assert.equal(cards.data.suppliers.find((row) => row.name === "Indigo Works").sold, 0);
});

test("markdowns: public changes every size's price and puts it back; quiet gives members the price at the counter", async () => {
  await seed();
  const plan = await api("/api/buying/markdowns");
  assert.equal(plan.status, 200, JSON.stringify(plan.data));
  const shirt = plan.data.plan.find((row) => row.styleCode === "TOP-001");
  assert.ok(shirt, "70 days on the rail without a sale");
  assert.ok(shirt.suggest.pct >= 10);
  assert.equal(shirt.suggest.kind, "public");

  const below = await api("/api/buying/markdowns", { method: "POST", body: { styleCode: "TOP-001", kind: "public", pct: 70 } });
  assert.equal(below.data.error, "BELOW_FLOOR", "never below cost plus the minimum markup");

  const open = await api("/api/buying/markdowns", { method: "POST", body: { styleCode: "TOP-001", kind: "public", pct: 30, reason: "slow" } });
  assert.equal(open.status, 201, JSON.stringify(open.data));
  assert.equal(open.data.markdown.pricePaise, 97900);
  assert.equal((await Sku.findOne({ code: "TOP-001-M" })).pricePaise, 97900);
  assert.equal((await Style.findOne({ code: "TOP-001" })).markdown.listPaise, 139900);
  const bill = await sale([{ skuCode: "TOP-001-M", qty: 1 }], new Date());
  assert.equal(bill.totals.totalPaise, 97900);
  assert.equal((await api("/api/buying/markdowns", { method: "POST", body: { styleCode: "TOP-001", kind: "quiet", pct: 10 } })).data.error, "ALREADY_MARKED");

  await api(`/api/buying/markdowns/${open.data.markdown._id}/end`, { method: "POST", body: {} });
  assert.equal((await Sku.findOne({ code: "TOP-001-M" })).pricePaise, 139900, "back to the old price");
  assert.equal((await Style.findOne({ code: "TOP-001" })).pricePaise, 139900);

  const until = new Date(Date.now() + 3 * DAY).toISOString().slice(0, 10);
  const quiet = await api("/api/buying/markdowns", { method: "POST", body: { styleCode: "TOP-001", kind: "quiet", pct: 20, until } });
  assert.equal(quiet.status, 201, JSON.stringify(quiet.data));
  assert.equal((await Sku.findOne({ code: "TOP-001-M" })).pricePaise, 139900, "the rail price stays");
  const member = await sale([{ skuCode: "TOP-001-L", qty: 1 }], new Date(), { name: "Asha", phone: "9800000001" });
  assert.equal(member.totals.totalPaise, retailPrice(139900 * 0.8));
  assert.equal(member.lines[0].listUnitPaise, 139900);
  const walkIn = await sale([{ skuCode: "TOP-001-L", qty: 1 }], new Date());
  assert.equal(walkIn.totals.totalPaise, 139900, "no phone, no member price");
  const quote = await api("/api/counter/quote", { method: "POST", body: { phone: "9800000001", grossPaise: 139900, items: [{ skuCode: "TOP-001-M", qty: 1 }] } });
  assert.equal(quote.data.quote.memberSavingPaise, 139900 - retailPrice(139900 * 0.8));

  // On its last day the queued job ends it.
  await drain(createHandlers({ config, now: () => new Date(Date.now() + 4 * DAY) }), { now: () => new Date(Date.now() + 4 * DAY) });
  assert.equal((await Markdown.findById(quiet.data.markdown._id)).status, "ended");
  assert.equal((await Style.findOne({ code: "TOP-001" })).markdown.kind, "");
  const history = await api("/api/buying/markdowns");
  assert.equal(history.data.markdowns.length, 2);
});

test("a test buy is judged against its category; the calendar says when to order", async () => {
  await seed();
  const trial = await api("/api/purchase-orders", { method: "POST", body: { supplierId: String(indigo._id), trial: true, items: [{ skuCode: "JMP-001-S", qty: 2 }, { skuCode: "JMP-001-M", qty: 2 }] } });
  assert.equal(trial.status, 201, JSON.stringify(trial.data));
  await api(`/api/purchase-orders/${trial.data.order._id}/send`, { method: "POST", body: {} });
  await api(`/api/purchase-orders/${trial.data.order._id}/receive`, { method: "POST", body: { items: [{ skuCode: "JMP-001-S", qty: 2 }, { skuCode: "JMP-001-M", qty: 2 }] } });
  await sale([{ skuCode: "JMP-001-M", qty: 2 }], new Date());
  await sale([{ skuCode: "JMP-001-S", qty: 1 }], new Date());

  const trials = await api("/api/buying/trials");
  assert.equal(trials.status, 200, JSON.stringify(trials.data));
  const row = trials.data.rows[0];
  assert.equal(row.styleCode, "JMP-001");
  assert.equal(row.bought, 4);
  assert.equal(row.sellThrough, 0.75);
  assert.match(row.step, /^early/, "judged after the trial days");

  assert.equal((await api("/api/settings", { method: "PATCH", body: { buying: { leadDays: 10, calendar: [{ name: "Navratri", date: "2027-09-30", buyWeeksBefore: 4, categories: ["jumpsuits"] }, { name: "Long gone", date: "2020-01-01" }] } } })).status, 200);
  const calendar = await api("/api/buying/calendar");
  assert.deepEqual(calendar.data.events.map((event) => event.name), ["Navratri"], "past one-off dates drop off");
  assert.equal(calendar.data.events[0].orderBy, "2027-08-23", "10 days lead + 4 weeks before");
  assert.equal(calendar.data.events[0].inStock, 1);
  assert.equal((await PurchaseOrder.findById(trial.data.order._id)).status, "received");
});
