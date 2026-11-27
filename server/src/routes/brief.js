import express from "express";
import { DailySummary, getSettings } from "../models/index.js";
import { requireAuth, requirePermission } from "../auth/middleware.js";
import { withTransaction } from "../db.js";
import { audit } from "../audit.js";
import { route } from "./validate.js";
import { briefHeadline, briefText, buildBrief, sendBrief } from "../commerce/brief.js";

// The morning brief in the staff app: today's, fresh, with what was sent; and "send it now".
export function createBriefRouter({ config }) {
  const router = express.Router();
  const tenantId = config.TENANT_ID;

  router.get("/api/brief", requireAuth(), requirePermission("reports:read"), route(async (req, res) => {
    const settings = await getSettings(tenantId);
    const brief = await buildBrief({ tenantId });
    const kept = await DailySummary.findOne({ tenantId, date: brief.date }).lean();
    res.json({ brief, headline: briefHeadline(brief), text: briefText(brief, settings.brandName || "The Hanger"), sent: kept?.data?.sentAt ? { at: kept.data.sentAt, results: kept.data.results || [] } : null, settings: settings.brief });
  }));

  router.post("/api/brief/send", requireAuth(), requirePermission("settings:write"), route(async (req, res) => {
    const brief = await buildBrief({ tenantId });
    const sent = await withTransaction((session) => sendBrief({ tenantId, brief, session }));
    await audit({ req, action: "brief.send", meta: { results: sent.results.map((row) => row.sent) } });
    res.json({ results: sent.results });
  }));

  return router;
}
