import express from "express";
import mongoose from "mongoose";
import { z } from "zod";
import { Contact, InstagramComment, InstagramMessage, InstagramThread, Order } from "../models/index.js";
import { requireAuth, requirePermission } from "../auth/middleware.js";
import { withTransaction } from "../db.js";
import { audit } from "../audit.js";
import { httpError, parseBody, route } from "./validate.js";
import { igReplyWindowOpen, queueInstagramMessage } from "../instagram/instagram.js";
import { waIdFromPhone } from "../commerce/picks.js";

// The Instagram inbox in the staff app: threads, messages, replies inside Instagram's 24 hours, linking
// a thread to a customer by phone, and the comments the keyword rules answered.
export function createInstagramRouter({ config }) {
  const router = express.Router();
  const tenantId = config.TENANT_ID;
  const read = [requireAuth(), requirePermission("inbox:read")];
  const write = [requireAuth(), requirePermission("inbox:write")];
  const connected = Boolean(config.INSTAGRAM_ACCOUNT_ID && config.INSTAGRAM_ACCESS_TOKEN);

  const view = (thread, last, now = new Date()) => ({
    id: String(thread._id),
    username: thread.username,
    name: thread.name,
    phone: thread.phone,
    contactId: thread.contactId ? String(thread.contactId) : null,
    status: thread.status,
    unread: thread.unread,
    lastMessageAt: thread.lastMessageAt,
    windowOpen: igReplyWindowOpen(thread, now),
    windowEndsAt: thread.lastInboundAt ? new Date(new Date(thread.lastInboundAt).getTime() + 24 * 60 * 60 * 1000) : null,
    last: last ? { direction: last.direction, text: String(last.text || (last.attachments?.[0]?.type ? `[${last.attachments[0].type}]` : "")).slice(0, 140), kind: last.kind } : null,
  });

  async function loadThread(req) {
    if (!mongoose.isValidObjectId(req.params.id)) throw httpError(404, "Thread not found");
    const thread = await InstagramThread.findOne({ _id: req.params.id, tenantId });
    if (!thread) throw httpError(404, "Thread not found");
    return thread;
  }

  router.get("/api/instagram/threads", ...read, route(async (req, res) => {
    const status = req.query.status === "closed" ? "closed" : "open";
    const threads = await InstagramThread.find({ tenantId, status }).sort({ lastMessageAt: -1 }).limit(100).lean();
    const out = [];
    for (const thread of threads) {
      const last = await InstagramMessage.findOne({ threadId: thread._id }).sort({ at: -1 }).lean();
      out.push(view(thread, last));
    }
    res.json({ connected, threads: out });
  }));

  router.get("/api/instagram/threads/:id", ...read, route(async (req, res) => {
    const thread = await loadThread(req);
    const messages = await InstagramMessage.find({ threadId: thread._id }).sort({ at: -1 }).limit(200).lean();
    const orders = thread.contactId ? await Order.find({ tenantId, contactId: thread.contactId, status: mongoose.trusted({ $ne: "draft" }) }).sort({ createdAt: -1 }).limit(5).select("number status totals createdAt channel").lean() : [];
    res.json({
      connected,
      thread: view(thread),
      messages: messages.reverse().map((message) => ({ id: String(message._id), direction: message.direction, kind: message.kind, text: message.text, attachments: message.attachments, status: message.status, error: message.error, sentBy: message.sentBy, at: message.at })),
      orders: orders.map((order) => ({ id: String(order._id), number: order.number, status: order.status, totalPaise: order.totals.totalPaise, at: order.createdAt, channel: order.channel })),
    });
  }));

  router.post("/api/instagram/threads/:id/messages", ...write, route(async (req, res) => {
    const thread = await loadThread(req);
    const body = parseBody(z.object({ text: z.string().trim().min(1).max(1000) }), req);
    if (!connected) throw httpError(409, "Instagram is not connected on the server yet.", "NOT_CONNECTED");
    if (!igReplyWindowOpen(thread)) throw httpError(409, "Instagram allows replies only within 24 hours of her last message. Reply from the Instagram app, or wait for her to write again.", "WINDOW_CLOSED");
    const message = await withTransaction((session) => queueInstagramMessage({ tenantId, thread, text: body.text, sentBy: req.user.name || "staff", session }));
    await audit({ req, action: "instagram.reply", targetType: "instagram_thread", targetId: thread._id });
    res.status(202).json({ id: String(message._id) });
  }));

  router.post("/api/instagram/threads/:id/read", ...read, route(async (req, res) => {
    const thread = await loadThread(req);
    await InstagramThread.updateOne({ _id: thread._id }, { $set: { unread: 0 } });
    res.json({ ok: true });
  }));

  router.patch("/api/instagram/threads/:id", ...write, route(async (req, res) => {
    const thread = await loadThread(req);
    const body = parseBody(z.object({ status: z.enum(["open", "closed"]).optional(), phone: z.string().trim().max(20).optional() }), req);
    const set = {};
    if (body.status) set.status = body.status;
    if (body.phone !== undefined) {
      if (!body.phone) Object.assign(set, { phone: "", contactId: null });
      else {
        const waId = waIdFromPhone(body.phone);
        if (!waId) throw httpError(400, "That does not look like a mobile number.", "BAD_PHONE");
        const contact = await Contact.findOne({ tenantId, waId });
        Object.assign(set, { phone: waId, contactId: contact?._id || null });
      }
    }
    await InstagramThread.updateOne({ _id: thread._id }, { $set: set });
    await audit({ req, action: "instagram.thread_updated", targetType: "instagram_thread", targetId: thread._id, meta: { status: body.status, linked: Boolean(set.contactId) } });
    res.json({ thread: view(await InstagramThread.findById(thread._id)) });
  }));

  router.get("/api/instagram/comments", ...read, route(async (req, res) => {
    const comments = await InstagramComment.find({ tenantId }).sort({ at: -1 }).limit(100).lean();
    res.json({ connected, comments: comments.map((comment) => ({ id: String(comment._id), username: comment.username, text: comment.text, at: comment.at, keyword: comment.keyword, mediaId: comment.mediaId, privateReply: comment.privateReply, publicReply: comment.publicReply })) });
  }));

  return router;
}
