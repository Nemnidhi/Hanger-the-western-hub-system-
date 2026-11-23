import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

// Health data (prescriptions, medicines, doses) is encrypted before it reaches the database, with
// AES-256-GCM: a stolen database copy or backup is unreadable without the key, and any tampering is
// detected. Format: "v1:<iv>:<tag>:<ciphertext>" (base64). The version lets the key be rotated later.
const PREFIX = "v1";

function keyFrom(hexKey) {
  const key = Buffer.from(String(hexKey || ""), "hex");
  if (key.length !== 32) throw new Error("Encryption key must be 32 bytes (64 hex characters)");
  return key;
}

export function encryptField(plaintext, hexKey) {
  if (plaintext === null || plaintext === undefined) return plaintext;
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", keyFrom(hexKey), iv);
  const data = Buffer.concat([cipher.update(String(plaintext), "utf8"), cipher.final()]);
  return [PREFIX, iv.toString("base64"), cipher.getAuthTag().toString("base64"), data.toString("base64")].join(":");
}

export function decryptField(value, hexKey) {
  if (value === null || value === undefined || value === "") return value;
  const [prefix, iv, tag, data] = String(value).split(":");
  if (prefix !== PREFIX || !iv || !tag || data === undefined) throw new Error("Not an encrypted value");
  const decipher = createDecipheriv("aes-256-gcm", keyFrom(hexKey), Buffer.from(iv, "base64"));
  decipher.setAuthTag(Buffer.from(tag, "base64"));
  return Buffer.concat([decipher.update(Buffer.from(data, "base64")), decipher.final()]).toString("utf8");
}
