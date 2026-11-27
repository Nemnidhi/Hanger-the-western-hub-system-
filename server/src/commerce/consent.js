import { Conversation } from "../models/index.js";
import { queueOutbound } from "../whatsapp/outbound.js";

// Offers on WhatsApp only with the customer's yes (DPDP Act; WhatsApp's opt-in rule), and a STOP
// always works. Asked once, inside the chat window, right after an order goes through.

const DAY = 86_400_000;
const STOP = /^\s*(stop|stop promotions|stop offers|unsubscribe|no more offers)\s*[.!]*\s*$/i;
const START = /^\s*(start|start offers)\s*[.!]*\s*$/i;

/** "out", "in" or "" for a customer's message: STOP / START, the ask's buttons, or a template's Stop button. */
export function consentKeyword(message) {
  const id = String(message.data?.id || message.data?.payload || "");
  const text = String(message.text || "");
  if (id === "offers_no" || (message.type !== "interactive" && STOP.test(text))) return "out";
  if (id === "offers_yes" || (message.type === "text" && START.test(text))) return "in";
  return "";
}

/** Records a STOP or START from the chat and answers it. Returns true when the message was one. */
export async function handleConsentReply({ tenantId, message, contact, conversation, brandName, session, now = new Date() }) {
  const keyword = consentKeyword(message);
  if (!keyword) return false;
  const was = Boolean(contact.consents?.offers?.given);
  const source = message.type === "interactive" ? "whatsapp:button" : `whatsapp:${keyword === "in" ? "start" : "stop"}`;
  contact.set("consents.offers", { given: keyword === "in", at: now, source, askedAt: contact.consents?.offers?.askedAt || now });
  await contact.save({ session });
  const shop = brandName || "the shop";
  const text =
    keyword === "in"
      ? `Thank you! You'll hear about new arrivals and members' offers from ${shop} here. Reply STOP any time to stop them.`
      : was
        ? `Done: no more offers from ${shop}. Order updates will still come here. Reply START if you change your mind.`
        : "No problem, we won't send offers. Order updates will still come here.";
  await queueOutbound({ tenantId, session }, { conversationId: conversation._id, content: { text, purpose: "consent" } });
  return true;
}

/** Asks once whether she would like offers, when the chat window is open and she has not been asked. */
export async function maybeAskOffers({ tenantId, contact, brandName, session, now = new Date() }) {
  if (!contact || contact.consents?.offers?.given || contact.consents?.offers?.askedAt) return null;
  const conversation = await Conversation.findOne({ tenantId, contactId: contact._id }).session(session);
  if (!conversation?.lastInboundAt || now - conversation.lastInboundAt > DAY - 5 * 60_000) return null;
  contact.set("consents.offers.askedAt", now);
  await contact.save({ session });
  return queueOutbound(
    { tenantId, session },
    {
      conversationId: conversation._id,
      content: {
        text: `Would you like to hear about new arrivals and members' offers from ${brandName || "us"} on WhatsApp? A few messages a month at most, and you can reply STOP any time.`,
        buttons: [
          { id: "offers_yes", title: "Yes, tell me" },
          { id: "offers_no", title: "No thanks" },
        ],
        purpose: "consent",
      },
    },
  );
}
