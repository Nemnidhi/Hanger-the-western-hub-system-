import mongoose from "mongoose";
import { tenantField } from "./tenant.js";
import { ROLES } from "../auth/permissions.js";

// A member of the boutique's team. Two-step login secrets are stored encrypted; recovery codes only as
// hashes; passwords only as scrypt hashes.
const userSchema = new mongoose.Schema(
  {
    ...tenantField,
    name: { type: String, required: true, trim: true, maxlength: 120 },
    email: { type: String, required: true, trim: true, lowercase: true, maxlength: 200 },
    phone: { type: String, default: "", trim: true },
    role: { type: String, enum: ROLES, required: true },
    status: { type: String, enum: ["active", "disabled"], default: "active" },
    passwordHash: { type: String, required: true },
    mustChangePassword: { type: Boolean, default: true },
    failedLogins: { type: Number, default: 0 },
    lockedUntil: { type: Date, default: null },
    lastLoginAt: { type: Date, default: null },
    twoFactor: {
      enabled: { type: Boolean, default: false },
      secretEnc: { type: String, default: "" },
      pendingSecretEnc: { type: String, default: "" },
      lastStep: { type: Number, default: -1 },
      recoveryCodeHashes: { type: [String], default: [] },
    },
  },
  { timestamps: true },
);

userSchema.index({ tenantId: 1, email: 1 }, { unique: true });

/** What the staff app may see about a user - never hashes or secrets. */
export function publicUser(user) {
  return {
    id: String(user._id),
    name: user.name,
    email: user.email,
    phone: user.phone,
    role: user.role,
    status: user.status,
    mustChangePassword: user.mustChangePassword,
    twoFactorEnabled: Boolean(user.twoFactor?.enabled),
    lastLoginAt: user.lastLoginAt,
  };
}

export const User = mongoose.models.User || mongoose.model("User", userSchema);
