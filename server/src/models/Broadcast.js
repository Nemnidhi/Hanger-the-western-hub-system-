import mongoose from "mongoose";
import { tenantField } from "./tenant.js";

const { ObjectId } = mongoose.Schema.Types;

// A WhatsApp broadcast: one approved Marketing template sent to the customers who agreed to offers
// (new drops, members' offers, a sale), filtered by what they bought, their size, where they live.
// Each customer's message carries the broadcast's id (Message.offerId), so nobody gets it twice.
const broadcastSchema = new mongoose.Schema(
  {
    ...tenantField,
    name: { type: String, required: true, trim: true, maxlength: 80 },
    template: { name: { type: String, required: true }, language: { type: String, required: true } },
    // The template's blanks in order; {first_name}, {size} and {brand} are filled per customer.
    params: { type: [String], default: [] },
    headerImageUrl: { type: String, default: "" },
    urlSuffix: { type: String, default: "" },
    audience: {
      lastBoughtWithinDays: { type: Number, default: null },
      notBoughtForDays: { type: Number, default: null },
      neverBought: { type: Boolean, default: false },
      categories: { type: [String], default: [] },
      sizes: { type: [String], default: [] },
      minSpendPaise: { type: Number, default: 0 },
      pincodePrefixes: { type: [String], default: [] },
      chattedWithinDays: { type: Number, default: null },
    },
    status: { type: String, enum: ["draft", "scheduled", "sending", "waiting", "done", "cancelled"], default: "draft" },
    scheduledAt: { type: Date, default: null },
    startedAt: { type: Date, default: null },
    finishedAt: { type: Date, default: null },
    // Who it goes to, fixed when sending starts (consent is checked again for each message).
    recipients: { type: [ObjectId], default: [] },
    // Recipients not messaged after all (said STOP since, or no longer a customer).
    skippedIds: { type: [ObjectId], default: [] },
    counts: { audience: { type: Number, default: 0 }, queued: { type: Number, default: 0 }, skipped: { type: Number, default: 0 } },
    note: { type: String, default: "" },
    createdBy: { type: String, default: "" },
  },
  { timestamps: true },
);
broadcastSchema.index({ tenantId: 1, createdAt: -1 });

export const Broadcast = mongoose.models.Broadcast || mongoose.model("Broadcast", broadcastSchema);
