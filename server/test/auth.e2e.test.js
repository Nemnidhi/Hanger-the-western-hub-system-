import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import mongoose from "mongoose";
import { createApp } from "../src/app.js";
import { AuditLog, Session, User } from "../src/models/index.js";
import { hashPassword } from "../src/security/password.js";
import { currentStep, totpCode } from "../src/security/totp.js";
import { connectTestDb, clearCollections, testConfig, listen, apiClient } from "./helpers.js";

let config;
let baseUrl;
let server;

async function makeUser({ email, role = "staff", password = "Temporary-pass-1", mustChangePassword = true, status = "active" }) {
  return User.create({ tenantId: config.TENANT_ID, name: email.split("@")[0], email, role, status, passwordHash: await hashPassword(password), mustChangePassword });
}

test.before(async () => {
  await connectTestDb();
  config = testConfig();
  server = http.createServer(createApp({ config }));
  baseUrl = await listen(server);
});
test.beforeEach(clearCollections);
test.after(async () => {
  server?.close();
  await mongoose.disconnect();
});

test("wrong email and wrong password get the same answer; five wrong passwords lock the account", async () => {
  await makeUser({ email: "asha@hanger.test" });
  const api = apiClient(baseUrl);
  const unknown = await api("/api/auth/login", { method: "POST", body: { email: "nobody@hanger.test", password: "whatever-1" } });
  const wrong = await api("/api/auth/login", { method: "POST", body: { email: "asha@hanger.test", password: "whatever-1" } });
  assert.equal(unknown.status, 401);
  assert.equal(wrong.status, 401);
  assert.equal(unknown.data.message, wrong.data.message);

  for (let i = 0; i < 4; i += 1) await api("/api/auth/login", { method: "POST", body: { email: "asha@hanger.test", password: "whatever-1" } });
  const locked = await api("/api/auth/login", { method: "POST", body: { email: "asha@hanger.test", password: "Temporary-pass-1" } });
  assert.equal(locked.status, 429, "even the right password waits out the lock");
  assert.match(locked.data.message, /Try again in 15 minutes/);
  assert.ok(await AuditLog.exists({ action: "auth.login_failed" }));
});

test("a temporary password must be changed before anything else", async () => {
  await makeUser({ email: "ravi@hanger.test" });
  const api = apiClient(baseUrl);
  const login = await api("/api/auth/login", { method: "POST", body: { email: "Ravi@Hanger.test", password: "Temporary-pass-1" } });
  assert.equal(login.status, 200);
  assert.equal(login.data.next, "change_password");
  assert.equal((await api("/api/conversations")).data.error, "PASSWORD_CHANGE_REQUIRED");

  assert.equal((await api("/api/auth/password", { method: "POST", body: { currentPassword: "Temporary-pass-1", newPassword: "short" } })).status, 400);
  assert.equal((await api("/api/auth/password", { method: "POST", body: { currentPassword: "wrong", newPassword: "A-much-better-pass-1" } })).status, 400);
  const changed = await api("/api/auth/password", { method: "POST", body: { currentPassword: "Temporary-pass-1", newPassword: "A-much-better-pass-1" } });
  assert.equal(changed.status, 200);
  assert.equal(changed.data.next, null, "staff do not need two-step login");
  assert.equal((await api("/api/conversations")).status, 200);
});

test("owners must set up two-step login; codes are single-use; recovery codes work once", async () => {
  await makeUser({ email: "owner@hanger.test", role: "owner", password: "Owner-password-1", mustChangePassword: false });
  const api = apiClient(baseUrl);
  const login = await api("/api/auth/login", { method: "POST", body: { email: "owner@hanger.test", password: "Owner-password-1" } });
  assert.equal(login.data.next, "two_factor_setup");
  assert.equal((await api("/api/users")).data.error, "TWO_FACTOR_SETUP_REQUIRED");

  const setup = await api("/api/auth/2fa/setup", { method: "POST", body: {} });
  assert.match(setup.data.otpauthUrl, /^otpauth:\/\/totp\//);
  assert.equal((await api("/api/auth/2fa/enable", { method: "POST", body: { code: "000000" } })).status, 400);
  const step = currentStep();
  const enabled = await api("/api/auth/2fa/enable", { method: "POST", body: { code: totpCode(setup.data.secret, step) } });
  assert.equal(enabled.status, 200);
  assert.equal(enabled.data.recoveryCodes.length, 10);
  assert.equal(enabled.data.next, null);
  assert.equal((await api("/api/users")).status, 200);

  await api("/api/auth/logout", { method: "POST", body: {} });
  const again = await api("/api/auth/login", { method: "POST", body: { email: "owner@hanger.test", password: "Owner-password-1" } });
  assert.equal(again.data.next, "two_factor");
  assert.equal((await api("/api/users")).data.error, "TWO_FACTOR_REQUIRED");
  // The code already used to switch it on cannot be used again.
  assert.equal((await api("/api/auth/2fa/verify", { method: "POST", body: { code: totpCode(setup.data.secret, step) } })).status, 401);
  const passed = await api("/api/auth/2fa/verify", { method: "POST", body: { code: totpCode(setup.data.secret, step + 1) } });
  assert.equal(passed.status, 200);
  assert.equal(passed.data.next, null);

  // Lost phone: a recovery code signs in once.
  await api("/api/auth/logout", { method: "POST", body: {} });
  await api("/api/auth/login", { method: "POST", body: { email: "owner@hanger.test", password: "Owner-password-1" } });
  const [recovery] = enabled.data.recoveryCodes;
  assert.equal((await api("/api/auth/2fa/recovery", { method: "POST", body: { code: recovery } })).status, 200);
  await api("/api/auth/logout", { method: "POST", body: {} });
  await api("/api/auth/login", { method: "POST", body: { email: "owner@hanger.test", password: "Owner-password-1" } });
  assert.equal((await api("/api/auth/2fa/recovery", { method: "POST", body: { code: recovery } })).status, 401);

  const stored = await User.findOne({ email: "owner@hanger.test" });
  assert.ok(stored.twoFactor.secretEnc.startsWith("v1:"), "the secret is stored encrypted");
  assert.equal(stored.twoFactor.recoveryCodeHashes.length, 9);
});

test("requests without the app header are refused (cross-site protection)", async () => {
  await makeUser({ email: "staff@hanger.test", mustChangePassword: false });
  const api = apiClient(baseUrl);
  const refused = await api("/api/auth/login", { method: "POST", body: { email: "staff@hanger.test", password: "Temporary-pass-1" }, appHeader: false });
  assert.equal(refused.status, 403);
});

test("the owner manages the team; staff cannot; disabling someone signs them out at once", async () => {
  await makeUser({ email: "staff@hanger.test", mustChangePassword: false });
  const staff = apiClient(baseUrl);
  await staff("/api/auth/login", { method: "POST", body: { email: "staff@hanger.test", password: "Temporary-pass-1" } });
  assert.equal((await staff("/api/users")).status, 403);

  const owner = await makeUser({ email: "owner@hanger.test", role: "owner", mustChangePassword: false });
  await User.updateOne({ _id: owner._id }, { $set: { "twoFactor.enabled": true } });
  const ownerApi = apiClient(baseUrl);
  const { createSession } = await import("../src/auth/sessions.js");
  const token = await createSession({ user: owner, req: { ip: "", get: () => "" }, twoFactorPending: false });
  ownerApi.setCookie(`hh_session=${token}`);

  const created = await ownerApi("/api/users", { method: "POST", body: { name: "Packer One", email: "packer@hanger.test", role: "packer" } });
  assert.equal(created.status, 201);
  assert.ok(created.data.temporaryPassword.length >= 12);
  assert.equal((await ownerApi("/api/users", { method: "POST", body: { name: "Again", email: "packer@hanger.test", role: "packer" } })).status, 409);

  const staffUser = await User.findOne({ email: "staff@hanger.test" });
  await ownerApi(`/api/users/${staffUser._id}`, { method: "PATCH", body: { status: "disabled" } });
  assert.equal((await staff("/api/conversations")).status, 401);
  assert.equal(await Session.countDocuments({ userId: staffUser._id }), 0);

  assert.equal((await ownerApi(`/api/users/${owner._id}`, { method: "PATCH", body: { role: "staff" } })).status, 409, "the last owner stays an owner");
  assert.ok(await AuditLog.exists({ action: "user.updated" }));
});

test("packers cannot open the inbox", async () => {
  await makeUser({ email: "packer@hanger.test", role: "packer", mustChangePassword: false });
  const api = apiClient(baseUrl);
  await api("/api/auth/login", { method: "POST", body: { email: "packer@hanger.test", password: "Temporary-pass-1" } });
  assert.equal((await api("/api/conversations")).status, 403);
});
