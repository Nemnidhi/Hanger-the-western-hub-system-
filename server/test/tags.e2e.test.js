import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import mongoose from "mongoose";
import { createApp } from "../src/app.js";
import { createServices } from "../src/services.js";
import { withTransaction } from "../src/db.js";
import { createStyle } from "../src/commerce/catalog.js";
import { codePrefix } from "../src/commerce/codes.js";
import { createSession } from "../src/auth/sessions.js";
import { hashPassword } from "../src/security/password.js";
import { Settings, User } from "../src/models/index.js";
import { apiClient, clearCollections, connectTestDb, listen, testConfig } from "./helpers.js";

// Style codes by category (the number on the price tag) and the price-tag settings.

let config;
let server;
let api;

test.before(async () => {
  await connectTestDb();
  config = testConfig();
});

test.beforeEach(async () => {
  await clearCollections();
  server = http.createServer(createApp({ config, services: createServices(config), logger: { error() {}, warn() {}, info() {} } }));
  const baseUrl = await listen(server);
  const owner = await User.create({ tenantId: config.TENANT_ID, name: "Owner", email: "owner@hanger.test", role: "owner", status: "active", passwordHash: await hashPassword("Owner-password-1"), mustChangePassword: false, twoFactor: { enabled: true } });
  api = apiClient(baseUrl);
  api.setCookie(`hh_session=${await createSession({ user: owner, req: { ip: "", get: () => "" }, twoFactorPending: false })}`);
  await Settings.create({ tenantId: config.TENANT_ID, brandName: "The Hanger" });
});

test.afterEach(() => server.close());
test.after(() => mongoose.disconnect());

test("a new style's code is its category's prefix and the next number", async () => {
  assert.equal(codePrefix("Dresses"), "DRS");
  assert.equal(codePrefix("trousers"), "BTM");
  assert.equal(codePrefix("kurta sets"), "KUR");
  const add = (code, category) => withTransaction((session) => createStyle({ tenantId: config.TENANT_ID, data: { code, name: code, category, pricePaise: 99900 }, sizes: ["M"], session }));
  await add("DRS-001", "dresses");
  await add("DRS-014", "dresses");
  await add("DRS-OLD", "dresses"); // not a number: ignored
  await add("TOP-003", "tops");
  assert.equal((await api("/api/styles/next-code?category=dresses")).data.code, "DRS-015");
  assert.equal((await api("/api/styles/next-code?category=Tops")).data.code, "TOP-004");
  assert.equal((await api("/api/styles/next-code?category=jumpsuits")).data.code, "JMP-001");
  assert.equal((await api("/api/styles/next-code?category=x")).status, 400);
});

test("price-tag settings are saved, and a QR link must be a web address", async () => {
  const saved = await api("/api/settings", { method: "PATCH", body: { tags: { brandLine: "THE HANGER", qrUrl: "https://www.instagram.com/thehanger", footer: "www.thehanger.in", widthMm: 50.8, heightMm: 25.4, showName: false } } });
  assert.equal(saved.status, 200, JSON.stringify(saved.data));
  assert.equal(saved.data.settings.tags.footer, "www.thehanger.in");
  assert.equal(saved.data.settings.tags.showName, false);
  assert.equal((await api("/api/settings", { method: "PATCH", body: { tags: { qrUrl: "javascript:alert(1)" } } })).status, 400);
  assert.equal((await api("/api/settings", { method: "PATCH", body: { tags: { widthMm: 5 } } })).status, 400);
  const cleared = await api("/api/settings", { method: "PATCH", body: { tags: { qrUrl: "" } } });
  assert.equal(cleared.data.settings.tags.qrUrl, "");
  assert.equal(cleared.data.settings.tags.brandLine, "THE HANGER");
});
