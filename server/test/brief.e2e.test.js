import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import mongoose from "mongoose";
import { createApp } from "../src/app.js";
import { createServices } from "../src/services.js";
import { withTransaction } from "../src/db.js";
import { createHandlers } from "../src/handlers.js";
import { drain } from "../src/jobs/runner.js";
import { createStyle } from "../src/commerce/catalog.js";
import { receiveStock } from "../src/commerce/stock.js";
import { storeSale } from "../src/commerce/orders.js";
import { answerBriefRequest, briefDue, runMorningBrief } from "../src/commerce/brief.js";
import { createSession } from "../src/auth/sessions.js";
import { hashPassword } from "../src/security/password.js";
import { Contact, Conversation, DailySummary, Location, Message, Settings, User } from "../src/models/index.js";
import { apiClient, clearCollections, connectTestDb, listen, testConfig } from "./helpers.js";

// The owner's morning brief: built from yesterday's sales and today's work, sent once a day on
// WhatsApp (template outside the 24-hour window, the full text inside it or when she replies BRIEF).

const DAY = 86_400_000;
let config;
let server;
let api;
let store;

async function seed() {
  const tenantId = config.TENANT_ID;
  await Settings.create({ tenantId, brandName: "The Hanger", legalName: "The Hanger Western Hub", gstin: "23ABCDE1234F1Z5", stateCode: "23", brief: { enabled: true, hour: 9, phones: ["98000 00999"], template: { name: "morning_brief", language: "en" } } });
  [store] = await Location.create([{ tenantId, code: "ST1", name: "Store", kind: "store", address: "Indore", pincode: "452001", invoicePrefix: "ST1" }]);
  await withTransaction(async (session) => {
    const { style, skus } = await createStyle({ tenantId, data: { code: "DRS-001", name: "Linen midi dress", category: "dresses", pricePaise: 199900, costPaise: 80000, images: ["https://img.test/1.jpg"] }, sizes: ["M"], session });
    style.status = "live";
    style.liveAt = new Date(Date.now() - 30 * DAY);
    await style.save({ session });
    await receiveStock({ tenantId, locationId: store._id, items: [{ sku: skus[0], qty: 2 }], by: "test", session, at: new Date(Date.now() - 30 * DAY) });
  });
  const today = new Date(Date.now() + 330 * 60_000);
  await Contact.create({ tenantId, waId: "919800000011", name: "Asha", birthday: { day: today.getUTCDate(), month: today.getUTCMonth() + 1 } });
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

test("the brief: yesterday's sales, today's work, running out, birthdays; sent once, as a template outside 24 hours", async () => {
  await seed();
  const yesterday = new Date(Date.now() - DAY);
  for (let i = 0; i < 2; i += 1) await withTransaction((session) => storeSale({ tenantId: config.TENANT_ID, locationId: store._id, items: [{ skuCode: "DRS-001-M", qty: 1 }], method: "store_cash", by: "test", session, now: yesterday }));

  const view = await api("/api/brief");
  assert.equal(view.status, 200, JSON.stringify(view.data));
  assert.equal(view.data.brief.sales.netPaise, 399800);
  assert.equal(view.data.brief.sales.bills, 2);
  assert.equal(view.data.brief.stock.runningOut[0].styleCode, "DRS-001", "sold out after selling 2");
  assert.deepEqual(view.data.brief.customers.birthdays.map((row) => row.name), ["Asha"]);
  assert.match(view.data.text, /\*Yesterday:\* Rs 3,998 from 2 bills, 2 pieces/);
  assert.match(view.data.text, /Birthdays today:\* Asha/);
  assert.match(view.data.headline, /^Rs 3,998 from 2 bills, 1 running out$/);
  assert.equal(view.data.sent, null);

  const settings = await Settings.findOne({ tenantId: config.TENANT_ID });
  const nine = new Date(`${new Date(Date.now() + 330 * 60_000).toISOString().slice(0, 10)}T09:00:00+05:30`);
  assert.equal(briefDue(settings, new Date(nine.getTime() - 60_000)), false, "not before 9");
  assert.equal(briefDue(settings, nine), true);

  const first = await runMorningBrief({ tenantId: config.TENANT_ID });
  assert.equal(first.sent.results[0].sent, "template");
  const again = await runMorningBrief({ tenantId: config.TENANT_ID });
  assert.equal(again.already, true, "once a day");
  const sent = await Message.find({ purpose: "brief" });
  assert.equal(sent.length, 1);
  assert.equal(sent[0].template.name, "morning_brief");
  assert.equal(sent[0].template.components[0].parameters[1].text, "Rs 3,998 from 2 bills, 1 running out");
  assert.ok(await DailySummary.findOne({ tenantId: config.TENANT_ID }));

  // She replies BRIEF: the full text, now that she has written. A customer writing BRIEF gets nothing special.
  const owner = await Contact.findOne({ waId: "919800000999" });
  const conversation = await Conversation.findOne({ contactId: owner._id });
  const asked = await withTransaction((session) => answerBriefRequest({ tenantId: config.TENANT_ID, message: { type: "text", text: "Brief" }, contact: owner, conversation, session }));
  assert.equal(asked, true);
  await drain(createHandlers({ config }));
  assert.match((await Message.findOne({ purpose: "brief", type: "text" })).text, /Good morning\. The Hanger/);
  const customer = await Contact.findOne({ waId: "919800000011" });
  assert.equal(await withTransaction((session) => answerBriefRequest({ tenantId: config.TENANT_ID, message: { type: "text", text: "brief" }, contact: customer, conversation, session })), false);

  // Inside the window "send now" sends the text itself.
  await Conversation.updateOne({ _id: conversation._id }, { $set: { lastInboundAt: new Date() } });
  const now = await api("/api/brief/send", { method: "POST", body: {} });
  assert.equal(now.data.results[0].sent, "text");
});
