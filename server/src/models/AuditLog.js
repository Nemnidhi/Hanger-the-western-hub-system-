import mongoose from "mongoose";
import { tenantField } from "./tenant.js";

// Who did what, when, from where: sign-ins, account changes, messages sent, and (later) prescription
// approvals and order changes. Never edited or deleted by the app.
const auditLogSchema = new mongoose.Schema(
  {
    ...tenantField,
    actorId: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
    actorName: { type: String, default: "" },
    action: { type: String, required: true },
    targetType: { type: String, default: "" },
    targetId: { type: String, default: "" },
    meta: { type: mongoose.Schema.Types.Mixed, default: null },
    ip: { type: String, default: "" },
    at: { type: Date, default: () => new Date() },
  },
  { timestamps: false },
);

auditLogSchema.index({ tenantId: 1, at: -1 });
auditLogSchema.index({ tenantId: 1, targetType: 1, targetId: 1, at: -1 });

export const AuditLog = mongoose.models.AuditLog || mongoose.model("AuditLog", auditLogSchema);
