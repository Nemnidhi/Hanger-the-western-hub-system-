import { createServices } from "./services.js";
import { createWhatsAppHandlers } from "./whatsapp/handlers.js";
import { createChatHandlers } from "./commerce/chat.js";
import { createPaymentHandlers } from "./payments/handlers.js";
import { createMetaCatalogHandlers } from "./commerce/metaCatalog.js";
import { createSmsHandlers } from "./sms/handlers.js";
import { createShippingHandlers } from "./shipping/courier.js";
import { Order } from "./models/index.js";
import { withTransaction } from "./db.js";
import { expireHold } from "./commerce/orders.js";

/** Every job the worker knows how to run. Each is safe to run twice. */
export function createHandlers({ config, now = () => new Date(), services = createServices(config) }) {
  const { client, razorpay, sms, courier, fetchImpl } = services;
  return {
    // Each new inbound message also gets an "order.intake" job, in the same transaction as the message.
    ...createWhatsAppHandlers({ config, client, now, afterInbound: ["order.intake"] }),
    ...createChatHandlers({ config, razorpay, now }),
    ...createPaymentHandlers({ config, razorpay, now }),
    ...createMetaCatalogHandlers({ config, fetchImpl, now }),
    ...createSmsHandlers({ sms, now }),
    ...createShippingHandlers({ config, courier, now }),
    // A held cart that was not paid / confirmed / given an address in time gives its stock back.
    async "order.holdExpiry"({ orderId }) {
      await withTransaction(async (session) => {
        const order = await Order.findOne({ _id: orderId, tenantId: config.TENANT_ID }).session(session);
        if (order) await expireHold({ tenantId: config.TENANT_ID, order, session, now: now() });
      });
    },
  };
}
