import { Alert, Settings } from "../models/index.js";

import { isDuplicateKeyError } from "../db.js";

/**
 * Opens an alert for the owner, or counts a repeat of one already open (same key). A new alert is
 * shown to the owner in the staff app.
 */
export async function raiseAlert({ tenantId, key, kind, severity = "medium", title, detail = "", now = new Date() }) {
  const existing = await Alert.findOneAndUpdate({ tenantId, key, resolvedAt: null }, { $inc: { count: 1 }, $set: { lastAt: now, detail, severity } }, { new: true });
  if (existing) return existing;
  try {
    const [alert] = await Alert.create([{ tenantId, key, kind, severity, title, detail, lastAt: now }]);
    // The owner sees open alerts in the staff app (an owner WhatsApp alert comes with the daily brief).
    return alert;
  } catch (error) {
    // Two workers raising the same alert at once: the other one won.
    if (isDuplicateKeyError(error)) return Alert.findOne({ tenantId, key, resolvedAt: null });
    throw error;
  }
}

export async function resolveAlert({ tenantId, key, by = "Meta", now = new Date() }) {
  await Alert.updateMany({ tenantId, key, resolvedAt: null }, { $set: { resolvedAt: now, resolvedBy: by } });
}

const TEMPLATE_PROBLEMS = { PAUSED: "paused", DISABLED: "disabled", REJECTED: "rejected", FLAGGED: "flagged (quality falling)", PENDING_DELETION: "being deleted" };
const TEMPLATE_FIXED = new Set(["APPROVED", "REINSTATED", "UNFLAGGED", "UNPAUSED"]);

/** Which of the settings use a template (an alert about one of these is urgent). */
async function templateUses(tenantId, name) {
  const settings = await Settings.findOne({ tenantId }).lean();
  const names = { orderUpdate: "order updates" };
  return Object.entries(names).filter(([field]) => settings?.templates?.[field]?.name === name).map(([, label]) => label);
}

/**
 * Meta's notices that are not messages: template status changes, the number's quality rating and
 * messaging limit, and account notices. Each becomes an alert in plain words, or closes one.
 */
export async function handleMetaNotice({ tenantId, field, value, now = new Date() }) {
  if (field === "message_template_status_update") {
    const name = String(value?.message_template_name || "");
    const language = String(value?.message_template_language || "");
    const event = String(value?.event || "").toUpperCase();
    if (!name) return;
    const key = `template:${name}:${language}`;
    if (TEMPLATE_FIXED.has(event)) return resolveAlert({ tenantId, key, now });
    if (!TEMPLATE_PROBLEMS[event]) return;
    const uses = await templateUses(tenantId, name);
    const reason = value?.reason && value.reason !== "NONE" ? ` Meta's reason: ${String(value.reason).replace(/_/g, " ").toLowerCase()}.` : "";
    return raiseAlert({
      tenantId,
      key,
      kind: "template",
      severity: uses.length ? "high" : "medium",
      title: `Template "${name}" was ${TEMPLATE_PROBLEMS[event]}`,
      detail: `${uses.length ? `It is used for ${uses.join(" and ")}: those messages cannot go out after 24 hours until it is fixed (order messages fall back to SMS if set up). ` : ""}${reason} Check it in WhatsApp Manager > Message templates.`.trim(),
      now,
    });
  }

  if (field === "phone_number_quality_update") {
    const event = String(value?.event || "").toUpperCase();
    const limit = value?.current_limit ? ` Messaging limit now: ${String(value.current_limit).replace(/_/g, " ").toLowerCase()}.` : "";
    if (["UNFLAGGED", "UPGRADE"].includes(event)) return resolveAlert({ tenantId, key: "number:quality", now });
    if (!["FLAGGED", "DOWNGRADE"].includes(event)) return;
    return raiseAlert({
      tenantId,
      key: "number:quality",
      kind: "number",
      severity: "high",
      title: event === "FLAGGED" ? "WhatsApp flagged the number's quality" : "WhatsApp lowered the number's messaging limit",
      detail: `Customers have been blocking or reporting messages. Pause offers and reminders for a few days and check templates in WhatsApp Manager.${limit}`,
      now,
    });
  }

  if (field === "account_update") {
    const event = String(value?.event || "").toUpperCase();
    if (!event) return;
    const restriction = value?.restriction_info ? ` ${JSON.stringify(value.restriction_info).slice(0, 300)}` : "";
    const violation = value?.violation_info?.violation_type ? ` Violation: ${String(value.violation_info.violation_type).replace(/_/g, " ").toLowerCase()}.` : "";
    return raiseAlert({
      tenantId,
      key: `account:${event}`,
      kind: "account",
      severity: /VIOLATION|RESTRICTION|DISABLED|BAN/.test(event) ? "high" : "medium",
      title: `WhatsApp account notice: ${event.replace(/_/g, " ").toLowerCase()}`,
      detail: `Read it in Meta Business Suite > Account quality.${violation}${restriction}`.trim(),
      now,
    });
  }
}
