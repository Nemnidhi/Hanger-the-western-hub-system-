import mongoose from "mongoose";
import { tenantField } from "./tenant.js";

// A signed-in browser. Only the SHA-256 of the session token is stored, so a database copy cannot be
// used to sign in. Sessions end after 12 idle hours or 7 days, and can be revoked instantly.
const sessionSchema = new mongoose.Schema(
  {
    ...tenantField,
    userId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true, index: true },
    tokenHash: { type: String, required: true },
    twoFactorPending: { type: Boolean, default: false },
    ip: { type: String, default: "" },
    userAgent: { type: String, default: "" },
    lastSeenAt: { type: Date, default: () => new Date() },
    absoluteExpiry: { type: Date, required: true },
    expiresAt: { type: Date, required: true },
  },
  { timestamps: true },
);

sessionSchema.index({ tokenHash: 1 }, { unique: true });
sessionSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export const Session = mongoose.models.Session || mongoose.model("Session", sessionSchema);
