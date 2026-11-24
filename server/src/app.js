import express from "express";
import path from "node:path";
import { existsSync } from "node:fs";
import helmet from "helmet";
import mongoose from "mongoose";
import { randomUUID } from "node:crypto";
import { queueStats } from "./jobs/queue.js";
import { createWebhookRouter } from "./whatsapp/webhookRouter.js";
import { createServices } from "./services.js";
import { requireAppHeader } from "./auth/middleware.js";
import { createAuthRouter } from "./routes/auth.js";
import { createUsersRouter } from "./routes/users.js";
import { createInboxRouter } from "./routes/inbox.js";
import { createRealtimeHub } from "./realtime/hub.js";
import { createCommerceRouter } from "./routes/commerce.js";
import { createUploadsRouter } from "./routes/uploads.js";
import { createRazorpayWebhookRouter } from "./payments/handlers.js";
import { createCourierWebhookRouter } from "./shipping/courier.js";

// Jobs waiting longer than this mean the worker is down or stuck: the readiness check fails so the
// uptime monitor alerts someone.
const QUEUE_OVERDUE_ALERT_SECONDS = 120;

export function createApp({ config, logger, fetchImpl, services = createServices(config, { fetchImpl }) }) {
  const app = express();
  app.disable("x-powered-by");
  app.set("trust proxy", 1);
  app.use(helmet());

  app.use((req, res, next) => {
    req.id = req.get("x-request-id") || randomUUID();
    res.set("x-request-id", req.id);
    next();
  });

  // Liveness: the process is up. Used by pm2/the load balancer to restart a hung process.
  app.get("/health", (req, res) => res.json({ ok: true }));

  // Readiness: the database answers and the worker keeps up. Used by the uptime monitor.
  app.get("/ready", async (req, res) => {
    try {
      await mongoose.connection.db.admin().command({ ping: 1 });
      const queue = await queueStats();
      const ok = queue.overdueSeconds < QUEUE_OVERDUE_ALERT_SECONDS;
      res.status(ok ? 200 : 503).json({ ok, database: "ok", queue });
    } catch {
      res.status(503).json({ ok: false, database: "unreachable" });
    }
  });

  // The webhook reads its own raw body (signature check), so it is mounted before the JSON parser.
  app.use(createWebhookRouter({ config, logger }));
  app.use(createRazorpayWebhookRouter({ config, logger }));
  app.use(createCourierWebhookRouter({ config, logger }));

  const realtime = createRealtimeHub({ tenantId: config.TENANT_ID, logger });
  app.locals.realtime = realtime;

  // Photos are read as raw bytes; mounted before the JSON parser. Changes still need the app header.
  app.use("/api/uploads", requireAppHeader);
  app.use(createUploadsRouter({ config }));

  app.use("/api", express.json({ limit: "1mb" }));
  app.use("/api", requireAppHeader);
  app.use("/api", (req, res, next) => {
    res.set("Cache-Control", "no-store");
    next();
  });
  app.use(createAuthRouter({ config, logger }));
  app.use(createUsersRouter({ logger }));
  app.use(createInboxRouter({ config, logger, client: services.client, realtime }));
  app.use(createCommerceRouter({ config, services }));

  // The built staff app, with every non-API path answered by index.html (client-side pages).
  const webDir = config.WEB_DIST_DIR ? path.resolve(config.WEB_DIST_DIR) : "";
  if (webDir && existsSync(path.join(webDir, "index.html"))) {
    app.use(express.static(webDir, { index: false, maxAge: "1h", setHeaders: (res, file) => {
      if (file.includes(`${path.sep}assets${path.sep}`)) res.set("Cache-Control", "public, max-age=31536000, immutable");
    } }));
    app.get(/^(?!\/api\/|\/webhooks\/).*/, (req, res) => {
      res.set("Cache-Control", "no-cache");
      res.sendFile(path.join(webDir, "index.html"));
    });
  }

  app.use((req, res) => res.status(404).json({ error: "NOT_FOUND" }));

  // Errors never leak internals to the caller; server errors are logged with the request id.
  // eslint-disable-next-line no-unused-vars
  app.use((error, req, res, next) => {
    let status = Number(error?.status) || 500;
    if (error?.name === "ZodError") status = 400;
    if (status < 400 || status > 599) status = 500;
    if (status >= 500) logger?.error({ err: { message: error?.message, stack: error?.stack }, requestId: req.id }, "request failed");
    if (res.headersSent) return res.end();
    res.status(status).json({
      error: status >= 500 ? "INTERNAL_ERROR" : error.code || "BAD_REQUEST",
      message: status >= 500 ? "Something went wrong. Please try again." : error?.name === "ZodError" ? "Invalid request." : error.message,
      ...(status < 500 && Array.isArray(error?.blockers) ? { blockers: error.blockers } : {}),
      requestId: req.id,
    });
  });

  return app;
}
