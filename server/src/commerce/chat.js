import mongoose from "mongoose";
import { answerBriefRequest } from "./brief.js";
import { Contact, Conversation, Message, Order, OPEN_STATUSES, getSettings } from "../models/index.js";
import { withTransaction } from "../db.js";
import { enqueue } from "../jobs/queue.js";
import { queueOutbound } from "../whatsapp/outbound.js";
import { cancelOrder, choosePayment, confirmOrder, placeOnlineOrder, setAddress } from "./orders.js";
import * as say from "./messages.js";
import { handleConsentReply, maybeAskOffers } from "./consent.js";

// Taking an order in the WhatsApp chat. The customer builds a cart in the WhatsApp catalogue and sends
// it; the chat then asks for the address and the payment choice. Anything that is not part of an open
// order (questions, photos, "do you have this in red?") is left for staff in the inbox.

const PAY_WORDS = { prepaid: /\b(pay|upi|online|card|gpay|phonepe|paytm)\b/i, cod: /\b(cod|cash)\b/i };

/** The job run for every new inbound message ("order.intake"). Safe to run twice. */
export function createChatHandlers({ config, razorpay, now = () => new Date() }) {
  const tenantId = config.TENANT_ID;
  const razorpayReady = Boolean(razorpay);

  async function reply(conversationId, content, session) {
    return queueOutbound({ tenantId, session }, { conversationId, content: { ...content, purpose: "order" } });
  }

  async function handleCart(message, contact, session) {
    try {
      await placeOnlineOrder({ tenantId, channel: "whatsapp", contact, conversationId: message.conversationId, items: message.data?.items || [], session, now: now() });
    } catch (error) {
      if (error.code === "OUT_OF_STOCK") return { reply: say.outOfStock(error.short) };
      if (error.code === "UNKNOWN_ITEMS") return { reply: say.unknownItems(error.unknown) };
      throw error;
    }
    return null;
  }

  async function handleStep(message, contact, order, session) {
    const choice = message.type === "interactive" ? String(message.data?.id || "") : "";
    const text = String(message.text || "").trim();
    const at = now();

    if (choice === "order_cancel") return cancelOrder({ tenantId, order, by: "customer", reason: "cancelled by the customer", session, now: at });

    if (order.chatStep === "awaiting_address") {
      if (choice === "addr_new") return { reply: say.askAddressAgain() };
      if (choice === "addr_saved" && contact.lastAddress?.address) {
        return setAddress({ tenantId, order, address: contact.lastAddress.address, name: contact.lastAddress.name, razorpayReady, session, now: at });
      }
      if (!text) return { reply: say.askAddressAgain() };
      try {
        return await setAddress({ tenantId, order, address: text, name: contact.name || contact.profileName, razorpayReady, session, now: at });
      } catch (error) {
        if (error.code === "NO_PINCODE") return { reply: say.askAddressAgain() };
        throw error;
      }
    }

    if (order.chatStep === "awaiting_payment_choice" || (order.chatStep === "awaiting_cod_confirm" && choice === "pay_prepaid")) {
      const method = choice === "pay_prepaid" ? "prepaid" : choice === "pay_cod" ? "cod" : PAY_WORDS.cod.test(text) ? "cod" : PAY_WORDS.prepaid.test(text) ? "prepaid" : "";
      if (!method) return { reply: { text: "Please tap one of the payment buttons above." } };
      try {
        return await choosePayment({ tenantId, order, method, razorpayReady, session, now: at });
      } catch (error) {
        if (["NO_COD", "NO_PAYMENTS"].includes(error.code)) return { reply: { text: error.message } };
        throw error;
      }
    }

    if (order.chatStep === "awaiting_cod_confirm" && choice === "cod_yes" && order.cod.band !== "high") {
      return confirmOrder({ tenantId, order, by: "customer", session, now: at });
    }
    return null;
  }

  return {
    async "order.intake"({ messageId }) {
      // Marked handled in the same transaction as everything it does: a crash undoes both, and two
      // workers on the same message conflict, so only one of them gets through.
      await withTransaction(async (session) => {
        const message = await Message.findOne({ _id: messageId, intakeAt: null }).session(session);
        if (!message) return;
        await Message.updateOne({ _id: message._id }, { $set: { intakeAt: now() } }, { session });
        const contact = await Contact.findById(message.contactId).session(session);
        const conversation = await Conversation.findById(message.conversationId).session(session);
        if (!contact || !conversation) return;
        const settings = await getSettings(tenantId, session);
        // STOP / START and the offers question's buttons come first: they are never part of an order.
        // The owner asking for the morning brief.
        if (await answerBriefRequest({ tenantId, message, contact, conversation, session, now: now() })) return;
        if (await handleConsentReply({ tenantId, message, contact, conversation, brandName: settings.brandName, session, now: now() })) return;
        {
          let outcome = null;
          let order = null;
          if (message.type === "order") {
            outcome = await handleCart(message, contact, session);
          } else {
            order = await Order.findOne({ tenantId, contactId: contact._id, status: mongoose.trusted({ $in: OPEN_STATUSES }), chatStep: mongoose.trusted({ $ne: "" }) })
              .sort({ createdAt: -1 })
              .session(session);
            if (order) outcome = await handleStep(message, contact, order, session);
          }
          if (outcome?.reply) await reply(conversation._id, outcome.reply, session);
          // A question in her own words, with no order step waiting on it: the stylist answers (when on).
          else if (!outcome && !order && message.type === "text" && String(message.text || "").trim() && settings.stylist?.enabled) {
            await enqueue("stylist.reply", { messageId: String(message._id) }, { session, dedupeKey: `stylist:${message._id}` });
          }
          // Her order just went through in the chat: the moment to ask, once, about offers.
          if (order?.status === "confirmed") await maybeAskOffers({ tenantId, contact, brandName: settings.brandName, session, now: now() });
        }
      });
    },
  };
}
