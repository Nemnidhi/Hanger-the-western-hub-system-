import mongoose from "mongoose";
import { tenantField } from "./tenant.js";

// Delivery order for outbound messages: a later report never moves a message backwards
// (Meta can deliver "read" before "delivered").
export const STATUS_RANK = { queued: 0, sending: 1, sent: 2, delivered: 3, read: 4 };

const errorSchema = new mongoose.Schema(
  { code: { type: Number, default: 0 }, text: { type: String, default: "" }, action: { type: String, default: "" } },
  { _id: false },
);

const messageSchema = new mongoose.Schema(
  {
    ...tenantField,
    conversationId: { type: mongoose.Schema.Types.ObjectId, ref: "Conversation", required: true },
    contactId: { type: mongoose.Schema.Types.ObjectId, ref: "Contact", required: true },
    direction: { type: String, enum: ["in", "out"], required: true },
    // Meta's id: set on arrival for inbound, after Meta accepts it for outbound.
    waMessageId: { type: String },
    type: { type: String, required: true },
    text: { type: String, default: "" },
    media: {
      id: { type: String, default: "" },
      mimeType: { type: String, default: "" },
      caption: { type: String, default: "" },
      filename: { type: String, default: "" },
    },
    // For outbound: template name/language/parameters when type is "template".
    template: { type: mongoose.Schema.Types.Mixed, default: null },
    // Raw interactive/button/location data for inbound messages the app acts on later.
    data: { type: mongoose.Schema.Types.Mixed, default: null },
    status: { type: String, enum: ["received", "queued", "sending", "sent", "delivered", "read", "failed"], required: true },
    statusAt: { type: Date, default: () => new Date() },
    error: { type: errorSchema, default: null },
    sendAttempts: { type: Number, default: 0 },
    sentAt: { type: Date, default: null },
    // Inbound: set when the ordering step has handled this message (so it is never handled twice).
    intakeAt: { type: Date, default: null },
    // Inbound: when the customer sent it (Meta's timestamp), not when we received it.
    at: { type: Date, default: () => new Date() },
    // Outbound: what this message is for. Order messages carry an SMS fallback ({ kind, vars }) used
    // when WhatsApp cannot deliver; offers never do.
    purpose: { type: String, enum: ["chat", "order", "refill", "offer", "consent"], default: "chat" },
    orderId: { type: mongoose.Schema.Types.ObjectId, ref: "Order", default: null },
    offerId: { type: mongoose.Schema.Types.ObjectId, ref: "Offer", default: null },
    fallback: { type: mongoose.Schema.Types.Mixed, default: null },
    // The SMS sent as backup for this message (or, for type "sms", the message itself).
    sms: {
      status: { type: String, enum: ["", "queued", "sent", "failed", "not_possible"], default: "" },
      at: { type: Date, default: null },
      error: { type: String, default: "" },
      requestId: { type: String, default: "" },
    },
  },
  { timestamps: true },
);

messageSchema.index({ tenantId: 1, waMessageId: 1 }, { unique: true, partialFilterExpression: { waMessageId: { $type: "string" } } });
messageSchema.index({ conversationId: 1, at: 1 });
// One offer message per customer per offer, and the 7-day offer limit.
messageSchema.index({ offerId: 1, contactId: 1 }, { unique: true, partialFilterExpression: { offerId: { $type: "objectId" } } });
messageSchema.index({ contactId: 1, purpose: 1, createdAt: -1 });
messageSchema.index({ tenantId: 1, direction: 1, createdAt: -1 });

export const Message = mongoose.models.Message || mongoose.model("Message", messageSchema);
