import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import mongoose from "mongoose";
import { createApp } from "../src/app.js";
import { createServices } from "../src/services.js";
import { withTransaction } from "../src/db.js";
import { createStyle } from "../src/commerce/catalog.js";
import { receiveStock } from "../src/commerce/stock.js";
import { createSession } from "../src/auth/sessions.js";
import { hashPassword } from "../src/security/password.js";
import { Location, Settings, Transfer, User } from "../src/models/index.js";
import { apiClient, clearCollections, connectTestDb, listen, testConfig } from "./helpers.js";

// Stock moved between the shop's locations: a challan number, the value at cost, whether an e-way
// bill is needed, and the e-way bill data for the portal.

let config;
let server;
let api;

async function seed() {
  const tenantId = config.TENANT_ID;
  await Settings.create({ tenantId, brandName: "The Hanger", legalName: "The Hanger Western Hub", gstin: "23ABCDE1234F1Z5", stateCode: "23", defaultHsn: "6204" });
  const [store, warehouse] = await Location.create([
    { tenantId, code: "ST1", name: "MG Road store", kind: "store", address: "12 MG Road, Indore", pincode: "452001", city: "Indore", invoicePrefix: "ST1" },
    { tenantId, code: "WH1", name: "Warehouse", kind: "warehouse", address: "Sanwer Road, Indore", pincode: "452015", city: "Indore", invoicePrefix: "WH1" },
  ]);
  await withTransaction(async (session) => {
    const { style, skus } = await createStyle({ tenantId, data: { code: "DRS-001", name: "Linen midi dress", category: "dresses", pricePaise: 199900, costPaise: 80000, hsn: "62044300", images: ["https://img.test/1.jpg"] }, sizes: ["S", "M"], session });
    style.status = "live";
    await style.save({ session });
    const top = await createStyle({ tenantId, data: { code: "TOP-001", name: "Poplin shirt", category: "tops", pricePaise: 105000, images: ["https://img.test/2.jpg"] }, sizes: ["M"], session });
    await receiveStock({ tenantId, locationId: warehouse._id, items: [{ sku: skus[0], qty: 40 }, { sku: skus[1], qty: 40 }, { sku: top.skus[0], qty: 10 }], by: "test", session });
  });
  return { store, warehouse };
}

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

test("a transfer gets a challan, its value at cost, and e-way bill data once it reaches the limit", async () => {
  await seed();
  const small = await api("/api/stock/transfer", { method: "POST", body: { from: "WH1", to: "ST1", items: [{ skuCode: "DRS-001-S", qty: 5 }] } });
  assert.equal(small.status, 200, JSON.stringify(small.data));
  assert.match(small.data.transfer.challanNo, /^WH1T\/\d{4}\/00001$/);
  assert.equal(small.data.transfer.valuePaise, 5 * 80000, "at cost");
  assert.equal(small.data.transfer.ewayNeeded, false, "Rs 4,000 is under the limit");

  // 63 pieces at Rs 800 cost + a shirt valued at its price before GST (no cost entered).
  const big = await api("/api/stock/transfer", { method: "POST", body: { from: "WH1", to: "ST1", items: [{ skuCode: "DRS-001-S", qty: 31 }, { skuCode: "DRS-001-M", qty: 32 }, { skuCode: "TOP-001-M", qty: 1 }] } });
  const transfer = big.data.transfer;
  assert.equal(transfer.valuePaise, 63 * 80000 + 100000, "the shirt at Rs 1,050 less 5% GST");
  assert.equal(transfer.ewayNeeded, true);
  assert.equal(transfer.sameGstin, true);

  const view = await api(`/api/transfers/${transfer._id}`);
  const bill = view.data.eway.json.billLists[0];
  assert.equal(bill.docType, "CHL");
  assert.equal(bill.subSupplyType, 5, "own use: no sale");
  assert.equal(bill.fromGstin, "23ABCDE1234F1Z5");
  assert.equal(bill.fromStateCode, 23);
  assert.equal(bill.toPincode, 452001);
  assert.equal(bill.totalValue, 51400);
  assert.equal(bill.igstValue + bill.cgstValue + bill.sgstValue, 0);
  assert.equal(bill.itemList.length, 2, "one item per style");
  assert.equal(bill.itemList[0].hsnCode, 62044300);
  assert.equal(bill.itemList[1].hsnCode, 6204, "the default HSN where a style has none");
  assert.ok(view.data.eway.problems.some((line) => /distance/.test(line)));

  const patched = await api(`/api/transfers/${transfer._id}`, { method: "PATCH", body: { transport: { vehicleNo: "mp09ab1234", distanceKm: 18 }, ewayBillNo: "123456789012" } });
  assert.equal(patched.status, 200, JSON.stringify(patched.data));
  assert.equal(patched.data.eway.json.billLists[0].vehicleNo, "MP09AB1234");
  assert.equal(patched.data.eway.json.billLists[0].transDistance, "18");
  assert.deepEqual(patched.data.eway.problems, []);
  assert.equal((await api(`/api/transfers/${transfer._id}`, { method: "PATCH", body: { ewayBillNo: "12345" } })).status, 400);
  assert.equal((await api("/api/transfers")).data.transfers.length, 2);
});

test("a location in another state with its own GSTIN: a supply between branches, taxed as IGST", async () => {
  const tenantId = config.TENANT_ID;
  await seed();
  await Location.create({ tenantId, code: "MUM", name: "Mumbai pop-up", kind: "store", address: "Linking Road, Bandra, Mumbai", pincode: "400050", city: "Mumbai", invoicePrefix: "MU1", gstin: "27ABCDE1234F1Z1" });
  const moved = await api("/api/stock/transfer", { method: "POST", body: { from: "WH1", to: "MUM", items: [{ skuCode: "DRS-001-M", qty: 10 }] } });
  assert.equal(moved.status, 200, JSON.stringify(moved.data));
  assert.equal(moved.data.transfer.sameGstin, false);
  const view = await api(`/api/transfers/${moved.data.transfer._id}`);
  const bill = view.data.eway.json.billLists[0];
  assert.equal(bill.docType, "INV");
  assert.equal(bill.toStateCode, 27);
  assert.equal(bill.toGstin, "27ABCDE1234F1Z1");
  assert.ok(bill.igstValue > 0);
  assert.equal(bill.cgstValue, 0);
  assert.ok(view.data.eway.problems.some((line) => /tax invoice/.test(line)));
  assert.equal(await Transfer.countDocuments({ tenantId }), 1);
});
