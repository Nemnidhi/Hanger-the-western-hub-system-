import express from "express";
import mongoose from "mongoose";
import { z } from "zod";
import { Session, User, publicUser } from "../models/index.js";
import { hashPassword, temporaryPassword } from "../security/password.js";
import { requireAuth, requirePermission } from "../auth/middleware.js";
import { ROLES } from "../auth/permissions.js";
import { audit } from "../audit.js";
import { isDuplicateKeyError } from "../db.js";
import { httpError, parseBody, route } from "./validate.js";

const objectId = (value) => {
  if (!mongoose.isValidObjectId(value)) throw httpError(404, "Not found.", "NOT_FOUND");
  return value;
};

async function activeOwnerCount(tenantId) {
  return User.countDocuments({ tenantId, role: "owner", status: "active" });
}

/** The owner manages the team: add people, change roles, disable, reset passwords and two-step login. */
export function createUsersRouter({ logger }) {
  const router = express.Router();
  router.use("/api/users", requireAuth(), requirePermission("users:manage"));

  router.get(
    "/api/users",
    route(async (req, res) => {
      const users = await User.find({ tenantId: req.tenantId }).sort({ name: 1 });
      res.json({ data: users.map(publicUser) });
    }),
  );

  router.post(
    "/api/users",
    route(async (req, res) => {
      const body = parseBody(
        z.object({
          name: z.string().trim().min(1).max(120),
          email: z.string().trim().toLowerCase().email(),
          phone: z.string().trim().max(20).optional().default(""),
          role: z.enum(ROLES),
        }),
        req,
      );
      const password = temporaryPassword();
      try {
        const user = await User.create({ tenantId: req.tenantId, ...body, passwordHash: await hashPassword(password), mustChangePassword: true });
        await audit({ req, action: "user.created", targetType: "user", targetId: user._id, meta: { role: user.role }, logger });
        // The temporary password is shown once, to the owner, and must be changed at first sign-in.
        res.status(201).json({ data: publicUser(user), temporaryPassword: password });
      } catch (error) {
        if (isDuplicateKeyError(error)) throw httpError(409, "Someone on the team already uses this email.", "DUPLICATE_EMAIL");
        throw error;
      }
    }),
  );

  router.patch(
    "/api/users/:id",
    route(async (req, res) => {
      const body = parseBody(
        z.object({
          name: z.string().trim().min(1).max(120).optional(),
          phone: z.string().trim().max(20).optional(),
          role: z.enum(ROLES).optional(),
          status: z.enum(["active", "disabled"]).optional(),
        }),
        req,
      );
      const user = await User.findOne({ _id: objectId(req.params.id), tenantId: req.tenantId });
      if (!user) throw httpError(404, "Not found.", "NOT_FOUND");
      const losingOwner = user.role === "owner" && user.status === "active" && ((body.role && body.role !== "owner") || body.status === "disabled");
      if (losingOwner && (await activeOwnerCount(req.tenantId)) <= 1) throw httpError(409, "The business must keep at least one active owner.", "LAST_OWNER");
      if (String(user._id) === String(req.user._id) && body.status === "disabled") throw httpError(409, "You cannot disable your own account.", "SELF_DISABLE");

      Object.assign(user, body);
      await user.save();
      // A disabled person, or one whose role changed, is signed out everywhere at once.
      if (body.status === "disabled" || body.role) await Session.deleteMany({ userId: user._id });
      await audit({ req, action: "user.updated", targetType: "user", targetId: user._id, meta: body, logger });
      res.json({ data: publicUser(user) });
    }),
  );

  router.post(
    "/api/users/:id/reset-password",
    route(async (req, res) => {
      const user = await User.findOne({ _id: objectId(req.params.id), tenantId: req.tenantId });
      if (!user) throw httpError(404, "Not found.", "NOT_FOUND");
      const password = temporaryPassword();
      await User.updateOne({ _id: user._id }, { $set: { passwordHash: await hashPassword(password), mustChangePassword: true, failedLogins: 0, lockedUntil: null } });
      await Session.deleteMany({ userId: user._id });
      await audit({ req, action: "user.password_reset", targetType: "user", targetId: user._id, logger });
      res.json({ temporaryPassword: password });
    }),
  );

  // For a lost phone: two-step login is switched off and must be set up again at the next sign-in.
  router.post(
    "/api/users/:id/reset-two-factor",
    route(async (req, res) => {
      const user = await User.findOne({ _id: objectId(req.params.id), tenantId: req.tenantId });
      if (!user) throw httpError(404, "Not found.", "NOT_FOUND");
      await User.updateOne(
        { _id: user._id },
        { $set: { "twoFactor.enabled": false, "twoFactor.secretEnc": "", "twoFactor.pendingSecretEnc": "", "twoFactor.recoveryCodeHashes": [], "twoFactor.lastStep": -1 } },
      );
      await Session.deleteMany({ userId: user._id });
      await audit({ req, action: "user.two_factor_reset", targetType: "user", targetId: user._id, logger });
      res.json({ ok: true });
    }),
  );

  return router;
}
