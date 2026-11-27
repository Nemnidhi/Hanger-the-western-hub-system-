import express from "express";
import { requireAuth, requirePermission } from "../auth/middleware.js";
import { route } from "./validate.js";
import { gstReport, istDay, salesReport, stockReport } from "../commerce/reports.js";

// The owner's and manager's reports: sales, stock and slow pieces, and the month's GST summary.

export function createReportsRouter({ config }) {
  const router = express.Router();
  const tenantId = config.TENANT_ID;
  const text = (value) => (typeof value === "string" ? value : undefined);

  router.get("/api/reports/sales", requireAuth(), requirePermission("reports:read"), route(async (req, res) => {
    res.json(await salesReport({ tenantId, from: text(req.query.from), to: text(req.query.to) }));
  }));

  router.get("/api/reports/stock", requireAuth(), requirePermission("reports:read"), route(async (req, res) => {
    res.json(await stockReport({ tenantId }));
  }));

  router.get("/api/reports/gst", requireAuth(), requirePermission("reports:read"), route(async (req, res) => {
    res.json(await gstReport({ tenantId, month: text(req.query.month) || istDay(new Date()).slice(0, 7) }));
  }));

  return router;
}
