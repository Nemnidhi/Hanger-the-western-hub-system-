import express from "express";
import mongoose from "mongoose";
import { Readable } from "node:stream";
import { z } from "zod";
import { Contact, Conversation, Message, Template, User } from "../models/index.js";
import { requireAuth, requirePermission } from "../auth/middleware.js";
import { queueOutbound } from "../whatsapp/outbound.js";
import { templatePayload } from "../whatsapp/templates.js";
import { describeMetaError } from "../whatsapp/metaErrors.js";
import { enqueue } from "../jobs/queue.js";
import { audit } from "../audit.js";
import { httpError, parseBody, route } from "./validate.js";

const DAY_MS = 24 * 60 * 60 * 1000;

const idParam = (value) => {
  if (!mongoose.isValidObjectId(value)) throw httpError(404, "Not found.", "NOT_FOUND");
  return value;
};

/** Whether free-form replies are allowed (Meta's 24 hours after the customer's last message). */
export function replyWindow(lastInboundAt, now = new Date()) {
  if (!lastInboundAt) return { open: false, closesAt: null };
  const closesAt = new Date(new Date(lastInboundAt).getTime() + DAY_MS);
  return { open: closesAt > now, closesAt };
}

export function serializeMessage(message) {
  return {
    id: String(message._id),
    direction: message.direction,
    type: message.type,
    text: message.text,
    template: message.template ? { name: message.template.name } : null,
    media: message.media?.id ? { mimeType: message.media.mimeType, caption: message.media.caption, filename: message.media.filename } : null,
    location: message.type === "location" ? message.data : null,
    status: message.status,
    purpose: message.purpose || "chat",
    error: message.error?.text ? message.error : null,
    at: message.direction === "in" ? message.at : message.createdAt,
    sentAt: message.sentAt,
    // Voice notes: "done" when the text shown is Sarvam's transcript; "too_long"/"failed": listen to it.
    transcript: message.data?.transcriptStatus || null,
  };
}

function serializeConversation(conversation, contact, lastMessage, now) {
  return {
    id: String(conversation._id),
    contact: contact ? { id: String(contact._id), name: contact.profileName || "", waId: contact.waId } : null,
    status: conversation.status,
    assignedTo: conversation.assignedTo || "",
    unread: conversation.unread,
    lastMessageAt: conversation.lastMessageAt,
    window: replyWindow(conversation.lastInboundAt, now),
    // The WhatsApp stylist: quiet in this chat until this time (handed over or turned off), and why.
    stylistOffUntil: conversation.stylistOffUntil && conversation.stylistOffUntil > now ? conversation.stylistOffUntil : null,
    stylistNote: conversation.stylistOffUntil && conversation.stylistOffUntil > now ? conversation.stylistNote || "" : "",
    lastMessage: lastMessage
      ? { direction: lastMessage.direction, type: lastMessage.type, text: String(lastMessage.text || "").slice(0, 140), status: lastMessage.status }
      : null,
  };
}

function escapeRegex(text) {
  return String(text).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function createInboxRouter({ config, logger, client, realtime }) {
  const router = express.Router();
  const read = [requireAuth(), requirePermission("inbox:read")];
  const write = [requireAuth(), requirePermission("inbox:write")];

  router.get("/api/events", ...read, (req, res) => realtime.connect(req, res));

  // Names for the "assign to" list; the full team page (emails, resets) stays owner-only.
  router.get(
    "/api/team",
    ...read,
    route(async (req, res) => {
      const users = await User.find({ tenantId: req.tenantId, status: "active", role: mongoose.trusted({ $ne: "rider" }) }).sort({ name: 1 }).select("name role");
      res.json({ data: users.map((user) => ({ id: String(user._id), name: user.name, role: user.role })) });
    }),
  );

  router.get(
    "/api/conversations",
    ...read,
    route(async (req, res) => {
      const query = z
        .object({
          status: z.enum(["open", "waiting", "closed", "all"]).optional().default("all"),
          unread: z.enum(["1", "0"]).optional(),
          mine: z.enum(["1", "0"]).optional(),
          q: z.string().trim().max(60).optional(),
          before: z.iso.datetime().optional(),
          limit: z.coerce.number().int().min(1).max(100).optional().default(30),
        })
        .parse(req.query);
      const filter = { tenantId: req.tenantId };
      if (query.status !== "all") filter.status = query.status;
      if (query.unread === "1") filter.unread = mongoose.trusted({ $gt: 0 });
      if (query.mine === "1") filter.assignedTo = String(req.user._id);
      if (query.before) filter.lastMessageAt = mongoose.trusted({ $lt: new Date(query.before) });
      if (query.q) {
        const pattern = new RegExp(escapeRegex(query.q), "i");
        const contacts = await Contact.find({ tenantId: req.tenantId, $or: [{ profileName: pattern }, { waId: pattern }] }).select("_id").limit(200);
        filter.contactId = mongoose.trusted({ $in: contacts.map((contact) => contact._id) });
      }
      const conversations = await Conversation.find(filter).sort({ lastMessageAt: -1, _id: -1 }).limit(query.limit + 1);
      const page = conversations.slice(0, query.limit);
      const [contacts, lastMessages] = await Promise.all([
        Contact.find({ _id: mongoose.trusted({ $in: page.map((row) => row.contactId) }) }),
        Promise.all(page.map((row) => Message.findOne({ conversationId: row._id }).sort({ at: -1, _id: -1 }))),
      ]);
      const contactById = new Map(contacts.map((contact) => [String(contact._id), contact]));
      const now = new Date();
      res.json({
        data: page.map((row, index) => serializeConversation(row, contactById.get(String(row.contactId)), lastMessages[index], now)),
        hasMore: conversations.length > query.limit,
      });
    }),
  );

  async function loadConversation(req) {
    const conversation = await Conversation.findOne({ _id: idParam(req.params.id), tenantId: req.tenantId });
    if (!conversation) throw httpError(404, "Chat not found.", "NOT_FOUND");
    return conversation;
  }

  router.get(
    "/api/conversations/:id",
    ...read,
    route(async (req, res) => {
      const conversation = await loadConversation(req);
      const contact = await Contact.findById(conversation.contactId);
      res.json({ data: serializeConversation(conversation, contact, null, new Date()) });
    }),
  );

  router.get(
    "/api/conversations/:id/messages",
    ...read,
    route(async (req, res) => {
      const conversation = await loadConversation(req);
      const query = z.object({ before: z.iso.datetime().optional(), limit: z.coerce.number().int().min(1).max(200).optional().default(50) }).parse(req.query);
      const filter = { conversationId: conversation._id };
      if (query.before) filter.at = mongoose.trusted({ $lt: new Date(query.before) });
      const rows = await Message.find(filter).sort({ at: -1, _id: -1 }).limit(query.limit + 1);
      const page = rows.slice(0, query.limit).reverse();
      res.json({ data: page.map(serializeMessage), hasMore: rows.length > query.limit });
    }),
  );

  router.post(
    "/api/conversations/:id/messages",
    ...write,
    route(async (req, res) => {
      const conversation = await loadConversation(req);
      const body = parseBody(
        z.union([
          z.object({ text: z.string().trim().min(1).max(4096) }),
          z.object({ template: z.object({ name: z.string().min(1).max(512), language: z.string().min(2).max(15), params: z.array(z.string().max(1000)).max(20).optional().default([]) }) }),
        ]),
        req,
      );

      let content;
      if ("text" in body) {
        // Refused here, at once, rather than after a trip to Meta.
        if (!replyWindow(conversation.lastInboundAt).open) {
          const reason = describeMetaError(131047);
          throw httpError(409, `${reason.label}. ${reason.action}`, "WINDOW_CLOSED");
        }
        content = { text: body.text };
      } else {
        const template = await Template.findOne({ tenantId: req.tenantId, name: body.template.name, language: body.template.language });
        if (!template || template.status !== "APPROVED") throw httpError(409, "This template is not approved by Meta.", "TEMPLATE_NOT_APPROVED");
        if (body.template.params.length !== template.paramCount) throw httpError(400, `This template needs ${template.paramCount} value(s).`, "TEMPLATE_PARAMS");
        content = { template: templatePayload(template, body.template.params) };
      }

      const message = await queueOutbound({ tenantId: req.tenantId }, { conversationId: conversation._id, content });
      await audit({ req, action: "message.queued", targetType: "conversation", targetId: conversation._id, meta: { messageId: String(message._id), type: message.type, template: content.template?.name }, logger });
      res.status(202).json({ data: serializeMessage(message) });
    }),
  );

  router.post(
    "/api/conversations/:id/read",
    ...read,
    route(async (req, res) => {
      const conversation = await loadConversation(req);
      await Conversation.updateOne({ _id: conversation._id }, { $set: { unread: 0 } });
      res.json({ ok: true });
    }),
  );

  router.patch(
    "/api/conversations/:id",
    ...write,
    route(async (req, res) => {
      const conversation = await loadConversation(req);
      const body = parseBody(z.object({ status: z.enum(["open", "waiting", "closed"]).optional(), assignedTo: z.string().max(40).optional(), stylist: z.enum(["on", "off"]).optional() }), req);
      if (body.assignedTo) {
        const assignee = mongoose.isValidObjectId(body.assignedTo) && (await User.findOne({ _id: body.assignedTo, tenantId: req.tenantId, status: "active" }));
        if (!assignee) throw httpError(400, "That person is not on the team.", "BAD_ASSIGNEE");
      }
      const { stylist, ...fields } = body;
      // Off: quiet in this chat for 30 days (staff are handling it); on: it may answer again now.
      if (stylist) Object.assign(fields, stylist === "off" ? { stylistOffUntil: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000), stylistNote: `turned off by ${req.user.name || "staff"}` } : { stylistOffUntil: null, stylistNote: "" });
      await Conversation.updateOne({ _id: conversation._id }, { $set: fields });
      await audit({ req, action: "conversation.updated", targetType: "conversation", targetId: conversation._id, meta: body, logger });
      const fresh = await Conversation.findById(conversation._id);
      const contact = await Contact.findById(fresh.contactId);
      res.json({ data: serializeConversation(fresh, contact, null, new Date()) });
    }),
  );

  // A customer's photo, document or voice note, streamed from Meta to the signed-in staff member.
  router.get(
    "/api/messages/:id/media",
    ...read,
    route(async (req, res) => {
      const message = await Message.findOne({ _id: idParam(req.params.id), tenantId: req.tenantId });
      if (!message?.media?.id) throw httpError(404, "No file on this message.", "NOT_FOUND");
      const media = await client.downloadMedia(message.media.id);
      await audit({ req, action: "media.viewed", targetType: "message", targetId: message._id, logger });
      res.set({ "Content-Type": media.mimeType, "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff", "Content-Disposition": "inline" });
      Readable.fromWeb(media.response.body).pipe(res);
    }),
  );

  router.get(
    "/api/templates",
    requireAuth(),
    requirePermission("templates:read"),
    route(async (req, res) => {
      const templates = await Template.find({ tenantId: req.tenantId, status: mongoose.trusted({ $ne: "DELETED" }) }).sort({ name: 1 });
      res.json({
        data: templates.map((template) => ({
          name: template.name,
          language: template.language,
          category: template.category,
          status: template.status,
          bodyText: template.bodyText,
          paramCount: template.paramCount,
          rejectedReason: template.rejectedReason,
        })),
        canSync: Boolean(config.WHATSAPP_BUSINESS_ACCOUNT_ID),
      });
    }),
  );

  router.post(
    "/api/templates/sync",
    requireAuth(),
    requirePermission("templates:sync"),
    route(async (req, res) => {
      if (!config.WHATSAPP_BUSINESS_ACCOUNT_ID) throw httpError(400, "Add WHATSAPP_BUSINESS_ACCOUNT_ID to the server settings first.", "NOT_CONFIGURED");
      await enqueue("whatsapp.syncTemplates", {});
      await audit({ req, action: "templates.sync_requested", logger });
      res.status(202).json({ ok: true });
    }),
  );

  return router;
}
