import mongoose from "mongoose";
import { Contact, Conversation, Order, getSettings } from "../models/index.js";
import { withTransaction } from "../db.js";
import { enqueue } from "../jobs/queue.js";
import { queueOutbound } from "../whatsapp/outbound.js";
import { picksFor, picksMessage, waIdFromPhone } from "./picks.js";

// Sending outfit picks on WhatsApp: by staff from the trial room screen, or automatically after a
// customer saves or leaves a look on the website. Picks are marketing in WhatsApp's terms, so they
// go only to a customer who agreed to them (her "offers" consent), and automatic ones keep a gap.

const DAY_MS = 24 * 60 * 60 * 1000;
const fail = (status, message, code) => Object.assign(new Error(message), { status, code });
const firstName = (name) => String(name || "").trim().split(/\s+/)[0] || "";

/** Her contact and chat, created if this is the first time (a walk-in giving her number in store). */
async function contactAndChat({ tenantId, waId, session }) {
  const contact = await Contact.findOneAndUpdate({ tenantId, waId }, { $setOnInsert: { firstSeenAt: new Date() } }, { upsert: true, new: true, session });
  const conversation = await Conversation.findOneAndUpdate({ tenantId, contactId: contact._id }, { $setOnInsert: { status: "open" } }, { upsert: true, new: true, session });
  return { contact, conversation };
}

/**
 * Works out the picks and queues the message. `styleCodes` limits it to the picks staff chose;
 * otherwise the best three. `consentNow` records that she agreed in the store just now (by `by`).
 * Returns { message, via, picks } or throws a 4xx with the reason in plain words.
 */
export async function sendPicks({ tenantId, config, phone, pieces, styleCodes = [], locationCode = "", letter = "", waist = "", consentNow = false, by = null, automatic = false, now = new Date() }) {
  const waId = waIdFromPhone(phone);
  if (!waId) throw fail(400, "Type her 10-digit mobile number", "BAD_PHONE");
  const result = await picksFor({ tenantId, pieces, phone: waId, letter, waist, locationCode, limit: 10, now });
  const pool = [...result.complete, ...result.swap];
  const chosen = styleCodes.length ? styleCodes.map((code) => pool.find((pick) => pick.styleCode === String(code).toUpperCase())).filter(Boolean) : pool.slice(0, 3);
  if (!chosen.length) throw fail(409, "No picks in stock in her size to send", "NO_PICKS");
  const settings = await getSettings(tenantId);

  return withTransaction(async (session) => {
    const { contact, conversation } = await contactAndChat({ tenantId, waId, session });
    if (consentNow && !contact.consents?.offers?.given) {
      contact.set("consents.offers", { given: true, at: now, source: `store:${by?.name || by?.email || "staff"}`, askedAt: now });
    }
    if (!contact.consents?.offers?.given) throw fail(409, "She has not agreed to picks on WhatsApp. Ask her, then tick that she agreed.", "NO_CONSENT");
    if (automatic) {
      const gapDays = settings.picks?.minGapDays ?? 7;
      if (contact.picks?.lastSentAt && now - contact.picks.lastSentAt < gapDays * DAY_MS) throw fail(409, `Picks went to her less than ${gapDays} days ago`, "TOO_SOON");
    }
    const insideWindow = Boolean(conversation.lastInboundAt && now - conversation.lastInboundAt < DAY_MS);
    const anchor = result.trying.at(-1)?.name || "";
    const message = picksMessage({
      firstName: firstName(contact.name || contact.profileName),
      anchorName: anchor,
      picks: chosen,
      catalogId: config.META_CATALOG_ID,
      insideWindow,
      template: settings.picks?.template,
      brandName: settings.brandName,
      storeLine: `${settings.brandName} · ${result.location.kind === "store" ? result.location.name : "free size exchange"}`,
    });
    if (!message) {
      throw fail(409, "She has not messaged the shop in the last 24 hours, so WhatsApp allows only an approved template. Add the picks template in Settings, under Outfit picks.", "NEEDS_TEMPLATE");
    }
    contact.set("picks.lastSentAt", now);
    await contact.save({ session });
    const queued = await queueOutbound({ tenantId, session }, { conversationId: conversation._id, content: message.content });
    return { message: queued, via: message.kind, picks: chosen, contactId: contact._id };
  });
}

/**
 * Called when a customer saves or leaves a look on the website: queues the automatic picks for later
 * (Settings > Outfit picks: on/off and the delay). One per customer per day at most.
 */
export async function schedulePicksFollowUp({ tenantId, phone, pieces, now = new Date() }) {
  const settings = await getSettings(tenantId);
  if (!settings.picks?.autoSend) return null;
  const waId = waIdFromPhone(phone);
  if (!waId || !pieces?.length) return null;
  const day = now.toISOString().slice(0, 10);
  return enqueue("picks.followUp", { waId, pieces: pieces.slice(0, 6), since: now.toISOString() }, { runAt: new Date(now.getTime() + (settings.picks.autoSendDelayMinutes || 60) * 60_000), dedupeKey: `picks:${waId}:${day}` });
}

export function createPicksHandlers({ config, now = () => new Date() }) {
  const tenantId = config.TENANT_ID;
  return {
    /** The automatic picks. A customer who bought in the meantime, or who did not agree, gets nothing. */
    async "picks.followUp"({ waId, pieces, since }) {
      const settings = await getSettings(tenantId);
      if (!settings.picks?.autoSend) return;
      const contact = await Contact.findOne({ tenantId, waId });
      if (!contact?.consents?.offers?.given) return;
      // She ordered after leaving the bag: no picks.
      if (since && (await Order.exists({ tenantId, contactId: contact._id, createdAt: mongoose.trusted({ $gte: new Date(since) }) }))) return;
      try {
        await sendPicks({ tenantId, config, phone: waId, pieces, automatic: true, now: now() });
      } catch (error) {
        // Not agreed, too soon, nothing in stock, no template: nothing to send, and nothing to retry.
        if (error.status && error.status < 500) return;
        throw error;
      }
    },
  };
}

/** Saves her sizes from the trial room, so the next picks (and the website) know them. */
export async function saveCustomerSizes({ tenantId, phone, usualSize, waist }) {
  const waId = waIdFromPhone(phone);
  if (!waId) throw fail(400, "Type her 10-digit mobile number", "BAD_PHONE");
  const set = {};
  if (usualSize !== undefined) set["fit.usualSize"] = usualSize;
  if (waist !== undefined) set["fit.waist"] = waist;
  return Contact.findOneAndUpdate({ tenantId, waId }, { $set: set, $setOnInsert: { firstSeenAt: new Date() } }, { upsert: true, new: true });
}

