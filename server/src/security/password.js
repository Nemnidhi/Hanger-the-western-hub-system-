import { randomBytes, scrypt, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";

// Passwords are stored as scrypt hashes (memory-hard, built into Node - no native add-on to break on a
// server upgrade). Format: scrypt$N$r$p$salt$hash.
const scryptAsync = promisify(scrypt);
const N = 2 ** 15;
const R = 8;
const P = 1;
const KEY_LENGTH = 64;
const MAX_MEMORY = 64 * 1024 * 1024;

export async function hashPassword(password) {
  const salt = randomBytes(16);
  const key = await scryptAsync(String(password), salt, KEY_LENGTH, { N, r: R, p: P, maxmem: MAX_MEMORY });
  return ["scrypt", N, R, P, salt.toString("base64"), key.toString("base64")].join("$");
}

export async function verifyPassword(password, stored) {
  const [scheme, n, r, p, saltText, hashText] = String(stored || "").split("$");
  if (scheme !== "scrypt" || !saltText || !hashText) return false;
  const expected = Buffer.from(hashText, "base64");
  const key = await scryptAsync(String(password), Buffer.from(saltText, "base64"), expected.length, {
    N: Number(n),
    r: Number(r),
    p: Number(p),
    maxmem: MAX_MEMORY,
  });
  return key.length === expected.length && timingSafeEqual(key, expected);
}

// Used when the email is unknown, so a wrong email takes as long as a wrong password (no account probing).
let dummyHash;
export async function burnPasswordCheck(password) {
  dummyHash ||= await hashPassword("not-a-real-password");
  await verifyPassword(password, dummyHash);
}

/** Why a new password is not acceptable, or null. */
export function passwordProblem(password) {
  const value = String(password || "");
  if (value.length < 10) return "Use at least 10 characters.";
  if (value.length > 200) return "Use at most 200 characters.";
  if (new Set(value).size < 4) return "Use a less repetitive password.";
  return null;
}

/** A readable temporary password for a new or reset account: shown once, must be changed at first login. */
export function temporaryPassword() {
  const alphabet = "abcdefghjkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const bytes = randomBytes(14);
  return Array.from(bytes, (byte) => alphabet[byte % alphabet.length]).join("");
}
