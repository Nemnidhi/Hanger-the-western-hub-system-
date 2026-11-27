import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import mongoose from "mongoose";
import { createApp } from "../src/app.js";
import { createServices } from "../src/services.js";
import { withTransaction } from "../src/db.js";
import { createStyle } from "../src/commerce/catalog.js";
import { receiveStock } from "../src/commerce/stock.js";
import { istDay } from "../src/commerce/reports.js";
import { createSession } from "../src/auth/sessions.js";
import { hashPassword } from "../src/security/password.js";
import { Invoice, Location, Order, Return, Settings, Sku, StockLevel, User } from "../src/models/index.js";
import { apiClient, clearCollections, connectTestDb, listen, testConfig } from "./helpers.js";

// Returns with reasons: some pieces of a bill or an order, a credit note for just those, stock back
// only for pieces fit to sell, exchanges at the counter, and the reasons in the sales report.

let config;
let server;
let baseUrl;
let api;

async function seed() {
  const tenantId = config.TENANT_ID;
  await Settings.create({ tenantId, brandName: "The Hanger", legalName: "The Hanger Western Hub", gstin: "23ABCDE1234F1Z5", stateCode: "23", onlineLocationCode: "ONL" });
  const [store] = await Location.create([{ tenantId, code: "ST1", name: "Store", kind: "store", address: "Indore", pincode: "452001", invoicePrefix: "ST1" }]);
  await withTransaction(async (session) => {
    const dress = await createStyle({ tenantId, data: { code: "DRS-001", name: "Linen midi dress", category: "dresses", pricePaise: 199900, images: ["https://img.test/1.jpg"] }, sizes: ["M"], session });
    const top = await createStyle({ tenantId, data: { code: "TOP-001", name: "Poplin shirt", category: "tops", pricePaise: 139900, images: ["https://img.test/2.jpg"] }, sizes: ["L"], session });
    for (const { style } of [dress, top]) {
      style.status = "live";
      await style.save({ session });
    }
    await receiveStock({ tenantId, locationId: store._id, items: [{ sku: dress.skus[0], qty: 4 }, { sku: top.skus[0], qty: 3 }], by: "test", session });
  });
}

const stock = async (code) => (await StockLevel.findOne({ skuId: (await Sku.findOne({ code }))._id })).onHand;
const bill = (items, extra = {}) => api("/api/store-sales", { method: "POST", body: { location: "ST1", items, method: "store_upi", customer: { name: "Asha", phone: "9800000001" }, ...extra } });

test.before(async () => {
  await connectTestDb();
  config = testConfig();
  server = http.createServer(createApp({ config, services: createServices(config), logger: { error() {}, warn() {}, info() {} } }));
  baseUrl = await listen(server);
});
test.beforeEach(async () => {
  await clearCollections();
  const owner = await User.create({ tenantId: config.TENANT_ID, name: "Owner", email: "owner@hanger.test", role: "owner", status: "active", passwordHash: await hashPassword("Owner-password-1"), mustChangePassword: false, twoFactor: { enabled: true } });
  api = apiClient(baseUrl);
  api.setCookie(`hh_session=${await createSession({ user: owner, req: { ip: "", get: () => "" }, twoFactorPending: false })}`);
});
test.after(async () => {
  server.close();
  await mongoose.disconnect();
});

test("pieces come back one by one: a credit note each, stock back only when fit to sell, never more than bought", async () => {
  await seed();
  const sale = await bill([{ skuCode: "DRS-001-M", qty: 2 }, { skuCode: "TOP-001-L", qty: 1 }]);
  assert.equal(sale.status, 201, JSON.stringify(sale.data));
  const orderId = sale.data.order._id;
  assert.equal(await stock("DRS-001-M"), 2);

  const found = await api(`/api/returns/find?q=${encodeURIComponent(sale.data.invoice.number)}`);
  assert.equal(found.data.orders.length, 1, "found by the invoice number");
  assert.equal((await api("/api/returns/find?q=9800000001")).data.orders.length, 1, "and by phone");

  const first = await api(`/api/orders/${orderId}/returns`, { method: "POST", body: { items: [{ skuCode: "DRS-001-M", qty: 1, reason: "too_small" }], refund: { method: "upi" } } });
  assert.equal(first.status, 201, JSON.stringify(first.data));
  assert.equal(first.data.order.status, "delivered", "part of the bill is still with her");
  assert.equal(first.data.creditNote.totals.totalPaise, 199900);
  assert.equal(first.data.creditNote.lines.length, 1);
  assert.match(first.data.creditNote.number, /^ST1C\//);
  assert.equal(await stock("DRS-001-M"), 3, "back on the shelf");

  const damaged = await api(`/api/orders/${orderId}/returns`, { method: "POST", body: { items: [{ skuCode: "DRS-001-M", qty: 1, reason: "damaged", condition: "damaged" }], refund: { method: "cash" } } });
  assert.equal(damaged.status, 201, JSON.stringify(damaged.data));
  assert.equal(await stock("DRS-001-M"), 3, "a damaged piece stays out of stock");

  const tooMany = await api(`/api/orders/${orderId}/returns`, { method: "POST", body: { items: [{ skuCode: "DRS-001-M", qty: 1, reason: "too_big" }], refund: { method: "cash" } } });
  assert.equal(tooMany.status, 409);
  assert.equal(tooMany.data.error, "TOO_MANY");
  assert.equal((await api(`/api/orders/${orderId}/returns`, { method: "POST", body: { items: [{ skuCode: "TOP-001-L", qty: 1, reason: "nope" }], refund: { method: "cash" } } })).status, 400);

  const last = await api(`/api/orders/${orderId}/returns`, { method: "POST", body: { items: [{ skuCode: "TOP-001-L", qty: 1, reason: "too_big" }], refund: { method: "cash" } } });
  assert.equal(last.data.order.status, "returned", "everything is back");
  assert.equal(last.data.order.payment.status, "refunded");
  assert.equal(await Invoice.countDocuments({ kind: "credit_note", orderId }), 3);
  assert.equal((await api(`/api/returns?orderId=${orderId}`)).data.returns.length, 3);

  const report = await api(`/api/reports/sales?from=${istDay(new Date())}&to=${istDay(new Date())}`);
  assert.equal(report.data.totals.netPaise, 0);
  assert.deepEqual(report.data.returns.byReason.map((row) => [row.reason, row.pieces]).sort(), [["damaged", 1], ["too_big", 1], ["too_small", 1]]);
  const dress = report.data.returns.topStyles.find((row) => row.styleCode === "DRS-001");
  assert.equal(dress.pieces, 2);
  assert.equal(dress.damaged, 1);
  assert.equal(dress.returnRate, 1);
  assert.equal(dress.fitLean, -0.5, "one of two came back too small");

  const gst = await api(`/api/reports/gst?month=${istDay(new Date()).slice(0, 7)}`);
  assert.equal(gst.data.totals.totalPaise, 0, "three credit notes cancel the bill");
  assert.equal(gst.data.documents.find((doc) => doc.kind === "credit_note").count, 3);
});

test("an exchange: the return's credit goes into a new bill, once", async () => {
  await seed();
  const sale = await bill([{ skuCode: "DRS-001-M", qty: 1 }]);
  const ret = await api(`/api/orders/${sale.data.order._id}/returns`, { method: "POST", body: { items: [{ skuCode: "DRS-001-M", qty: 1, reason: "fit" }], refund: { method: "exchange" } } });
  assert.equal(ret.status, 201);
  assert.equal(ret.data.order.payment.status, "paid", "an exchange is not a refund");
  const swap = await bill([{ skuCode: "TOP-001-L", qty: 1 }], { exchangeReturnId: ret.data.return._id });
  assert.equal(swap.status, 201, JSON.stringify(swap.data));
  assert.equal(String((await Return.findById(ret.data.return._id)).exchangeOrderId), swap.data.order._id);
  assert.match((await Order.findById(swap.data.order._id)).history.at(-1).note, /credit Rs 1999.00/);
  const twice = await bill([{ skuCode: "TOP-001-L", qty: 1 }], { exchangeReturnId: ret.data.return._id });
  assert.equal(twice.status, 409);
  assert.equal(await stock("TOP-001-L"), 2, "the refused bill took nothing off the shelf");
});

test("the whole-order return still works and records the staff's words", async () => {
  await seed();
  const sale = await bill([{ skuCode: "DRS-001-M", qty: 1 }, { skuCode: "TOP-001-L", qty: 1 }]);
  const done = await api(`/api/orders/${sale.data.order._id}/return`, { method: "POST", body: { reason: "Did not like the colour" } });
  assert.equal(done.status, 200, JSON.stringify(done.data));
  assert.equal(done.data.order.status, "returned");
  const [ret] = await Return.find();
  assert.equal(ret.lines.length, 2);
  assert.equal(ret.lines[0].reason, "other");
  assert.equal(ret.note, "Did not like the colour");
  assert.equal(await Invoice.countDocuments({ kind: "credit_note" }), 1);
});
