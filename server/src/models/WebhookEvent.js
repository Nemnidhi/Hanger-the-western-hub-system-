import mongoose from "mongoose";
import { tenantField } from "./tenant.js";

// Every event Meta sends, stored before we answer Meta. The unique key makes Meta's retries and
// duplicates harmless: the second copy is recognised and ignored.
const webhookEventSchema = new mongoose.Schema(
  {
    ...tenantField,
    key: { type: String, required: true },
    kind: { type: String, enum: ["message", "status", "other", "instagram"], required: true },
    field: { type: String, default: "" },
    payload: { type: mongoose.Schema.Types.Mixed, required: true },
    receivedAt: { type: Date, default: () => new Date() },
    processedAt: { type: Date, default: null },
  },
  { timestamps: false },
);

webhookEventSchema.index({ tenantId: 1, key: 1 }, { unique: true });
// Raw events are evidence for debugging, not records: kept 90 days.
webhookEventSchema.index({ receivedAt: 1 }, { expireAfterSeconds: 90 * 24 * 3600 });

export const WebhookEvent = mongoose.models.WebhookEvent || mongoose.model("WebhookEvent", webhookEventSchema);
