import express from "express";
import mongoose from "mongoose";
import { z } from "zod";
import { Session, User, publicUser } from "../models/index.js";
import { burnPasswordCheck, hashPassword, passwordProblem, verifyPassword } from "../security/password.js";
import { generateRecoveryCodes, generateTotpSecret, hashRecoveryCode, otpauthUrl, verifyTotp } from "../security/totp.js";
import { decryptField, encryptField } from "../security/fieldEncryption.js";
import { createSession, clearSessionCookie, setSessionCookie } from "../auth/sessions.js";
import { requireAuth } from "../auth/middleware.js";
import { permissionsFor, TWO_FACTOR_REQUIRED_ROLES } from "../auth/permissions.js";
import { audit } from "../audit.js";
import { httpError, parseBody, route } from "./validate.js";

const MAX_FAILURES = 5;
const LOCK_MS = 15 * 60 * 1000;

/** What the person must do next before they can use the app, or null. */
export function nextStep(user, session) {
  if (session?.twoFactorPending) return "two_factor";
  if (user.mustChangePassword) return "change_password";
  if (TWO_FACTOR_REQUIRED_ROLES.has(user.role) && !user.twoFactor?.enabled) return "two_factor_setup";
  return null;
}

function meResponse(user, session) {
  return { user: publicUser(user), next: nextStep(user, session), permissions: permissionsFor(user.role) };
}

async function recordFailure(user, now) {
  const failures = (user.failedLogins || 0) + 1;
  const update = failures >= MAX_FAILURES ? { failedLogins: 0, lockedUntil: new Date(now.getTime() + LOCK_MS) } : { failedLogins: failures };
  await User.updateOne({ _id: user._id }, { $set: update });
  return failures >= MAX_FAILURES;
}

function lockedMessage(user, now) {
  const minutes = Math.max(1, Math.ceil((user.lockedUntil - now) / 60000));
  return `Too many wrong attempts. Try again in ${minutes} minute${minutes === 1 ? "" : "s"}.`;
}

export function createAuthRouter({ config, logger }) {
  const router = express.Router();
  const secure = config.NODE_ENV === "production";
  const key = config.DATA_ENCRYPTION_KEY;

  router.post(
    "/api/auth/login",
    route(async (req, res) => {
      const body = parseBody(z.object({ email: z.string().trim().toLowerCase().email(), password: z.string().min(1).max(200) }), req);
      const now = new Date();
      const user = await User.findOne({ tenantId: config.TENANT_ID, email: body.email });
      if (!user) {
        await burnPasswordCheck(body.password);
        await audit({ req, tenantId: config.TENANT_ID, action: "auth.login_failed", meta: { reason: "unknown_email" }, logger });
        throw httpError(401, "Email or password is wrong.", "INVALID_CREDENTIALS");
      }
      if (user.lockedUntil && user.lockedUntil > now) throw httpError(429, lockedMessage(user, now), "LOCKED");

      const passwordOk = await verifyPassword(body.password, user.passwordHash);
      if (!passwordOk || user.status !== "active") {
        if (!passwordOk) await recordFailure(user, now);
        await audit({ req, actor: user, action: "auth.login_failed", targetType: "user", targetId: user._id, meta: { reason: passwordOk ? "disabled" : "password" }, logger });
        throw httpError(401, "Email or password is wrong.", "INVALID_CREDENTIALS");
      }

      await User.updateOne({ _id: user._id }, { $set: { failedLogins: 0, lockedUntil: null, lastLoginAt: now } });
      const twoFactorPending = Boolean(user.twoFactor?.enabled);
      const token = await createSession({ user, req, twoFactorPending, now });
      setSessionCookie(res, token, { secure });
      await audit({ req, actor: user, action: "auth.login", targetType: "user", targetId: user._id, logger });
      res.json(meResponse(user, { twoFactorPending }));
    }),
  );

  router.get(
    "/api/auth/me",
    requireAuth({ allowIncomplete: true }),
    route(async (req, res) => res.json(meResponse(req.user, req.authSession))),
  );

  router.post(
    "/api/auth/logout",
    requireAuth({ allowIncomplete: true }),
    route(async (req, res) => {
      await Session.deleteOne({ _id: req.authSession._id });
      clearSessionCookie(res, { secure });
      await audit({ req, action: "auth.logout", targetType: "user", targetId: req.user._id, logger });
      res.json({ ok: true });
    }),
  );

  // Second step of signing in: a code from the authenticator app.
  router.post(
    "/api/auth/2fa/verify",
    requireAuth({ allowIncomplete: true }),
    route(async (req, res) => {
      const { code } = parseBody(z.object({ code: z.string().trim().min(6).max(10) }), req);
      const user = req.user;
      const now = new Date();
      if (!req.authSession.twoFactorPending) return res.json(meResponse(user, req.authSession));
      if (user.lockedUntil && user.lockedUntil > now) throw httpError(429, lockedMessage(user, now), "LOCKED");

      const step = verifyTotp(decryptField(user.twoFactor.secretEnc, key), code, { now: now.getTime(), lastStep: user.twoFactor.lastStep });
      // The step is claimed atomically, so the same code cannot pass twice even in parallel.
      const claimed = step !== null && (await User.updateOne({ _id: user._id, "twoFactor.lastStep": mongoose.trusted({ $lt: step }) }, { $set: { "twoFactor.lastStep": step, failedLogins: 0 } })).modifiedCount === 1;
      if (!claimed) {
        const locked = await recordFailure(user, now);
        await audit({ req, action: "auth.two_factor_failed", targetType: "user", targetId: user._id, logger });
        if (locked) await Session.deleteOne({ _id: req.authSession._id });
        throw httpError(401, "That code is not right. Use the current code from your authenticator app.", "INVALID_CODE");
      }
      await Session.updateOne({ _id: req.authSession._id }, { $set: { twoFactorPending: false } });
      await audit({ req, action: "auth.two_factor_passed", targetType: "user", targetId: user._id, logger });
      res.json(meResponse(user, { twoFactorPending: false }));
    }),
  );

  // Lost phone: a one-time recovery code instead of the app's code.
  router.post(
    "/api/auth/2fa/recovery",
    requireAuth({ allowIncomplete: true }),
    route(async (req, res) => {
      const { code } = parseBody(z.object({ code: z.string().trim().min(6).max(20) }), req);
      const user = req.user;
      if (!req.authSession.twoFactorPending) return res.json(meResponse(user, req.authSession));
      const hash = hashRecoveryCode(code);
      const used = (await User.updateOne({ _id: user._id, "twoFactor.recoveryCodeHashes": hash }, { $pull: { "twoFactor.recoveryCodeHashes": hash } })).modifiedCount === 1;
      if (!used) {
        await recordFailure(user, new Date());
        throw httpError(401, "That recovery code is not right, or was already used.", "INVALID_CODE");
      }
      await Session.updateOne({ _id: req.authSession._id }, { $set: { twoFactorPending: false } });
      await audit({ req, action: "auth.recovery_code_used", targetType: "user", targetId: user._id, logger });
      res.json(meResponse(user, { twoFactorPending: false }));
    }),
  );

  function requireFirstStepDone(req) {
    if (req.authSession.twoFactorPending) throw httpError(403, "Finish signing in first.", "TWO_FACTOR_REQUIRED");
  }

  router.post(
    "/api/auth/password",
    requireAuth({ allowIncomplete: true }),
    route(async (req, res) => {
      requireFirstStepDone(req);
      const body = parseBody(z.object({ currentPassword: z.string().min(1).max(200), newPassword: z.string().max(200) }), req);
      const user = req.user;
      if (!(await verifyPassword(body.currentPassword, user.passwordHash))) throw httpError(400, "The current password is not right.", "INVALID_PASSWORD");
      const problem = passwordProblem(body.newPassword);
      if (problem) throw httpError(400, problem, "WEAK_PASSWORD");
      if (body.newPassword === body.currentPassword) throw httpError(400, "Choose a password different from the current one.", "SAME_PASSWORD");
      await User.updateOne({ _id: user._id }, { $set: { passwordHash: await hashPassword(body.newPassword), mustChangePassword: false } });
      // Every other signed-in browser of this person is signed out.
      await Session.deleteMany({ userId: user._id, _id: mongoose.trusted({ $ne: req.authSession._id }) });
      await audit({ req, action: "auth.password_changed", targetType: "user", targetId: user._id, logger });
      const fresh = await User.findById(user._id);
      res.json(meResponse(fresh, req.authSession));
    }),
  );

  // Turning on two-step login: 1) setup returns a secret for the authenticator app, 2) enable checks a code.
  router.post(
    "/api/auth/2fa/setup",
    requireAuth({ allowIncomplete: true }),
    route(async (req, res) => {
      requireFirstStepDone(req);
      if (req.user.mustChangePassword) throw httpError(403, "Change your temporary password first.", "PASSWORD_CHANGE_REQUIRED");
      if (req.user.twoFactor?.enabled) throw httpError(409, "Two-step login is already on.", "ALREADY_ENABLED");
      const secret = generateTotpSecret();
      await User.updateOne({ _id: req.user._id }, { $set: { "twoFactor.pendingSecretEnc": encryptField(secret, key) } });
      res.json({ secret, otpauthUrl: otpauthUrl({ secret, account: req.user.email, issuer: "The Hanger" }) });
    }),
  );

  router.post(
    "/api/auth/2fa/enable",
    requireAuth({ allowIncomplete: true }),
    route(async (req, res) => {
      requireFirstStepDone(req);
      const { code } = parseBody(z.object({ code: z.string().trim().min(6).max(10) }), req);
      const user = req.user;
      if (user.twoFactor?.enabled) throw httpError(409, "Two-step login is already on.", "ALREADY_ENABLED");
      if (!user.twoFactor?.pendingSecretEnc) throw httpError(400, "Start the setup again.", "NO_SETUP");
      const secret = decryptField(user.twoFactor.pendingSecretEnc, key);
      const step = verifyTotp(secret, code);
      if (step === null) throw httpError(400, "That code is not right. Check the time on your phone and try the current code.", "INVALID_CODE");
      const recoveryCodes = generateRecoveryCodes();
      await User.updateOne(
        { _id: user._id },
        {
          $set: {
            "twoFactor.enabled": true,
            "twoFactor.secretEnc": encryptField(secret, key),
            "twoFactor.pendingSecretEnc": "",
            "twoFactor.lastStep": step,
            "twoFactor.recoveryCodeHashes": recoveryCodes.map(hashRecoveryCode),
          },
        },
      );
      await audit({ req, action: "auth.two_factor_enabled", targetType: "user", targetId: user._id, logger });
      const fresh = await User.findById(user._id);
      // Recovery codes are shown once, here, and never again.
      res.json({ ...meResponse(fresh, req.authSession), recoveryCodes });
    }),
  );

  return router;
}
