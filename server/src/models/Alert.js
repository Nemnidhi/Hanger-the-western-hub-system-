import mongoose from "mongoose";
import { tenantField } from "./tenant.js";

// Something the owner must know about: a template paused or rejected by Meta, the number's quality
// dropping, a notice on the WhatsApp account. One open alert per key; it closes when Meta reports the
// problem fixed or the owner marks it done.
const alertSchema = new mongoose.Schema(
  {
    ...tenantField,
    key: { type: String, required: true },
    kind: { type: String, enum: ["template", "number", "account", "system"], required: true },
    severity: { type: String, enum: ["high", "medium"], default: "medium" },
    title: { type: String, required: true },
    detail: { type: String, default: "" },
    count: { type: Number, default: 1 },
    lastAt: { type: Date, default: () => new Date() },
    resolvedAt: { type: Date, default: null },
    resolvedBy: { type: String, default: "" },
    emailStatus: { type: String, enum: ["pending", "sent", "not_configured", "failed"], default: "pending" },
  },
  { timestamps: true },
);
alertSchema.index({ tenantId: 1, key: 1 }, { unique: true, partialFilterExpression: { resolvedAt: null } });
alertSchema.index({ tenantId: 1, createdAt: -1 });

export const Alert = mongoose.models.Alert || mongoose.model("Alert", alertSchema);

// The owner's end-of-day numbers, kept so past days can be looked at again.
const dailySummarySchema = new mongoose.Schema(
  {
    ...tenantField,
    date: { type: String, required: true },
    data: { type: mongoose.Schema.Types.Mixed, default: {} },
    emailStatus: { type: String, enum: ["pending", "sent", "not_configured", "failed"], default: "pending" },
  },
  { timestamps: true },
);
dailySummarySchema.index({ tenantId: 1, date: 1 }, { unique: true });

export const DailySummary = mongoose.models.DailySummary || mongoose.model("DailySummary", dailySummarySchema);
