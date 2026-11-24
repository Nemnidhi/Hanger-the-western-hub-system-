import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import path from "node:path";
import { readFile } from "node:fs/promises";
import mongoose from "mongoose";
import { createApp } from "../src/app.js";
import { createHandlers } from "../src/handlers.js";
import { createServices } from "../src/services.js";
import { drain } from "../src/jobs/runner.js";
import { withTransaction } from "../src/db.js";
import { createStyle } from "../src/commerce/catalog.js";
import { createSession } from "../src/auth/sessions.js";
import { hashPassword } from "../src/security/password.js";
import { RetryableError } from "../src/jobs/queue.js";
import { Settings, Sku, Style, StudioJob, User } from "../src/models/index.js";
import { apiClient, clearCollections, connectTestDb, listen, testConfig } from "./helpers.js";

// The photo studio through the API and the job queue, with stand-ins for Photoroom and Claude.

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from("plain photo of a dress")]);
let config;
let offsetMs = 0;
const now = () => new Date(Date.now() + offsetMs);
const behaviour = { imageFailures: {}, copyFailure: null, calls: [] };

const fakeImages = {
  name: "fake-photoroom",
  async render({ image, kind, backdrop }) {
    behaviour.calls.push({ kind, backdrop, bytes: image.buffer.length });
    const failure = behaviour.imageFailures[kind];
    if (failure?.times > 0) {
      failure.times -= 1;
      throw failure.error;
    }
    return { buffer: Buffer.from(`${kind}:${image.buffer.toString("latin1")}`, "latin1"), mediaType: "image/png" };
  },
};
const fakeCopywriter = {
  name: "fake-claude",
  async write({ images, context }) {
    behaviour.calls.push({ copy: images.length, context });
    if (behaviour.copyFailure) {
      const error = behaviour.copyFailure;
      behaviour.copyFailure = null;
      throw error;
    }
    return {
      name: "Satin slip dress", category: "dresses", outfitPart: "dress", colour: "wine", pattern: "solid", fabricLooksLike: "satin-finish", neckline: "cowl", sleeve: "strappy", fit: "bias cut",
      occasion: ["date", "party"], websiteDescription: "A wine slip dress cut on the bias.", highlights: ["Bias cut", "Cowl neck"], instagramCaption: "Date night, sorted.\nDM us to order.",
      hashtags: [...context.hashtags, "SlipDress"], altText: "A wine satin slip dress", toCheck: ["Fabric: looks like satin, please confirm"], writtenBy: "fake-claude",
    };
  },
};

function start(services) {
  const handlers = createHandlers({ config, now, services });
  const server = http.createServer(createApp({ config, services, logger: { error: (info, message) => console.error(message, info?.err?.stack || info?.err?.message), warn() {}, info() {} } }));
  return { handlers, server };
}

async function signedIn(baseUrl) {
  const owner = await User.create({ tenantId: config.TENANT_ID, name: "Owner", email: "owner@hanger.test", role: "owner", status: "active", passwordHash: await hashPassword("Owner-password-1"), mustChangePassword: false, twoFactor: { enabled: true } });
  const api = apiClient(baseUrl);
  api.setCookie(`hh_session=${await createSession({ user: owner, req: { ip: "", get: () => "" }, twoFactorPending: false })}`);
  return api;
}

async function upload(baseUrl, api) {
  const response = await fetch(`${baseUrl}/api/uploads`, { method: "POST", headers: { "x-hanger-app": "1", "content-type": "image/png", cookie: api.cookie() }, body: PNG });
  assert.equal(response.status, 201);
  return (await response.json()).url;
}

let app;
let baseUrl;
let api;

test.before(async () => {
  await connectTestDb();
  config = testConfig();
});

test.beforeEach(async () => {
  await clearCollections();
  offsetMs = 0;
  behaviour.imageFailures = {};
  behaviour.copyFailure = null;
  behaviour.calls.length = 0;
  app = start({ ...createServices(config), studioImages: fakeImages, copywriter: fakeCopywriter });
  baseUrl = await listen(app.server);
  api = await signedIn(baseUrl);
  await Settings.create({ tenantId: config.TENANT_ID, brandName: "The Hanger" });
});

test.afterEach(() => app.server.close());
test.after(() => mongoose.disconnect());

test("a plain photo becomes shop photos and a write-up, then goes on a new draft style", async () => {
  await api("/api/settings", { method: "PATCH", body: { studio: { backdrop: "#e8d9f0", hashtags: ["TheHangerIndore", "#IndoreStyle"], voice: "Warm, simple" } } });
  const photo = await upload(baseUrl, api);
  const started = await api("/api/studio/jobs", { method: "POST", body: { images: [photo], notes: "rayon, Rs 2,499", extras: { model: true } } });
  assert.equal(started.status, 201, JSON.stringify(started.data));
  assert.equal(started.data.job.status, "working");
  assert.deepEqual(started.data.job.outputs.map((output) => output.kind), ["white", "studio", "model"]);

  await drain(app.handlers, { now });
  const { job } = (await api(`/api/studio/jobs/${started.data.job._id}`)).data;
  assert.equal(job.status, "ready");
  assert.ok(job.outputs.every((output) => output.status === "done"));
  assert.equal(job.outputs.find((output) => output.kind === "model").generated, true);
  assert.equal(behaviour.calls.find((call) => call.kind === "studio").backdrop, "E8D9F0");
  // The made photo is saved and served like any upload.
  const white = job.outputs.find((output) => output.kind === "white");
  const served = await fetch(`${baseUrl}${new URL(white.url).pathname}`);
  assert.equal(served.status, 200);
  assert.match(await served.text(), /^white:/);
  // The write-up had the brand's hashtags and the staff notes.
  assert.equal(job.copy.name, "Satin slip dress");
  const copyCall = behaviour.calls.find((call) => call.copy);
  assert.deepEqual(copyCall.context.hashtags, ["TheHangerIndore", "IndoreStyle"]);
  assert.equal(copyCall.context.notes, "rayon, Rs 2,499");
  assert.equal(copyCall.context.voice, "Warm, simple");

  const applied = await api(`/api/studio/jobs/${job._id}/apply`, {
    method: "POST",
    body: {
      newStyle: { code: "drs-014", sizes: ["S", "M", "L"], price: 2499 },
      images: [white.url, job.outputs.find((output) => output.kind === "studio").url],
      name: "Satin slip dress", category: "dresses", description: job.copy.websiteDescription, outfitPart: "dress", highlights: job.copy.highlights,
      instagramCaption: job.copy.instagramCaption, hashtags: ["#TheHangerIndore", "SlipDress"], altText: job.copy.altText, attributes: { colour: "wine", fabric: "rayon", occasion: ["date"] },
    },
  });
  assert.equal(applied.status, 200, JSON.stringify(applied.data));
  const style = await Style.findOne({ code: "DRS-014" });
  assert.equal(style.status, "draft");
  assert.equal(style.pricePaise, 249900);
  assert.deepEqual(style.images, [white.url, job.outputs.find((output) => output.kind === "studio").url]);
  assert.equal(style.attributes.fabric, "rayon");
  assert.deepEqual(style.social.hashtags, ["TheHangerIndore", "SlipDress"]);
  assert.equal(await Sku.countDocuments({ styleId: style._id }), 3);
  assert.equal(String((await StudioJob.findById(job._id)).appliedTo), String(style._id));
});

test("apply to an existing style puts the chosen photos first and refuses photos from elsewhere", async () => {
  const { style } = await withTransaction((session) => createStyle({ tenantId: config.TENANT_ID, data: { code: "TOP-040", name: "Poplin shirt", category: "tops", pricePaise: 139900, images: ["http://localhost:4200/media/old.jpg"] }, sizes: ["S", "M"], session }));
  const photo = await upload(baseUrl, api);
  const started = await api("/api/studio/jobs", { method: "POST", body: { images: [photo], styleId: String(style._id) } });
  await drain(app.handlers, { now });
  // The style's price and sizes went to the copywriter.
  const copyCall = behaviour.calls.find((call) => call.copy);
  assert.equal(copyCall.context.price, "Rs 1,399");
  assert.deepEqual(copyCall.context.sizes.sort(), ["M", "S"]);
  const job = (await api(`/api/studio/jobs/${started.data.job._id}`)).data.job;
  const studio = job.outputs.find((output) => output.kind === "studio").url;

  const foreign = await api(`/api/studio/jobs/${job._id}/apply`, { method: "POST", body: { styleId: String(style._id), images: ["https://elsewhere.test/a.jpg"] } });
  assert.equal(foreign.status, 400);
  const both = await api(`/api/studio/jobs/${job._id}/apply`, { method: "POST", body: { images: [studio] } });
  assert.equal(both.status, 400);

  const applied = await api(`/api/studio/jobs/${job._id}/apply`, { method: "POST", body: { styleId: String(style._id), images: [studio], description: "New words", instagramCaption: "Hello" } });
  assert.equal(applied.status, 200, JSON.stringify(applied.data));
  const fresh = await Style.findById(style._id);
  assert.deepEqual(fresh.images, [studio, "http://localhost:4200/media/old.jpg"]);
  assert.equal(fresh.description, "New words");
  assert.equal(fresh.social.instagramCaption, "Hello");
  assert.equal(fresh.name, "Poplin shirt");
});

test("a busy service is retried, a refusal is shown with its reason, and failed parts can be run again", async () => {
  behaviour.imageFailures.studio = { times: 2, error: new RetryableError("Photoroom is busy") };
  behaviour.copyFailure = Object.assign(new Error("Claude declined to describe this photo"), { permanent: true });
  const photo = await upload(baseUrl, api);
  const started = await api("/api/studio/jobs", { method: "POST", body: { images: [photo] } });
  const id = started.data.job._id;
  for (let step = 0; step < 4; step += 1) {
    await drain(app.handlers, { now });
    offsetMs += 10 * 60_000;
  }
  let job = (await api(`/api/studio/jobs/${id}`)).data.job;
  assert.equal(job.outputs.find((output) => output.kind === "studio").status, "done");
  assert.equal(job.copyStatus, "failed");
  assert.match(job.copyError, /declined/);
  assert.equal(job.status, "ready");

  const retried = await api(`/api/studio/jobs/${id}/retry`, { method: "POST", body: {} });
  assert.equal(retried.status, 200);
  await drain(app.handlers, { now });
  job = (await api(`/api/studio/jobs/${id}`)).data.job;
  assert.equal(job.copyStatus, "done");
  assert.equal((await api(`/api/studio/jobs/${id}/retry`, { method: "POST", body: {} })).status, 409);
});

test("store staff can use the studio and make a draft style, but not change an existing style", async () => {
  const { style } = await withTransaction((session) => createStyle({ tenantId: config.TENANT_ID, data: { code: "TOP-041", name: "Linen shirt", category: "tops", pricePaise: 149900 }, sizes: ["M"], session }));
  const staff = await User.create({ tenantId: config.TENANT_ID, name: "Riya", email: "riya@hanger.test", role: "staff", status: "active", passwordHash: await hashPassword("Staff-password-1"), mustChangePassword: false });
  const client = apiClient(baseUrl);
  client.setCookie(`hh_session=${await createSession({ user: staff, req: { ip: "", get: () => "" }, twoFactorPending: false })}`);
  const photo = await upload(baseUrl, client);
  const started = await client("/api/studio/jobs", { method: "POST", body: { images: [photo] } });
  assert.equal(started.status, 201, JSON.stringify(started.data));
  await drain(app.handlers, { now });
  const job = (await client(`/api/studio/jobs/${started.data.job._id}`)).data.job;
  const white = job.outputs.find((output) => output.kind === "white").url;
  const existing = await client(`/api/studio/jobs/${job._id}/apply`, { method: "POST", body: { styleId: String(style._id), images: [white] } });
  assert.equal(existing.status, 403);
  const draft = await client(`/api/studio/jobs/${job._id}/apply`, { method: "POST", body: { newStyle: { code: "TOP-042", sizes: ["S", "M"], price: 1299 }, images: [white], name: "Linen shirt, sky" } });
  assert.equal(draft.status, 200, JSON.stringify(draft.data));
  assert.equal(draft.data.style.status, "draft");
  // Store staff still cannot edit the catalogue directly.
  assert.equal((await client(`/api/styles/${style._id}`, { method: "PATCH", body: { name: "Changed" } })).status, 403);
});

test("without the photo and write-up services the studio says so; only the shop's uploads are accepted", async () => {
  app.server.close();
  app = start({ ...createServices(config), studioImages: null, copywriter: null });
  baseUrl = await listen(app.server);
  api.setCookie(api.cookie());
  const client = apiClient(baseUrl);
  client.setCookie(api.cookie());
  const status = await client("/api/studio/status");
  assert.deepEqual(status.data, { images: null, copy: null });
  const photo = await upload(baseUrl, client);
  const started = await client("/api/studio/jobs", { method: "POST", body: { images: [photo] } });
  assert.equal(started.data.job.copyStatus, "skipped");
  assert.ok(started.data.job.outputs.every((output) => output.status === "skipped"));
  assert.equal(started.data.job.status, "ready");

  const outside = await client("/api/studio/jobs", { method: "POST", body: { images: ["https://elsewhere.test/media/abc.jpg"] } });
  assert.equal(outside.status, 400);
  const missing = await client("/api/studio/jobs", { method: "POST", body: { images: [`${baseUrl}/media/0000000000.png`] } });
  assert.equal(missing.status, 400);
  // The upload itself is still the original photo.
  const media = new URL(photo).pathname.replace("/media/", "");
  assert.deepEqual(await readFile(path.join(path.resolve(config.UPLOAD_DIR), media)), PNG);
});
