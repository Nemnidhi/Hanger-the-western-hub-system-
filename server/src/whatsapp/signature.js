import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * True only when `signatureHeader` (X-Hub-Signature-256) is Meta's HMAC-SHA256 of the exact raw
 * request body with the app secret. Anything else - missing, malformed, wrong - is false.
 */
export function isValidMetaSignature(rawBody, signatureHeader, appSecret) {
  if (!appSecret || !Buffer.isBuffer(rawBody) || typeof signatureHeader !== "string") return false;
  const match = /^sha256=([0-9a-f]{64})$/i.exec(signatureHeader.trim());
  if (!match) return false;
  const expected = createHmac("sha256", appSecret).update(rawBody).digest();
  const received = Buffer.from(match[1], "hex");
  return received.length === expected.length && timingSafeEqual(received, expected);
}
