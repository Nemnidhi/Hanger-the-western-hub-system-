import mongoose from "mongoose";
import { tenantField } from "./tenant.js";

const { ObjectId } = mongoose.Schema.Types;

// The website's customers sign in with a code sent to their WhatsApp number: no passwords. A code is
// kept only as a hash, lives 10 minutes and allows 5 tries; a session lives 60 days from its last use.

const loginCodeSchema = new mongoose.Schema(
  {
    ...tenantField,
    waId: { type: String, required: true },
    codeHash: { type: String, required: true },
    tries: { type: Number, default: 0 },
    usedAt: { type: Date, default: null },
    ip: { type: String, default: "" },
    expiresAt: { type: Date, required: true },
  },
  { timestamps: true },
);
loginCodeSchema.index({ tenantId: 1, waId: 1, createdAt: -1 });
loginCodeSchema.index({ tenantId: 1, ip: 1, createdAt: -1 });
// Kept a day after expiry for the rate limits, then removed by MongoDB.
loginCodeSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 24 * 3600 });

const customerSessionSchema = new mongoose.Schema(
  {
    ...tenantField,
    contactId: { type: ObjectId, ref: "Contact", required: true },
    tokenHash: { type: String, required: true, unique: true },
    userAgent: { type: String, default: "" },
    lastSeenAt: { type: Date, default: () => new Date() },
    expiresAt: { type: Date, required: true },
  },
  { timestamps: true },
);
customerSessionSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export const LoginCode = mongoose.models.LoginCode || mongoose.model("LoginCode", loginCodeSchema);
export const CustomerSession = mongoose.models.CustomerSession || mongoose.model("CustomerSession", customerSessionSchema);
