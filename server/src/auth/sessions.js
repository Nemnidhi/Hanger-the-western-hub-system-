import { createHash, randomBytes } from "node:crypto";
import { Session } from "../models/index.js";

export const SESSION_COOKIE = "hh_session";
const IDLE_MS = 12 * 60 * 60 * 1000;
const ABSOLUTE_MS = 7 * 24 * 60 * 60 * 1000;
// lastSeenAt is written at most this often, so reading a page does not mean a database write each time.
const TOUCH_EVERY_MS = 5 * 60 * 1000;

export function hashToken(token) {
  return createHash("sha256").update(String(token)).digest("hex");
}

export async function createSession({ user, req, twoFactorPending, now = new Date() }) {
  const token = randomBytes(32).toString("base64url");
  const absoluteExpiry = new Date(now.getTime() + ABSOLUTE_MS);
  await Session.create({
    tenantId: user.tenantId,
    userId: user._id,
    tokenHash: hashToken(token),
    twoFactorPending,
    ip: String(req.ip || "").slice(0, 64),
    userAgent: String(req.get("user-agent") || "").slice(0, 300),
    lastSeenAt: now,
    absoluteExpiry,
    expiresAt: new Date(Math.min(now.getTime() + IDLE_MS, absoluteExpiry.getTime())),
  });
  return token;
}

/** The live session for a token, sliding its idle expiry; null when missing or expired. */
export async function findSession(token, { now = new Date() } = {}) {
  if (!token) return null;
  const session = await Session.findOne({ tokenHash: hashToken(token) });
  if (!session || session.expiresAt <= now || session.absoluteExpiry <= now) return null;
  if (now - session.lastSeenAt > TOUCH_EVERY_MS) {
    session.lastSeenAt = now;
    session.expiresAt = new Date(Math.min(now.getTime() + IDLE_MS, session.absoluteExpiry.getTime()));
    await session.save();
  }
  return session;
}

export function setSessionCookie(res, token, { secure }) {
  res.cookie(SESSION_COOKIE, token, { httpOnly: true, secure, sameSite: "strict", path: "/", maxAge: ABSOLUTE_MS });
}

export function clearSessionCookie(res, { secure }) {
  res.clearCookie(SESSION_COOKIE, { httpOnly: true, secure, sameSite: "strict", path: "/" });
}

/** Reads one cookie without a cookie-parsing dependency. */
export function readCookie(req, name) {
  const header = req.get("cookie") || "";
  for (const part of header.split(";")) {
    const index = part.indexOf("=");
    if (index > 0 && part.slice(0, index).trim() === name) return decodeURIComponent(part.slice(index + 1).trim());
  }
  return "";
}
