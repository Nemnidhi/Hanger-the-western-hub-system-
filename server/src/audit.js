import { AuditLog } from "./models/index.js";

/**
 * Records an action. Pass `session` to write it inside the action's own transaction. Outside a
 * transaction a failed audit write is logged but never blocks the action itself.
 */
export async function audit({ req, tenantId, actor, action, targetType = "", targetId = "", meta = null, session, logger }) {
  const doc = {
    tenantId: tenantId || req?.tenantId || actor?.tenantId,
    actorId: actor?._id || req?.user?._id || null,
    actorName: actor?.name || req?.user?.name || "",
    action,
    targetType,
    targetId: String(targetId || ""),
    meta,
    ip: String(req?.ip || "").slice(0, 64),
  };
  if (session) {
    await AuditLog.create([doc], { session });
    return;
  }
  try {
    await AuditLog.create(doc);
  } catch (error) {
    logger?.error({ err: { message: error?.message }, action }, "audit write failed");
  }
}
