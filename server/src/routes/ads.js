import express from "express";
import { z } from "zod";
import { requireAuth, requirePermission } from "../auth/middleware.js";
import { parseBody, route } from "./validate.js";
import { adsSummary } from "../ads/meta.js";

// The Ads page: Meta's spend and clicks per campaign beside our own sales from those campaigns.
export function createAdsRouter({ config, services }) {
  const router = express.Router();
  router.get("/api/ads/summary", requireAuth(), requirePermission("reports:read"), route(async (req, res) => {
    const query = parseBody(z.object({ days: z.coerce.number().int().refine((value) => [1, 7, 14, 30, 90].includes(value), "1, 7, 14, 30 or 90 days").default(7) }), { body: req.query });
    res.json(await adsSummary({ tenantId: config.TENANT_ID, config, fetchImpl: services.fetchImpl, days: query.days }));
  }));
  return router;
}
