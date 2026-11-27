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
import { Contact, Invoice, Location, PointsEntry, Settings, User } from "../src/models/index.js";
import { apiClient, clearCollections, connectTestDb, listen, testConfig } from "./helpers.js";

// Customers: one record per phone across channels, points earned on what she keeps and spent on a
// later bill, taken back with returns, a friend's code on a first bill, creator codes and their
// monthly statements.

let config;
let server;
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
    await receiveStock({ tenantId, locationId: store._id, items: [{ sku: dress.skus[0], qty: 10 }, { sku: top.skus[0], qty: 10 }], by: "test", session });
  });
}

const bill = (items, customer, extra = {}) => api("/api/store-sales", { method: "POST", body: { location: "ST1", items, method: "store_upi", customer, ...extra } });
const asha = { name: "Asha", phone: "9800000001" };
const points = async (phone) => (await Contact.findOne({ waId: `91${phone}` })).loyalty.points;

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

test("points: earned on a counter bill, spent on the next within the cap, given back and taken back on a return", async () => {
  await seed();
  const first = await bill([{ skuCode: "DRS-001-M", qty: 2 }], asha);
  assert.equal(first.status, 201, JSON.stringify(first.data));
  assert.ok(first.data.order.contactId, "the phone links the bill to her record");
  assert.equal(await points("9800000001"), 39, "1 point a Rs 100 kept");

  const contact = await Contact.findOne({ waId: "919800000001" });
  assert.match(contact.loyalty.referralCode, /^ASHA[A-Z2-9]{3}$/);
  assert.equal(contact.loyalty.tier, "Circle");

  assert.equal((await api(`/api/customers/${contact._id}/points`, { method: "POST", body: { points: 100, note: "welcome gift" } })).status, 200);
  const quote = await api("/api/counter/quote", { method: "POST", body: { phone: "98000 00001", grossPaise: 139900 } });
  assert.equal(quote.data.member.points, 139);
  assert.equal(quote.data.member.tier.name, "Circle");
  assert.equal(quote.data.quote.points.max, 139);
  const tooFew = await api("/api/counter/quote", { method: "POST", body: { phone: "9800000001", grossPaise: 139900, redeem: 50 } });
  assert.equal(tooFew.data.error, "TOO_FEW_POINTS");
  const overCap = await api("/api/counter/quote", { method: "POST", body: { phone: "9800000001", grossPaise: 50000, redeem: 139 } });
  assert.equal(overCap.data.error, "TOO_MANY_POINTS", "at most 20% of the bill");

  const second = await bill([{ skuCode: "TOP-001-L", qty: 1 }], asha, { redeem: 100 });
  assert.equal(second.status, 201, JSON.stringify(second.data));
  assert.equal(second.data.order.totals.totalPaise, 129900, "Rs 100 off");
  assert.equal(second.data.order.lines[0].listUnitPaise, 139900);
  assert.equal(second.data.order.discount.pointsUsed, 100);
  assert.equal(second.data.invoice.totals.totalPaise, 129900, "the invoice shows the price paid");
  assert.equal(await points("9800000001"), 139 - 100 + 12);

  const ret = await api(`/api/orders/${second.data.order._id}/returns`, { method: "POST", body: { items: [{ skuCode: "TOP-001-L", qty: 1, reason: "too_big" }], refund: { method: "upi" } } });
  assert.equal(ret.status, 201, JSON.stringify(ret.data));
  assert.equal(await points("9800000001"), 139, "the 100 she paid with back, the 12 earned on it gone");
  assert.equal(await PointsEntry.countDocuments({ kind: "reverse" }), 1);

  const profile = await api(`/api/customers/${contact._id}`);
  assert.equal(profile.status, 200);
  assert.equal(profile.data.stats.orders, 2);
  assert.equal(profile.data.stats.lifetimePaise, 399800, "the returned shirt does not count");
  assert.equal(profile.data.stats.piecesReturned, 1);
  assert.deepEqual(profile.data.fitNotes, ["TOP-001 in L: too big"]);
  assert.equal(profile.data.tier.next.name, "Inner Circle");
  assert.equal(profile.data.tier.next.needPaise, 15_000_00 - 399800);
  assert.equal(profile.data.points.length, 5, "earn, adjust, redeem, earn, reverse");

  const list = await api("/api/customers?q=00001");
  assert.equal(list.data.customers.length, 1);
  assert.equal((await api(`/api/customers/${contact._id}/points`, { method: "POST", body: { points: -1000, note: "oops" } })).data.error, "BELOW_ZERO");
});

test("a friend's code: 10% off her first bill only, 200 points to the friend; never her own code", async () => {
  await seed();
  await bill([{ skuCode: "DRS-001-M", qty: 1 }], asha);
  const code = (await Contact.findOne({ waId: "919800000001" })).loyalty.referralCode;
  const before = await points("9800000001");

  const bina = { name: "Bina", phone: "9800000002" };
  const referred = await bill([{ skuCode: "DRS-001-M", qty: 1 }], bina, { code: code.toLowerCase() });
  assert.equal(referred.status, 201, JSON.stringify(referred.data));
  assert.equal(referred.data.order.totals.totalPaise, 179910);
  assert.equal(referred.data.order.discount.kind, "referral");
  assert.equal(await points("9800000001"), before + 200);
  const binaRecord = await Contact.findOne({ waId: "919800000002" });
  assert.equal(String(binaRecord.loyalty.referredBy), String((await Contact.findOne({ waId: "919800000001" }))._id));

  const again = await bill([{ skuCode: "TOP-001-L", qty: 1 }], bina, { code });
  assert.equal(again.data.error, "NOT_FIRST");
  const own = await bill([{ skuCode: "TOP-001-L", qty: 1 }], asha, { code });
  assert.equal(own.data.error, "OWN_CODE");
  const noPhone = await bill([{ skuCode: "TOP-001-L", qty: 1 }], { name: "Walk-in" }, { code });
  assert.equal(noPhone.data.error, "NEEDS_PHONE");
  const unknown = await bill([{ skuCode: "TOP-001-L", qty: 1 }], bina, { code: "NOPE123" });
  assert.equal(unknown.status, 404);
});

test("creator codes: discount on the bill, a month's statement net of returns, paid once", async () => {
  await seed();
  const created = await api("/api/creators", { method: "POST", body: { name: "Riya Styles", code: "riya10", discountPct: 10, commissionPct: 10, tdsPct: 5 } });
  assert.equal(created.status, 201, JSON.stringify(created.data));
  assert.equal(created.data.creator.code, "RIYA10");
  assert.equal((await api("/api/creators", { method: "POST", body: { name: "Copy", code: "RIYA10", discountPct: 5, commissionPct: 5 } })).status, 409);

  const one = await bill([{ skuCode: "DRS-001-M", qty: 1 }], { name: "Chitra", phone: "9800000003" }, { code: "RIYA10" });
  assert.equal(one.status, 201, JSON.stringify(one.data));
  assert.equal(one.data.order.discount.kind, "creator");
  assert.equal(one.data.order.totals.totalPaise, 179910);
  const two = await bill([{ skuCode: "DRS-001-M", qty: 1 }, { skuCode: "TOP-001-L", qty: 1 }], {}, { code: "RIYA10" });
  assert.equal(two.status, 201, "a creator's code needs no phone");
  await api(`/api/orders/${two.data.order._id}/returns`, { method: "POST", body: { items: [{ skuCode: "TOP-001-L", qty: 1, reason: "changed_mind" }], refund: { method: "cash" } } });

  const month = istDay(new Date()).slice(0, 7);
  const invoices = await Invoice.find({ orderId: mongoose.trusted({ $in: [one.data.order._id, two.data.order._id] }) }).lean();
  const net = invoices.reduce((sum, invoice) => sum + (invoice.kind === "invoice" ? 1 : -1) * invoice.totals.taxablePaise, 0);
  const listed = await api(`/api/creators?month=${month}`);
  const statement = listed.data.creators[0].statement;
  assert.equal(statement.orders, 2);
  assert.equal(statement.netSalesPaise, net, "before GST, less the returned shirt");
  assert.equal(statement.commissionPaise, Math.round(net * 0.1));
  assert.equal(statement.tdsPaise, Math.round(statement.commissionPaise * 0.05));
  assert.equal(statement.payablePaise, statement.commissionPaise - statement.tdsPaise);

  const creatorId = created.data.creator._id;
  const paid = await api(`/api/creators/${creatorId}/payouts`, { method: "POST", body: { month, reference: "UPI 4471" } });
  assert.equal(paid.status, 201, JSON.stringify(paid.data));
  assert.equal(paid.data.payout.paidPaise, statement.payablePaise);
  assert.equal((await api(`/api/creators/${creatorId}/payouts`, { method: "POST", body: { month, reference: "UPI 4471" } })).data.error, "ALREADY_PAID");

  await api(`/api/creators/${creatorId}`, { method: "PATCH", body: { active: false } });
  assert.equal((await bill([{ skuCode: "TOP-001-L", qty: 1 }], { name: "Chitra", phone: "9800000003" }, { code: "RIYA10" })).status, 404, "a paused code no longer works");
});

test("staff record her details and a yes to offers; the owner sets the tiers", async () => {
  await seed();
  const made = await api("/api/customers", { method: "POST", body: { phone: "+91 98000 00009", name: "Dia" } });
  assert.equal(made.status, 201);
  const contactId = made.data.customer._id;
  const patched = await api(`/api/customers/${contactId}`, { method: "PATCH", body: { fit: { usualSize: "m", waist: "28" }, birthday: { day: 14, month: 2 }, offers: true, notes: "likes linen" } });
  assert.equal(patched.status, 200, JSON.stringify(patched.data));
  const contact = await Contact.findById(contactId);
  assert.equal(contact.fit.usualSize, "M");
  assert.equal(contact.birthday.month, 2);
  assert.equal(contact.consents.offers.given, true);
  assert.equal(contact.consents.offers.source, "staff:Owner");

  const badTiers = await api("/api/settings", { method: "PATCH", body: { loyalty: { tiers: [{ name: "Gold", minSpendPaise: 1000, multiplier: 2 }] } } });
  assert.equal(badTiers.status, 400, "one tier must start at Rs 0");
  const tiers = [{ name: "Circle", minSpendPaise: 0, multiplier: 1 }, { name: "Gold", minSpendPaise: 100000, multiplier: 2 }];
  assert.equal((await api("/api/settings", { method: "PATCH", body: { loyalty: { tiers } } })).status, 200);
  await bill([{ skuCode: "DRS-001-M", qty: 1 }], { phone: "9800000009" });
  assert.equal((await Contact.findById(contactId)).loyalty.tier, "Gold");
  assert.equal((await Contact.findById(contactId)).loyalty.points, 39, "Rs 1,999 kept at 2x");
});
