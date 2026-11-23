import mongoose from "mongoose";
import { tenantField } from "./tenant.js";

// One WhatsApp chat per contact. lastInboundAt decides the 24-hour window for free-form replies.
const conversationSchema = new mongoose.Schema(
  {
    ...tenantField,
    contactId: { type: mongoose.Schema.Types.ObjectId, ref: "Contact", required: true },
    status: { type: String, enum: ["open", "waiting", "closed"], default: "open" },
    assignedTo: { type: String, default: "" },
    lastInboundAt: { type: Date, default: null },
    lastOutboundAt: { type: Date, default: null },
    lastMessageAt: { type: Date, default: null },
    unread: { type: Number, default: 0 },
    // The automatic welcome menu goes out at most once in 12 hours.
    welcomedAt: { type: Date, default: null },
  },
  { timestamps: true },
);

conversationSchema.index({ tenantId: 1, contactId: 1 }, { unique: true });
conversationSchema.index({ tenantId: 1, lastMessageAt: -1 });

export const Conversation = mongoose.models.Conversation || mongoose.model("Conversation", conversationSchema);
