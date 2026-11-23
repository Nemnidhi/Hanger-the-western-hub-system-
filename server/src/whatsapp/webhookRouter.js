import express from "express";
import { WebhookEvent } from "../models/index.js";
import { enqueue } from "../jobs/queue.js";
import { isDuplicateKeyError, withTransaction } from "../db.js";
import { isValidMetaSignature } from "./signature.js";
import { extractEvents } from "./events.js";

/**
 * Meta's webhook. The only work done before answering Meta is checking the signature and saving each
 * event with its processing job (one transaction per event). Processing happens in the worker, so a
 * slow step can never make Meta give up on a delivery, and nothing is lost if a process restarts.
 */
export function createWebhookRouter({ config, logger }) {
  const router = express.Router();

  // Meta's one-time check when the webhook address is saved in the app dashboard.
  router.get("/webhooks/whatsapp", (req, res) => {
    const { "hub.mode": mode, "hub.verify_token": token, "hub.challenge": challenge } = req.query;
    if (mode === "subscribe" && typeof token === "string" && token === config.WHATSAPP_VERIFY_TOKEN && typeof challenge === "string") {
      return res.status(200).type("text/plain").send(challenge);
    }
    return res.sendStatus(403);
  });

  router.post("/webhooks/whatsapp", express.raw({ type: () => true, limit: "2mb" }), async (req, res) => {
    const rawBody = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
    if (!isValidMetaSignature(rawBody, req.get("x-hub-signature-256"), config.WHATSAPP_APP_SECRET)) {
      logger?.warn({ ip: req.ip }, "webhook refused: bad signature");
      return res.sendStatus(401);
    }

    let body;
    try {
      body = JSON.parse(rawBody.toString("utf8"));
    } catch {
      return res.sendStatus(400);
    }

    const events = extractEvents(body, { phoneNumberId: config.WHATSAPP_PHONE_NUMBER_ID });
    let stored = 0;
    let duplicates = 0;
    try {
      for (const event of events) {
        try {
          await withTransaction(async (session) => {
            const [saved] = await WebhookEvent.create([{ tenantId: config.TENANT_ID, ...event }], { session });
            await enqueue("whatsapp.event", { eventId: String(saved._id) }, { session, dedupeKey: `event:${config.TENANT_ID}:${event.key}` });
          });
          stored += 1;
        } catch (error) {
          if (!isDuplicateKeyError(error)) throw error;
          duplicates += 1;
        }
      }
    } catch (error) {
      // Not saved: answer with an error so Meta delivers it again. Events already saved are ignored then.
      logger?.error({ err: { message: error?.message } }, "webhook could not be stored; Meta will retry");
      return res.sendStatus(503);
    }

    if (events.length) logger?.info({ stored, duplicates }, "webhook stored");
    return res.sendStatus(200);
  });

  return router;
}
