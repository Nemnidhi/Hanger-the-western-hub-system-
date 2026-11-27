import mongoose from "mongoose";
import { Contact, Conversation, Message, STATUS_RANK, WebhookEvent } from "../models/index.js";
import { enqueue, RetryableError } from "../jobs/queue.js";
import { isDuplicateKeyError, withTransaction } from "../db.js";
import { describeMetaError } from "./metaErrors.js";
import { WhatsAppSendError } from "./client.js";
import { readInboundMessage } from "./inbound.js";
import { applyTemplateStatus, syncTemplates } from "./templates.js";
import { smsBackup } from "./outbound.js";
import { handleMetaNotice } from "../alerts/alerts.js";

const DAY_MS = 24 * 60 * 60 * 1000;
// A delivery report for a message we never sent (e.g. sent from Meta's own tools) stops being retried.
const UNKNOWN_STATUS_ATTEMPTS = 4;

/**
 * The worker's job handlers for WhatsApp. Every handler is safe to run twice.
 * `afterInbound`: job names queued for each new inbound message (e.g. the AI reply), in the same
 * transaction as the message itself - so a crash can neither lose them nor queue them twice.
 */
export function createWhatsAppHandlers({ config, client, now = () => new Date(), afterInbound = [] }) {
  const tenantId = config.TENANT_ID;

  async function storeInbound(event) {
    const { message, contact: metaContact } = event.payload;
    const { referral, ...inbound } = readInboundMessage(message);
    try {
      return await withTransaction(async (session) => {
        const contactUpdate = { $setOnInsert: { firstSeenAt: inbound.at }, $max: { lastInboundAt: inbound.at } };
        if (metaContact?.profile?.name) contactUpdate.$set = { profileName: String(metaContact.profile.name).slice(0, 120) };
        if (referral) contactUpdate.$set = { ...contactUpdate.$set, adReferral: { ...referral, at: inbound.at } };
        const contact = await Contact.findOneAndUpdate({ tenantId, waId: String(message.from) }, contactUpdate, { upsert: true, new: true, session });
        const conversation = await Conversation.findOneAndUpdate(
          { tenantId, contactId: contact._id },
          { $max: { lastInboundAt: inbound.at, lastMessageAt: inbound.at }, $inc: { unread: 1 }, $set: { status: "open" } },
          { upsert: true, new: true, session },
        );
        // The unique waMessageId is the guard: a second run fails here and the whole transaction,
        // including the unread count above, is rolled back.
        const [saved] = await Message.create(
          [{ tenantId, conversationId: conversation._id, contactId: contact._id, direction: "in", waMessageId: String(message.id), ...inbound, status: "received", statusAt: now() }],
          { session },
        );
        for (const name of afterInbound) {
          await enqueue(name, { messageId: String(saved._id) }, { session, dedupeKey: `${name}:${saved._id}` });
        }
        return saved;
      });
    } catch (error) {
      if (isDuplicateKeyError(error)) {
        const existing = await Message.findOne({ tenantId, waMessageId: String(message.id) });
        // Already stored: done. A duplicate on the contact/conversation upsert (two first messages at
        // once) is a race worth retrying.
        if (existing) return null;
        throw new RetryableError("Concurrent first message from this contact; retrying", { delayMs: 1000 });
      }
      throw error;
    }
  }

  async function applyStatus(event, job) {
    const { status } = event.payload;
    const message = await Message.findOne({ tenantId, waMessageId: String(status.id) });
    if (!message) {
      // The report can arrive before our own save of Meta's id. Wait a little, then give up quietly.
      if ((job?.attempts || 1) < UNKNOWN_STATUS_ATTEMPTS) throw new RetryableError("Message for this status is not saved yet", { delayMs: 5000 });
      return;
    }
    const at = status.timestamp ? new Date(Number(status.timestamp) * 1000) : now();
    if (status.status === "failed") {
      const first = Array.isArray(status.errors) ? status.errors[0] : null;
      const described = describeMetaError(first?.code, first?.error_data?.details || first?.message || first?.title);
      const failed = await Message.updateOne(
        { _id: message._id, status: mongoose.trusted({ $ne: "read" }) },
        { $set: { status: "failed", statusAt: at, error: { code: described.code, text: described.label, action: described.action } } },
      );
      if (failed.modifiedCount) await smsBackup(message);
      return;
    }
    const rank = STATUS_RANK[status.status];
    if (rank === undefined) return;
    const lower = Object.keys(STATUS_RANK).filter((name) => STATUS_RANK[name] < rank);
    // Only ever forward: "read" arriving before "delivered" leaves the message at "read".
    await Message.updateOne({ _id: message._id, status: mongoose.trusted({ $in: lower }) }, { $set: { status: status.status, statusAt: at } });
  }

  return {
    async "whatsapp.event"({ eventId }, { job } = {}) {
      const event = await WebhookEvent.findById(eventId);
      if (!event || event.processedAt) return;
      if (event.kind === "message") {
        await storeInbound(event);
      } else if (event.kind === "status") {
        await applyStatus(event, job);
      } else {
        if (event.field === "message_template_status_update") await applyTemplateStatus({ tenantId, value: event.payload?.value });
        await handleMetaNotice({ tenantId, field: event.field, value: event.payload?.value, now: now() });
      }
      await WebhookEvent.updateOne({ _id: event._id }, { $set: { processedAt: now() } });
    },

    async "whatsapp.syncTemplates"() {
      if (!config.WHATSAPP_BUSINESS_ACCOUNT_ID) return;
      try {
        await syncTemplates({ tenantId, client, businessAccountId: config.WHATSAPP_BUSINESS_ACCOUNT_ID, now: now() });
      } catch (error) {
        if (error instanceof WhatsAppSendError && error.retryable) throw new RetryableError(error.message);
        throw error;
      }
    },

    async "whatsapp.send"({ messageId }, { job } = {}) {
      const message = await Message.findById(messageId);
      if (!message || !["queued", "sending"].includes(message.status)) return;
      const [contact, conversation] = await Promise.all([Contact.findById(message.contactId), Conversation.findById(message.conversationId)]);
      if (!contact || !conversation) {
        await Message.updateOne({ _id: message._id }, { $set: { status: "failed", statusAt: now(), error: { code: 0, text: "The customer's record is missing", action: "" } } });
        return;
      }

      // Free-form text is only allowed within 24 hours of the customer's last message (Meta's rule).
      // Checked here, before calling Meta, so staff see the reason at once.
      if (message.type !== "template" && (!conversation.lastInboundAt || now() - conversation.lastInboundAt > DAY_MS)) {
        const described = describeMetaError(131047);
        await Message.updateOne({ _id: message._id }, { $set: { status: "failed", statusAt: now(), error: { code: 131047, text: described.label, action: described.action } } });
        await smsBackup(message);
        return;
      }

      await Message.updateOne(
        { _id: message._id, status: mongoose.trusted({ $in: ["queued", "sending"] }) },
        { $set: { status: "sending", statusAt: now() }, $inc: { sendAttempts: 1 } },
      );

      try {
        const result =
          message.type === "template"
            ? await client.sendTemplate(contact.waId, message.template)
            : message.type === "products"
              ? await client.sendProducts(contact.waId, { body: message.text, ...message.data.products })
              : message.type === "interactive"
              ? await client.sendButtons(contact.waId, { body: message.text, buttons: message.data?.buttons || [] })
              : await client.sendText(contact.waId, message.text);
        const sentAt = now();
        await Message.updateOne(
          { _id: message._id, status: "sending" },
          { $set: { status: "sent", waMessageId: result.waMessageId, sentAt, statusAt: sentAt, error: null } },
        );
        await Conversation.updateOne({ _id: conversation._id }, { $max: { lastOutboundAt: sentAt, lastMessageAt: sentAt } });
      } catch (error) {
        const sendError = error instanceof WhatsAppSendError ? error : null;
        const lastAttempt = (job?.attempts || 1) >= (job?.maxAttempts || 1);
        const failure = { code: sendError?.code || 0, text: sendError?.label || "Could not send", action: sendError?.action || "" };
        if (sendError?.retryable && !lastAttempt) {
          await Message.updateOne({ _id: message._id, status: "sending" }, { $set: { status: "queued", statusAt: now(), error: failure } });
          throw new RetryableError(sendError.message);
        }
        await Message.updateOne({ _id: message._id }, { $set: { status: "failed", statusAt: now(), error: failure } });
        await smsBackup(message);
      }
    },
  };
}
