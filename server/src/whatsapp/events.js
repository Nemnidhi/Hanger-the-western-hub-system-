import { createHash } from "node:crypto";

/**
 * Splits one webhook delivery from Meta into separate events, each with a stable key, so the same
 * event delivered twice (Meta retries) is recognised. Only events for `phoneNumberId` are kept.
 */
export function extractEvents(body, { phoneNumberId }) {
  const events = [];
  for (const entry of Array.isArray(body?.entry) ? body.entry : []) {
    for (const change of Array.isArray(entry?.changes) ? entry.changes : []) {
      const field = String(change?.field || "");
      const value = change?.value || {};
      if (field === "messages") {
        if (String(value.metadata?.phone_number_id || "") !== String(phoneNumberId)) continue;
        const contacts = Array.isArray(value.contacts) ? value.contacts : [];
        for (const message of Array.isArray(value.messages) ? value.messages : []) {
          if (!message?.id || !message?.from) continue;
          const contact = contacts.find((row) => row?.wa_id === message.from) || null;
          events.push({ key: `msg:${message.id}`, kind: "message", field, payload: { message, contact } });
        }
        for (const status of Array.isArray(value.statuses) ? value.statuses : []) {
          if (!status?.id || !status?.status) continue;
          events.push({ key: `status:${status.id}:${status.status}`, kind: "status", field, payload: { status } });
        }
        continue;
      }
      // Template approvals, number quality, account notices: kept for the owner's alerts (later phase).
      const digest = createHash("sha256").update(JSON.stringify({ field, value })).digest("hex").slice(0, 32);
      events.push({ key: `${field || "unknown"}:${digest}`, kind: "other", field, payload: { value } });
    }
  }
  return events;
}
