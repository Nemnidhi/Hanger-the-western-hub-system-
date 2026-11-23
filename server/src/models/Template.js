import mongoose from "mongoose";
import { tenantField } from "./tenant.js";

// A WhatsApp message template, copied from Meta (sync) and kept current by Meta's status webhooks.
const templateSchema = new mongoose.Schema(
  {
    ...tenantField,
    name: { type: String, required: true },
    language: { type: String, required: true },
    category: { type: String, default: "" },
    status: { type: String, default: "" },
    components: { type: mongoose.Schema.Types.Mixed, default: [] },
    bodyText: { type: String, default: "" },
    paramCount: { type: Number, default: 0 },
    rejectedReason: { type: String, default: "" },
    syncedAt: { type: Date, default: null },
  },
  { timestamps: true },
);

templateSchema.index({ tenantId: 1, name: 1, language: 1 }, { unique: true });

export const Template = mongoose.models.Template || mongoose.model("Template", templateSchema);
