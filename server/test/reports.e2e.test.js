import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import mongoose from "mongoose";
import { createApp } from "../src/app.js";
import { createServices } from "../src/services.js";
import { withTransaction } from "../src/db.js";
import { createStyle } from "../src/commerce/catalog.js";
import { receiveStock } from "../src/commerce/stock.js";
import { markReturned, storeSale } from "../src/commerce/orders.js";
import { istDay, periodOf } from "../src/commerce/reports.js";
import { createSession } from "../src/auth/sessions.js";
import { hashPassword } from "../src/security/password.js";
import { Location, Order, Settings, User } from "../src/models/index.js";
import { apiClient, clearCollections, connectTestDb, listen, testConfig } from "./helpers.js";

// The owner's reports: sales with margin, stock value and slow pieces, and the month's GST summary.

const DAY = 86_400_000;
let config;
let server;
let baseUrl;

async function login(role) {
  const user = await User.create({ tenantId: config.TENANT_ID, name: role, email: `${role}@hanger.test`, role, status: "active", passwordHash: await hashPassword("Owner-password-1"), mustChangePassword: false, twoFactor: { enabled: role === "owner" } });
  const api = apiClient(baseUrl);
  api.setCookie(`hh_session=${await createSession({ user, req: { ip: "", get: () => "" }, twoFactorPending: false })}`);
  return api;
}

async function seed(now) {
  const tenantId = config.TENANT_ID;
  await Settings.create({ tenantId, brandName: "The Hanger", legalName: "The Hanger Western Hub", gstin: "23ABCDE1234F1Z5", stateCode: "23", onlineLocationCode: "ONL" });
  const [store] = await Location.create([{ tenantId, code: "ST1", name: "Store", kind: "store", address: "Indore", pincode: "452001", invoicePrefix: "ST1" }]);
  await withTransaction(async (session) => {
    const dress = await createStyle({ tenantId, data: { code: "DRS-001", name: "Linen midi dress", category: "dresses", pricePaise: 199900, costPaise: 90000, hsn: "6204" }, sizes: ["S", "M"], session });
    const top = await createStyle({ tenantId, data: { code: "TOP-001", name: "Sequin party top", category: "tops", pricePaise: 299900, hsn: "6206" }, sizes: ["M"], session });
    const jacket = await createStyle({ tenantId, data: { code: "JKT-001", name: "Denim jacket", category: "jackets", pricePaise: 249900, costPaise: 120000, hsn: "6202" }, sizes: ["M"], session });
    const longAgo = new Date(now.getTime() - 100 * DAY);
    await receiveStock({ tenantId, locationId: store._id, items: [{ sku: dress.skus[0], qty: 2 }, { sku: dress.skus[1], qty: 3 }, { sku: top.skus[0], qty: 2 }], by: "test", session, at: new Date(now.getTime() - 20 * DAY) });
    await receiveStock({ tenantId, locationId: store._id, items: [{ sku: jacket.skus[0], qty: 4 }], by: "test", session, at: longAgo });
    for (const [style, liveAt] of [[dress.style, new Date(now.getTime() - 20 * DAY)], [top.style, new Date(now.getTime() - 20 * DAY)], [jacket.style, longAgo]]) {
      Object.assign(style, { status: "live", images: ["https://img.test/1.jpg"], liveAt });
      await style.save({ session });
    }
  });
  return store;
}

const sell = (store, items, method, now) => withTransaction((session) => storeSale({ tenantId: config.TENANT_ID, locationId: store._id, items, method, by: "test", session, now }));

test.before(async () => {
  await connectTestDb();
  config = testConfig();
  server = http.createServer(createApp({ config, services: createServices(config), logger: { error() {}, warn() {}, info() {} } }));
  baseUrl = await listen(server);
});
test.beforeEach(() => clearCollections());
test.after(async () => {
  server.close();
  await mongoose.disconnect();
});

test("report periods are India days", () => {
  assert.equal(istDay(new Date("2026-11-26T19:00:00Z")), "2026-11-27", "00:30 in India is the next day");
  const period = periodOf({ from: "2026-11-01", to: "2026-11-30" });
  assert.equal(period.days, 30);
  assert.equal(period.start.toISOString(), "2026-10-31T18:30:00.000Z");
  assert.throws(() => periodOf({ from: "2026-11-30", to: "2026-11-01" }), /after/);
  assert.throws(() => periodOf({ from: "2026-02-30", to: "2026-03-01" }), /YYYY-MM-DD/);
});

test("sales: totals, returns netted, by channel and payment, best styles with margin; staff cannot see it", async () => {
  const now = new Date();
  const store = await seed(now);
  await sell(store, [{ skuCode: "DRS-001-M", qty: 2 }], "store_upi", now);
  await sell(store, [{ skuCode: "TOP-001-M", qty: 1 }], "store_cash", now);
  const returned = await sell(store, [{ skuCode: "DRS-001-S", qty: 1 }], "store_card", now);
  await withTransaction(async (session) => markReturned({ tenantId: config.TENANT_ID, order: await Order.findById(returned._id).session(session), by: "test", reason: "too small", session, now }));

  const owner = await login("owner");
  const { status, data } = await owner(`/api/reports/sales?from=${istDay(now)}&to=${istDay(now)}`);
  assert.equal(status, 200, JSON.stringify(data));
  assert.equal(data.totals.invoices, 3);
  assert.equal(data.totals.creditNotes, 1);
  assert.equal(data.totals.salesPaise, 2 * 199900 + 299900 + 199900);
  assert.equal(data.totals.returnsPaise, 199900);
  assert.equal(data.totals.netPaise, 2 * 199900 + 299900);
  assert.equal(data.totals.pieces, 4);
  assert.equal(data.totals.piecesReturned, 1);
  assert.equal(data.byDay.length, 1);
  assert.equal(data.byChannel[0].channel, "store");
  assert.deepEqual(data.byPayment.map((row) => row.method).sort(), ["store_card", "store_cash", "store_upi"]);
  assert.equal(data.byPayment.find((row) => row.method === "store_card").netPaise, 0, "the returned sale nets to zero");

  const dress = data.topStyles.find((row) => row.styleCode === "DRS-001");
  assert.equal(dress.pieces, 2, "3 sold, 1 back");
  assert.equal(dress.returned, 1);
  // Two dresses at Rs 1,999 incl. 5% GST: Rs 3,807.62 before tax, less Rs 1,800 cost.
  assert.equal(dress.taxablePaise, 380762);
  assert.equal(dress.marginPaise, 380762 - 180000);
  const top = data.topStyles.find((row) => row.styleCode === "TOP-001");
  assert.equal(top.marginPaise, null, "no cost entered: no margin");
  assert.ok(data.totals.costCoverage > 0 && data.totals.costCoverage < 1);
  assert.equal(data.bySize.find((row) => row.size === "M").pieces, 3);

  const staff = await login("staff");
  assert.equal((await staff("/api/reports/sales")).status, 403);
  assert.equal((await owner("/api/reports/sales?from=2026-13-01")).status, 400);
});

test("stock: value at price and cost, slow pieces ranked by a score with reasons", async () => {
  const now = new Date();
  const store = await seed(now);
  await sell(store, [{ skuCode: "DRS-001-M", qty: 2 }], "store_upi", now);

  const owner = await login("owner");
  const { status, data } = await owner("/api/reports/stock");
  assert.equal(status, 200, JSON.stringify(data));
  // Left: 2 S + 1 M dresses, 2 tops, 4 jackets.
  assert.equal(data.value.pieces, 9);
  assert.equal(data.value.atPricePaise, 3 * 199900 + 2 * 299900 + 4 * 249900);
  assert.equal(data.value.atCostPaise, 3 * 90000 + 4 * 120000);
  assert.equal(data.value.costedPieces, 7);
  assert.equal(data.slow[0].styleCode, "JKT-001", "100 days in, never sold: the slowest");
  assert.match(data.slow[0].why[0], /not sold since it arrived 100 days ago/);
  assert.equal(data.slow.at(-1).styleCode, "DRS-001", "sold today: the least slow");
  assert.equal(data.slow.at(-1).sold60, 2);
  assert.deepEqual(data.slow.at(-1).sizes, { S: 2, M: 1 });
  assert.ok(data.slow[0].score > data.slow[1].score && data.slow[1].score > data.slow[2].score);
});

test("GST: B2C summary by state and rate, credit notes netted, HSN summary and documents issued", async () => {
  const now = new Date();
  const store = await seed(now);
  await sell(store, [{ skuCode: "DRS-001-M", qty: 2 }], "store_upi", now);
  await sell(store, [{ skuCode: "TOP-001-M", qty: 1 }], "store_cash", now);
  const returned = await sell(store, [{ skuCode: "DRS-001-S", qty: 1 }], "store_card", now);
  await withTransaction(async (session) => markReturned({ tenantId: config.TENANT_ID, order: await Order.findById(returned._id).session(session), by: "test", reason: "too big", session, now }));

  const owner = await login("owner");
  const { status, data } = await owner(`/api/reports/gst?month=${istDay(now).slice(0, 7)}`);
  assert.equal(status, 200, JSON.stringify(data));
  assert.equal(data.invoices, 3);
  assert.equal(data.creditNotes, 1);
  assert.deepEqual(data.b2cs.map((row) => [row.stateCode, row.rate]), [["23", 5], ["23", 18]]);
  const fivePct = data.b2cs[0];
  assert.equal(fivePct.taxablePaise, 380762, "the returned dress is netted out");
  assert.equal(fivePct.cgstPaise + fivePct.sgstPaise, 2 * 199900 - 380762);
  assert.equal(fivePct.igstPaise, 0);
  assert.deepEqual(data.hsn.map((row) => [row.hsn, row.rate, row.qty]), [["6204", 5, 2], ["6206", 18, 1]]);
  assert.equal(data.totals.totalPaise, 2 * 199900 + 299900);
  assert.deepEqual(data.documents.map((doc) => [doc.kind, doc.count, doc.missing]), [["invoice", 3, 0], ["credit_note", 1, 0]]);
  assert.equal(data.b2cl.length, 0);
  assert.equal((await owner("/api/reports/gst?month=2026-13")).status, 400);
});
