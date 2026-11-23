import { Contact, Message } from "../models/index.js";
import { RetryableError } from "../jobs/queue.js";
import { indianMobile, SmsError } from "./msg91.js";

/** Sends the SMS backup of an order message. Safe to run twice: a sent SMS is never sent again. */
export function createSmsHandlers({ sms, now = () => new Date() }) {
  async function finish(message, set) {
    const update = { ...Object.fromEntries(Object.entries(set).map(([key, value]) => [`sms.${key}`, value])), "sms.at": now() };
    // An SMS-only message takes the SMS's outcome as its own status.
    if (message.type === "sms") Object.assign(update, { status: set.status === "sent" ? "sent" : "failed", statusAt: now(), ...(set.status === "sent" ? { sentAt: now() } : { error: { code: 0, text: set.error, action: "Call the customer." } }) });
    await Message.updateOne({ _id: message._id }, { $set: update });
  }

  return {
    async "sms.send"({ messageId }, { job } = {}) {
      const message = await Message.findById(messageId);
      if (!message?.fallback?.kind || ["sent", "not_possible"].includes(message.sms?.status)) return;
      if (!sms) return finish(message, { status: "not_possible", error: "SMS backup is not set up" });
      const contact = await Contact.findById(message.contactId);
      const mobile = indianMobile(contact?.waId);
      if (!mobile) return finish(message, { status: "not_possible", error: "Not an Indian mobile number" });
      try {
        const { requestId } = await sms.send(message.fallback.kind, mobile, message.fallback.vars || []);
        await finish(message, { status: "sent", requestId, error: "" });
      } catch (error) {
        const lastAttempt = (job?.attempts || 1) >= (job?.maxAttempts || 1);
        if (error instanceof SmsError && error.retryable && !lastAttempt) throw new RetryableError(error.message);
        await finish(message, { status: "failed", error: String(error?.message || error).slice(0, 300) });
      }
    },
  };
}
