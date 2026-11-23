import express from "express";
import { Contact, Order, WebhookEvent, getSettings } from "../models/index.js";
import { RetryableError } from "../jobs/queue.js";
import { isDuplicateKeyError, withTransaction } from "../db.js";
import { historyEntry, paymentReceived, tellCustomer } from "../commerce/orders.js";
import * as say from "../commerce/messages.js";
import { isValidRazorpaySignature } from "./razorpay.js";

/** The job that creates a payment link for a prepaid order and sends it to the customer. */
export function createPaymentHandlers({ config, razorpay, now = () => new Date() }) {
  const tenantId = config.TENANT_ID;
  return {
    async "payment.createLink"({ orderId }) {
      const order = await Order.findById(orderId);
      if (!order || order.payment.linkId || order.payment.status === "paid" || order.status !== "awaiting_payment") return;
      if (!razorpay) throw new Error("Payment links are not set up (Razorpay settings missing)");
      const settings = await getSettings(tenantId);
      const contact = order.contactId ? await Contact.findById(order.contactId) : null;
      const reference = `${settings.orderPrefix}-${order.number}`;
      let link;
      try {
        link = await razorpay.createPaymentLink({
          amountPaise: order.totals.totalPaise,
          referenceId: reference,
          description: `Order ${reference}`,
          customerName: order.shipTo?.name || contact?.name || contact?.profileName,
          phone: contact?.waId,
          // Razorpay needs at least 15 minutes; the stock hold decides the real deadline.
          expiresAt: new Date(Math.max(order.holdUntil?.getTime() || 0, now().getTime() + 16 * 60_000)),
        });
      } catch (error) {
        if (error.retryable) throw new RetryableError(error.message);
        throw error;
      }
      await withTransaction(async (session) => {
        const fresh = await Order.findById(orderId).session(session);
        if (fresh.payment.linkId || fresh.status !== "awaiting_payment") return;
        fresh.payment.linkId = link.id;
        fresh.payment.url = link.url;
        fresh.history.push(historyEntry("system", "payment_link_created", "", now()));
        await tellCustomer({ tenantId, order: fresh, content: say.paymentLink(fresh, settings.orderPrefix, link.url, settings.paymentHoldMinutes), settings, session, now: now() });
        await fresh.save({ session });
      });
    },
  };
}

/**
 * Razorpay's webhook. Signature checked on the raw body; each event is stored once (Razorpay retries),
 * and a payment is applied only to an order still waiting for it - so a repeat changes nothing.
 */
export function createRazorpayWebhookRouter({ config, logger, now = () => new Date() }) {
  const router = express.Router();
  router.post("/webhooks/razorpay", express.raw({ type: () => true, limit: "1mb" }), async (req, res) => {
    const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
    if (!isValidRazorpaySignature(raw, req.get("x-razorpay-signature"), config.RAZORPAY_WEBHOOK_SECRET)) return res.sendStatus(401);
    let body;
    try {
      body = JSON.parse(raw.toString("utf8"));
    } catch {
      return res.sendStatus(400);
    }
    const linkId = body?.payload?.payment_link?.entity?.id;
    const eventId = req.get("x-razorpay-event-id") || `${body?.event}:${linkId}`;
    try {
      await withTransaction(async (session) => {
        await WebhookEvent.create([{ tenantId: config.TENANT_ID, key: `razorpay:${eventId}`, kind: "other", field: "razorpay", payload: body, processedAt: now() }], { session });
        if (body?.event !== "payment_link.paid" || !linkId) return;
        const order = await Order.findOne({ tenantId: config.TENANT_ID, "payment.linkId": linkId }).session(session);
        if (!order) return;
        await paymentReceived({ tenantId: config.TENANT_ID, order, session, now: now() });
      });
    } catch (error) {
      if (!isDuplicateKeyError(error)) {
        logger?.error({ err: { message: error?.message } }, "razorpay webhook could not be stored; Razorpay will retry");
        return res.sendStatus(503);
      }
    }
    return res.json({ ok: true });
  });
  return router;
}
