import { Contact, Conversation, Message } from "../models/index.js";
import { enqueue } from "../jobs/queue.js";
import { withTransaction } from "../db.js";

/**
 * Queues a message to a customer. Pass `session` to save it inside the caller's own transaction. The message and its sending job are saved in one transaction, so
 * there is never a message that "should have gone" with no job to send it. Returns the message.
 * `content` is { text }, { text, buttons: [{ id, title }] }, { text, products: { header, footer, catalogId,
 * sections: [{ title, productRetailerIds }] } } or { template: { name, language, components } },
 * optionally with `purpose`, `orderId`, `offerId` and an SMS `fallback` ({ kind, vars }) for when
 * WhatsApp cannot deliver it.
 */
export async function queueOutbound({ tenantId, session: outer }, { conversationId, content }) {
  const run = (fn) => (outer ? fn(outer) : withTransaction(fn));
  return run(async (session) => {
    const conversation = await Conversation.findOne({ _id: conversationId, tenantId }).session(session);
    if (!conversation) throw Object.assign(new Error("Conversation not found"), { status: 404 });
    const contact = await Contact.findOne({ _id: conversation.contactId, tenantId }).session(session);
    if (!contact) throw Object.assign(new Error("Customer not found"), { status: 404 });

    const isTemplate = Boolean(content?.template);
    const isButtons = Boolean(content?.buttons?.length);
    const isProducts = Boolean(content?.products?.sections?.length);
    const text = isTemplate ? "" : String(content?.text || "").trim();
    if (!isTemplate && !text) throw Object.assign(new Error("Message text is required"), { status: 400 });

    const [message] = await Message.create(
      [
        {
          tenantId,
          conversationId: conversation._id,
          contactId: contact._id,
          direction: "out",
          type: isTemplate ? "template" : isProducts ? "products" : isButtons ? "interactive" : "text",
          text,
          template: isTemplate ? content.template : null,
          data: isProducts ? { products: content.products } : isButtons ? { buttons: content.buttons } : null,
          status: "queued",
          purpose: content.purpose || "chat",
          orderId: content.orderId || null,
          offerId: content.offerId || null,
          fallback: content.fallback || null,
        },
      ],
      { session },
    );
    await enqueue("whatsapp.send", { messageId: String(message._id) }, { session, dedupeKey: `send:${message._id}` });
    return message;
  });
}

/**
 * Records an SMS to a customer (shown in their chat as an SMS) and queues its sending. Used when an
 * order message cannot go on WhatsApp at all (24 hours passed and no template).
 */
export async function queueSms({ tenantId, session }, { conversationId, contactId, text, orderId, fallback }) {
  const [message] = await Message.create(
    [{ tenantId, conversationId, contactId, direction: "out", type: "sms", text, status: "queued", purpose: "order", orderId: orderId || null, fallback, sms: { status: "queued" } }],
    session ? { session } : {},
  );
  await enqueue("sms.send", { messageId: String(message._id) }, { session, dedupeKey: `sms:${message._id}` });
  return message;
}

/** WhatsApp could not deliver an order message: send its SMS backup (once). */
export async function smsBackup(message, session) {
  if (!message?.fallback?.kind || message.sms?.status) return;
  const updated = await Message.updateOne({ _id: message._id, "sms.status": "" }, { $set: { "sms.status": "queued" } }, { session });
  if (updated.modifiedCount) await enqueue("sms.send", { messageId: String(message._id) }, { session, dedupeKey: `sms:${message._id}` });
}
