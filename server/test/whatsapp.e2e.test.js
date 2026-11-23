import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import mongoose from "mongoose";
import { createApp } from "../src/app.js";
import { createHandlers } from "../src/handlers.js";
import { drain } from "../src/jobs/runner.js";
import { queueOutbound } from "../src/whatsapp/outbound.js";
import { Contact, Conversation, Job, Message, WebhookEvent } from "../src/models/index.js";
import { connectTestDb, clearCollections, testConfig, startFakeMeta, listen, sign, inboundTextPayload, statusPayload } from "./helpers.js";

let meta;
let config;
let baseUrl;
let server;
let handlers;
// Real time plus an offset, so a test can step past retry delays without waiting.
let offsetMs = 0;
const now = () => new Date(Date.now() + offsetMs);
const advance = (ms) => (offsetMs += ms);

async function postWebhook(payload, { secret = config.WHATSAPP_APP_SECRET, signature } = {}) {
  const raw = Buffer.from(JSON.stringify(payload));
  const response = await fetch(`${baseUrl}/webhooks/whatsapp`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-hub-signature-256": signature ?? sign(raw, secret) },
    body: raw,
  });
  return response.status;
}

test.before(async () => {
  await connectTestDb();
  meta = await startFakeMeta();
  config = testConfig({ META_GRAPH_BASE: meta.baseUrl });
  handlers = createHandlers({ config, now });
  server = http.createServer(createApp({ config }));
  baseUrl = await listen(server);
});

test.beforeEach(async () => {
  await clearCollections();
  meta.requests.length = 0;
  offsetMs = 0;
});

test.after(async () => {
  server?.close();
  await meta.close();
  await mongoose.disconnect();
});

test("Meta's verification handshake answers only with the right token", async () => {
  const ok = await fetch(`${baseUrl}/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=${config.WHATSAPP_VERIFY_TOKEN}&hub.challenge=42`);
  assert.equal(ok.status, 200);
  assert.equal(await ok.text(), "42");
  const wrong = await fetch(`${baseUrl}/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=wrong&hub.challenge=42`);
  assert.equal(wrong.status, 403);
});

test("unsigned or wrongly signed webhooks are refused and nothing is stored", async () => {
  assert.equal(await postWebhook(inboundTextPayload(), { signature: "" }), 401);
  assert.equal(await postWebhook(inboundTextPayload(), { secret: "someone-elses-secret" }), 401);
  assert.equal(await WebhookEvent.countDocuments(), 0);
});

test("an inbound message is stored once, however many times Meta delivers it", async () => {
  const payload = inboundTextPayload({ id: "wamid.in.dup", text: "Do you have Dolo 650?" });
  assert.equal(await postWebhook(payload), 200);
  assert.equal(await postWebhook(payload), 200, "a repeat delivery is acknowledged");
  assert.equal(await WebhookEvent.countDocuments(), 1);
  assert.equal(await Job.countDocuments({ name: "whatsapp.event" }), 1);

  await drain(handlers, { now });
  // Even if the job somehow ran again, nothing doubles.
  const event = await WebhookEvent.findOne();
  await WebhookEvent.updateOne({ _id: event._id }, { $set: { processedAt: null } });
  await handlers["whatsapp.event"]({ eventId: String(event._id) });

  assert.equal(await Message.countDocuments(), 1);
  const contact = await Contact.findOne({ waId: "919800000001" });
  assert.equal(contact.profileName, "Asha");
  const conversation = await Conversation.findOne({ contactId: contact._id });
  assert.equal(conversation.unread, 1, "unread is not counted twice");
  assert.ok(conversation.lastInboundAt);
  const message = await Message.findOne();
  assert.equal(message.text, "Do you have Dolo 650?");
  assert.equal(message.tenantId, "test-hanger");
});

test("a reply is sent through Meta and its delivery reports move it forward, never back", async () => {
  await postWebhook(inboundTextPayload({ id: "wamid.in.2" }));
  await drain(handlers, { now });
  const conversation = await Conversation.findOne();

  const reply = await queueOutbound({ tenantId: config.TENANT_ID }, { conversationId: conversation._id, content: { text: "Yes, available. Shall we deliver?" } });
  assert.equal(reply.status, "queued");
  await drain(handlers, { now });

  assert.equal(meta.requests.length, 1);
  assert.equal(meta.requests[0].url, `/${config.META_GRAPH_VERSION}/${config.WHATSAPP_PHONE_NUMBER_ID}/messages`);
  assert.equal(meta.requests[0].auth, `Bearer ${config.WHATSAPP_ACCESS_TOKEN}`);
  assert.equal(meta.requests[0].body.to, "919800000001");
  const sent = await Message.findById(reply._id);
  assert.equal(sent.status, "sent");
  assert.ok(sent.waMessageId);

  // "read" arrives before "delivered": the message ends at "read".
  await postWebhook(statusPayload({ id: sent.waMessageId, status: "read" }));
  await postWebhook(statusPayload({ id: sent.waMessageId, status: "delivered" }));
  await drain(handlers, { now });
  assert.equal((await Message.findById(reply._id)).status, "read");
});

test("Meta being busy is retried until it works; nothing is lost", async () => {
  await postWebhook(inboundTextPayload({ id: "wamid.in.3" }));
  await drain(handlers, { now });
  const conversation = await Conversation.findOne();
  meta.respondNext(500, { error: { code: 131000, message: "Something went wrong" } });
  meta.respondNext(429, { error: { code: 130429, message: "Rate limit" } });

  const reply = await queueOutbound({ tenantId: config.TENANT_ID }, { conversationId: conversation._id, content: { text: "Your order is confirmed" } });
  await drain(handlers, { now });
  assert.equal((await Message.findById(reply._id)).status, "queued", "waiting to retry");
  advance(60 * 60_000);
  await drain(handlers, { now });
  advance(60 * 60_000);
  await drain(handlers, { now });

  const final = await Message.findById(reply._id);
  assert.equal(final.status, "sent");
  assert.equal(final.sendAttempts, 3);
  assert.equal(meta.requests.length, 3);
});

test("a permanent refusal is saved with the reason in plain words, and not retried", async () => {
  await postWebhook(inboundTextPayload({ id: "wamid.in.4" }));
  await drain(handlers, { now });
  const conversation = await Conversation.findOne();
  meta.respondNext(400, { error: { code: 131026, message: "Message undeliverable" } });

  const reply = await queueOutbound({ tenantId: config.TENANT_ID }, { conversationId: conversation._id, content: { text: "Hello" } });
  await drain(handlers, { now });
  advance(2 * 60 * 60_000);
  await drain(handlers, { now });

  const final = await Message.findById(reply._id);
  assert.equal(final.status, "failed");
  assert.equal(final.error.code, 131026);
  assert.match(final.error.text, /not on WhatsApp/);
  assert.equal(meta.requests.length, 1);
});

test("free text after 24 hours is stopped before calling Meta, with the reason", async () => {
  const old = Math.floor((Date.now() - 25 * 60 * 60_000) / 1000);
  await postWebhook(inboundTextPayload({ id: "wamid.in.5", timestamp: old }));
  await drain(handlers, { now });
  const conversation = await Conversation.findOne();

  const reply = await queueOutbound({ tenantId: config.TENANT_ID }, { conversationId: conversation._id, content: { text: "Hi again" } });
  await drain(handlers, { now });
  const final = await Message.findById(reply._id);
  assert.equal(final.status, "failed");
  assert.equal(final.error.code, 131047);
  assert.equal(meta.requests.length, 0);
});

test("a delivery report that arrives before the send is saved is applied once the send is saved", async () => {
  await postWebhook(inboundTextPayload({ id: "wamid.in.6" }));
  await drain(handlers, { now });
  // Report for an id we have not saved yet.
  await postWebhook(statusPayload({ id: "wamid.out.early", status: "delivered" }));
  await drain(handlers, { now });
  const pending = await Job.findOne({ name: "whatsapp.event", status: "queued" });
  assert.ok(pending, "the report waits instead of being dropped");

  const conversation = await Conversation.findOne();
  const contact = await Contact.findOne();
  await Message.create({ tenantId: config.TENANT_ID, conversationId: conversation._id, contactId: contact._id, direction: "out", type: "text", text: "x", status: "sent", waMessageId: "wamid.out.early" });
  advance(60_000);
  await drain(handlers, { now });
  assert.equal((await Message.findOne({ waMessageId: "wamid.out.early" })).status, "delivered");
});

test("readiness reports the database and the queue", async () => {
  const response = await fetch(`${baseUrl}/ready`);
  const body = await response.json();
  assert.equal(response.status, 200);
  assert.equal(body.database, "ok");
  assert.equal(body.queue.dead, 0);
  assert.equal((await fetch(`${baseUrl}/health`)).status, 200);
  assert.equal((await fetch(`${baseUrl}/nothing-here`)).status, 404);
});
