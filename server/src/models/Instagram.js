import mongoose from "mongoose";
import { tenantField } from "./tenant.js";

// Instagram direct messages and comments on the brand's professional account. Kept apart from the
// WhatsApp chats: Instagram knows a person by an Instagram-scoped id, not a phone number. Staff can
// link a thread to a customer by her phone, so her orders show beside it.

const threadSchema = new mongoose.Schema(
  {
    ...tenantField,
    // Her Instagram-scoped id for our account.
    igsid: { type: String, required: true },
    username: { type: String, default: "" },
    name: { type: String, default: "" },
    contactId: { type: mongoose.Schema.Types.ObjectId, ref: "Contact", default: null },
    phone: { type: String, default: "" },
    status: { type: String, enum: ["open", "closed"], default: "open" },
    lastInboundAt: { type: Date, default: null },
    lastMessageAt: { type: Date, default: null },
    unread: { type: Number, default: 0 },
    profileAt: { type: Date, default: null },
  },
  { timestamps: true },
);
threadSchema.index({ tenantId: 1, igsid: 1 }, { unique: true });
threadSchema.index({ tenantId: 1, lastMessageAt: -1 });

const messageSchema = new mongoose.Schema(
  {
    ...tenantField,
    threadId: { type: mongoose.Schema.Types.ObjectId, ref: "InstagramThread", required: true },
    direction: { type: String, enum: ["in", "out"], required: true },
    // Instagram's id for the message (inbound on arrival, outbound once sent).
    mid: { type: String },
    // dm; comment_reply (our private reply to her comment); story_reply / story_mention (hers).
    kind: { type: String, enum: ["dm", "comment_reply", "story_reply", "story_mention"], default: "dm" },
    text: { type: String, default: "" },
    attachments: { type: [{ _id: false, type: { type: String }, url: String }], default: [] },
    // For a private reply: the comment it answers.
    commentId: { type: String, default: "" },
    status: { type: String, enum: ["received", "queued", "sent", "failed"], required: true },
    error: { type: String, default: "" },
    sentBy: { type: String, default: "" },
    at: { type: Date, default: () => new Date() },
  },
  { timestamps: true },
);
messageSchema.index({ tenantId: 1, mid: 1 }, { unique: true, partialFilterExpression: { mid: { $type: "string" } } });
messageSchema.index({ threadId: 1, at: 1 });

const commentSchema = new mongoose.Schema(
  {
    ...tenantField,
    commentId: { type: String, required: true },
    mediaId: { type: String, default: "" },
    fromId: { type: String, default: "" },
    username: { type: String, default: "" },
    text: { type: String, default: "" },
    at: { type: Date, default: () => new Date() },
    // The keyword rule it matched ("" = none), and what was sent.
    keyword: { type: String, default: "" },
    privateReply: { status: { type: String, default: "" }, at: { type: Date, default: null }, error: { type: String, default: "" } },
    publicReply: { status: { type: String, default: "" }, at: { type: Date, default: null }, error: { type: String, default: "" } },
  },
  { timestamps: true },
);
commentSchema.index({ tenantId: 1, commentId: 1 }, { unique: true });
commentSchema.index({ tenantId: 1, at: -1 });

export const InstagramThread = mongoose.models.InstagramThread || mongoose.model("InstagramThread", threadSchema);
export const InstagramMessage = mongoose.models.InstagramMessage || mongoose.model("InstagramMessage", messageSchema);
export const InstagramComment = mongoose.models.InstagramComment || mongoose.model("InstagramComment", commentSchema);
