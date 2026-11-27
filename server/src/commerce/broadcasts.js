import mongoose from "mongoose";
import { Broadcast, Contact, Conversation, Message, Order, Style, Template, getSettings } from "../models/index.js";
import { enqueue } from "../jobs/queue.js";
import { isDuplicateKeyError, withTransaction } from "../db.js";
import { queueOutbound } from "../whatsapp/outbound.js";
import { waIdFromPhone } from "./picks.js";

// WhatsApp broadcasts: an approved Marketing template to the customers who agreed to offers, chosen by
// what they bought, when, their size and where they live. Sent in small batches by the worker, inside
// the shop's sending hours and the number's daily limit, never twice to one customer, and never to a
// customer who had an offer in the last few days (Settings). Results: delivered, read, replies, orders.

const DAY = 86_400_000;
const BATCH = 100;
const SOLD = ["confirmed", "packed", "shipped", "delivered"];
const trusted = (filter) => mongoose.trusted(filter);
const fail = (status, message, code) => Object.assign(new Error(message), { status, code });
const firstName = (name) => String(name || "").trim().split(/\s+/)[0] || "";

/** What each customer has bought (online orders by contact, store bills by phone number). */
async function customerHistory(tenantId, contacts) {
  const byId = new Map(contacts.map((contact) => [String(contact._id), contact]));
  const byWaId = new Map(contacts.map((contact) => [contact.waId, String(contact._id)]));
  const orders = await Order.find({ tenantId, status: trusted({ $in: SOLD }) }, { contactId: 1, channel: 1, "customer.phone": 1, createdAt: 1, "totals.totalPaise": 1, "lines.styleCode": 1 }).lean();
  const styleCodes = [...new Set(orders.flatMap((order) => order.lines.map((line) => line.styleCode)))];
  const styles = await Style.find({ tenantId, code: trusted({ $in: styleCodes }) }, { code: 1, category: 1 }).lean();
  const category = new Map(styles.map((style) => [style.code, style.category]));
  const history = new Map();
  for (const order of orders) {
    const id = order.contactId ? String(order.contactId) : byWaId.get(waIdFromPhone(order.customer?.phone));
    if (!id || !byId.has(id)) continue;
    const row = history.get(id) || { orders: 0, spendPaise: 0, lastOrderAt: null, categories: new Set() };
    row.orders += 1;
    row.spendPaise += order.totals?.totalPaise || 0;
    if (!row.lastOrderAt || order.createdAt > row.lastOrderAt) row.lastOrderAt = order.createdAt;
    for (const line of order.lines) if (category.get(line.styleCode)) row.categories.add(category.get(line.styleCode));
    history.set(id, row);
  }
  return history;
}

/**
 * The customers a broadcast would reach now, and how many were left out and why. Only customers who
 * agreed to offers; then the filters; then anyone who had an offer within the gap is held back.
 */
export async function findAudience({ tenantId, audience = {}, broadcastId = null, now = new Date() }) {
  const settings = await getSettings(tenantId);
  const everyone = await Contact.countDocuments({ tenantId });
  const contacts = await Contact.find({ tenantId, "consents.offers.given": true }, { waId: 1, name: 1, profileName: 1, fit: 1, lastAddress: 1, lastInboundAt: 1 }).lean();
  const history = await customerHistory(tenantId, contacts);
  const sizes = (audience.sizes || []).map((size) => size.toUpperCase());
  const categories = (audience.categories || []).map((name) => name.toLowerCase());
  const pincodes = audience.pincodePrefixes || [];

  const matches = contacts.filter((contact) => {
    const bought = history.get(String(contact._id));
    const sinceLast = bought?.lastOrderAt ? (now - bought.lastOrderAt) / DAY : Infinity;
    if (audience.neverBought && bought) return false;
    if (audience.lastBoughtWithinDays && !(sinceLast <= audience.lastBoughtWithinDays)) return false;
    if (audience.notBoughtForDays && !(bought && sinceLast >= audience.notBoughtForDays)) return false;
    if (categories.length && !categories.some((name) => bought?.categories.has(name))) return false;
    if (sizes.length && !sizes.includes(String(contact.fit?.usualSize || "").toUpperCase())) return false;
    if (audience.minSpendPaise && !((bought?.spendPaise || 0) >= audience.minSpendPaise)) return false;
    if (pincodes.length && !pincodes.some((prefix) => String(contact.lastAddress?.pincode || "").startsWith(prefix))) return false;
    if (audience.chattedWithinDays && !(contact.lastInboundAt && now - contact.lastInboundAt <= audience.chattedWithinDays * DAY)) return false;
    return true;
  });

  // One offer per customer per gap: anyone sent an offer (another broadcast, picks) recently waits.
  const gapDays = settings.broadcasts?.minGapDays ?? 3;
  const recent = gapDays
    ? await Message.distinct("contactId", {
        tenantId,
        direction: "out",
        purpose: trusted({ $in: ["offer", "picks"] }),
        createdAt: trusted({ $gte: new Date(now.getTime() - gapDays * DAY) }),
        ...(broadcastId ? { offerId: trusted({ $ne: broadcastId }) } : {}),
      })
    : [];
  const recentSet = new Set(recent.map(String));
  const recipients = matches.filter((contact) => !recentSet.has(String(contact._id)));
  return {
    recipients,
    counts: { customers: everyone, agreed: contacts.length, matching: matches.length, heldBack: matches.length - recipients.length, reach: recipients.length },
    gapDays,
  };
}

/** The template's send format, with this customer's blanks filled. */
export function templateFor({ template, broadcast, contact, brandName }) {
  const fill = (text) =>
    String(text)
      .replace(/\{first_name\}/g, firstName(contact.name || contact.profileName) || "there")
      .replace(/\{size\}/g, contact.fit?.usualSize || "your size")
      .replace(/\{brand\}/g, brandName || "")
      .trim() || "-";
  const components = [];
  if (broadcast.headerImageUrl) components.push({ type: "header", parameters: [{ type: "image", image: { link: broadcast.headerImageUrl } }] });
  if (broadcast.params.length) components.push({ type: "body", parameters: broadcast.params.map((text) => ({ type: "text", text: fill(text) })) });
  const urlButton = urlButtonIndex(template);
  if (urlButton >= 0 && broadcast.urlSuffix) components.push({ type: "button", sub_type: "url", index: String(urlButton), parameters: [{ type: "text", text: fill(broadcast.urlSuffix) }] });
  return { name: template.name, language: template.language, components };
}

const headerOf = (template) => (template.components || []).find((part) => String(part.type).toUpperCase() === "HEADER");
function urlButtonIndex(template) {
  const buttons = (template.components || []).find((part) => String(part.type).toUpperCase() === "BUTTONS")?.buttons || [];
  return buttons.findIndex((button) => String(button.type).toUpperCase() === "URL" && /\{\{\d+\}\}/.test(button.url || ""));
}

/** Checks the broadcast against its template: approved, Marketing, the right number of blanks. */
export async function checkTemplate({ tenantId, broadcast }) {
  const template = await Template.findOne({ tenantId, name: broadcast.template.name, language: broadcast.template.language }).lean();
  if (!template) throw fail(400, "That template is not in the app. Refresh the templates from WhatsApp first.", "NO_TEMPLATE");
  if (template.status !== "APPROVED") throw fail(409, `The template is ${template.status.toLowerCase() || "not approved"}; only approved templates can be sent.`, "TEMPLATE_NOT_APPROVED");
  if (template.category && template.category !== "MARKETING") throw fail(409, "Broadcasts use Marketing templates (WhatsApp's rule for offers and new arrivals).", "NOT_MARKETING");
  if (broadcast.params.length !== (template.paramCount || 0)) throw fail(400, `The template has ${template.paramCount || 0} blank${template.paramCount === 1 ? "" : "s"}; fill each one.`, "PARAM_COUNT");
  const header = headerOf(template);
  const format = String(header?.format || "").toUpperCase();
  if (format === "IMAGE" && !broadcast.headerImageUrl) throw fail(400, "This template starts with a photo: give the photo's web address.", "NEEDS_IMAGE");
  if (["VIDEO", "DOCUMENT"].includes(format)) throw fail(400, "Templates with a video or document header are not supported yet.", "HEADER_UNSUPPORTED");
  if (format !== "IMAGE" && broadcast.headerImageUrl) throw fail(400, "This template has no photo header.", "NO_IMAGE_HEADER");
  if (urlButtonIndex(template) >= 0 && !broadcast.urlSuffix) throw fail(400, "The template's link button needs the end of the link (the part that changes).", "NEEDS_URL_SUFFIX");
  return template;
}

/** Starts sending now or at `scheduledAt`: fixes the audience, then the worker sends in batches. */
export async function startBroadcast({ tenantId, broadcast, scheduledAt = null, now = new Date() }) {
  if (!["draft", "scheduled"].includes(broadcast.status)) throw fail(409, "This broadcast has already been sent.", "ALREADY_SENT");
  await checkTemplate({ tenantId, broadcast });
  const runAt = scheduledAt && scheduledAt > now ? scheduledAt : now;
  return withTransaction(async (session) => {
    broadcast.status = "scheduled";
    broadcast.scheduledAt = runAt;
    await broadcast.save({ session });
    await enqueue("broadcast.run", { broadcastId: String(broadcast._id) }, { runAt, dedupeKey: `broadcast:${broadcast._id}:start:${runAt.getTime()}`, session });
    return broadcast;
  });
}

/** The next time messages may go: now if inside the sending hours (India time), else when they open. */
export function nextSendingTime(now, { sendFromHour = 10, sendUntilHour = 20 } = {}) {
  const ist = new Date(now.getTime() + 330 * 60_000);
  const hour = ist.getUTCHours() + ist.getUTCMinutes() / 60;
  if (hour >= sendFromHour && hour < sendUntilHour) return now;
  const open = new Date(Date.UTC(ist.getUTCFullYear(), ist.getUTCMonth(), ist.getUTCDate(), sendFromHour) - 330 * 60_000);
  return hour < sendFromHour ? open : new Date(open.getTime() + DAY);
}

/** One batch of a broadcast (the worker's "broadcast.run"). Safe to run twice. */
export async function runBroadcast({ tenantId, broadcastId, now = new Date() }) {
  const broadcast = await Broadcast.findOne({ _id: broadcastId, tenantId });
  if (!broadcast || !["scheduled", "sending", "waiting"].includes(broadcast.status)) return { done: true };
  const settings = await getSettings(tenantId);
  const limits = settings.broadcasts || {};
  const again = (runAt, status, note) => withTransaction(async (session) => {
    await Broadcast.updateOne({ _id: broadcast._id }, { $set: { status, note } }, { session });
    await enqueue("broadcast.run", { broadcastId: String(broadcast._id) }, { runAt, dedupeKey: `broadcast:${broadcast._id}:${runAt.getTime()}`, session });
    return { done: false, runAt };
  });

  const opensAt = nextSendingTime(now, limits);
  if (opensAt > now) return again(opensAt, "waiting", `Waiting for the sending hours (${limits.sendFromHour ?? 10}:00 to ${limits.sendUntilHour ?? 20}:00)`);

  let template;
  try {
    template = await checkTemplate({ tenantId, broadcast });
  } catch (error) {
    await Broadcast.updateOne({ _id: broadcast._id }, { $set: { status: "cancelled", note: `Stopped: ${error.message}`, finishedAt: now } });
    return { done: true };
  }

  if (!broadcast.startedAt) {
    const { recipients } = await findAudience({ tenantId, audience: broadcast.audience, broadcastId: broadcast._id, now });
    broadcast.recipients = recipients.map((contact) => contact._id);
    broadcast.counts.audience = recipients.length;
    broadcast.startedAt = now;
  }
  broadcast.status = "sending";
  broadcast.note = "";
  await broadcast.save();

  // The number's daily limit counts every customer messaged first by the shop in the last 24 hours.
  const messagedToday = (await Message.distinct("contactId", { tenantId, direction: "out", type: "template", createdAt: trusted({ $gte: new Date(now.getTime() - DAY) }) })).length;
  const room = Math.max(0, (limits.dailyLimit ?? 1000) - messagedToday);
  const sent = new Set((await Message.distinct("contactId", { offerId: broadcast._id })).map(String));
  const skippedIds = new Set((broadcast.skippedIds || []).map(String));
  const pending = broadcast.recipients.filter((id) => !sent.has(String(id)) && !skippedIds.has(String(id)));
  if (!pending.length) {
    await Broadcast.updateOne({ _id: broadcast._id }, { $set: { status: "done", finishedAt: now, note: "" } });
    return { done: true };
  }
  if (!room) return again(new Date(now.getTime() + 60 * 60_000), "waiting", `Waiting: ${limits.dailyLimit ?? 1000} customers already messaged in the last 24 hours (the number's daily limit)`);

  const batch = pending.slice(0, Math.min(BATCH, room));
  const contacts = await Contact.find({ tenantId, _id: trusted({ $in: batch }) }).lean();
  let queued = 0;
  for (const contact of contacts) {
    if (!contact.consents?.offers?.given) {
      continue; // said STOP after the audience was fixed
    }
    try {
      await withTransaction(async (session) => {
        const conversation = await Conversation.findOneAndUpdate({ tenantId, contactId: contact._id }, { $setOnInsert: { status: "open" } }, { upsert: true, new: true, session });
        await queueOutbound({ tenantId, session }, { conversationId: conversation._id, content: { template: templateFor({ template, broadcast, contact, brandName: settings.brandName }), purpose: "offer", offerId: broadcast._id } });
      });
      queued += 1;
    } catch (error) {
      if (!isDuplicateKeyError(error)) throw error; // already queued by an earlier run
    }
  }
  const found = new Set(contacts.map((contact) => String(contact._id)));
  const skippedList = [...contacts.filter((contact) => !contact.consents?.offers?.given).map((contact) => contact._id), ...batch.filter((id) => !found.has(String(id)))];
  await Broadcast.updateOne({ _id: broadcast._id }, { $inc: { "counts.queued": queued, "counts.skipped": skippedList.length }, $addToSet: { skippedIds: { $each: skippedList } } });
  // The next batch a little later, so WhatsApp sees a steady pace rather than one burst.
  return again(new Date(now.getTime() + 30_000), "sending", "");
}

/** How a broadcast did: messages by status, replies within 3 days, orders within 7 days, opt-outs. */
export async function broadcastResults({ tenantId, broadcast }) {
  const statuses = await Message.aggregate([{ $match: { tenantId, offerId: broadcast._id } }, { $group: { _id: "$status", n: { $sum: 1 } } }]);
  const by = Object.fromEntries(statuses.map((row) => [row._id, row.n]));
  const messages = { queued: (by.queued || 0) + (by.sending || 0), sent: by.sent || 0, delivered: by.delivered || 0, read: by.read || 0, failed: by.failed || 0 };
  // Delivered includes the read ones; read is its own count.
  messages.reached = messages.delivered + messages.read;
  const results = { messages, replies: 0, orders: 0, salesPaise: 0, optedOut: 0 };
  if (!broadcast.startedAt || !broadcast.recipients.length) return results;
  const from = broadcast.startedAt;
  const ids = broadcast.recipients;
  results.replies = (await Message.distinct("contactId", { tenantId, direction: "in", contactId: trusted({ $in: ids }), createdAt: trusted({ $gte: from, $lt: new Date(from.getTime() + 3 * DAY) }) })).length;
  const contacts = await Contact.find({ tenantId, _id: trusted({ $in: ids }) }, { waId: 1, consents: 1 }).lean();
  const phones = contacts.map((contact) => contact.waId.replace(/^91(?=\d{10}$)/, ""));
  const orders = await Order.find({
    tenantId,
    status: trusted({ $in: SOLD }),
    createdAt: trusted({ $gte: from, $lt: new Date(from.getTime() + 7 * DAY) }),
    $or: trusted([{ contactId: trusted({ $in: ids }) }, { channel: "store", "customer.phone": trusted({ $in: phones }) }]),
  }, { "totals.totalPaise": 1 }).lean();
  results.orders = orders.length;
  results.salesPaise = orders.reduce((sum, order) => sum + (order.totals?.totalPaise || 0), 0);
  results.optedOut = contacts.filter((contact) => !contact.consents?.offers?.given && contact.consents?.offers?.at >= from).length;
  return results;
}

export function createBroadcastHandlers({ config, now = () => new Date() }) {
  return {
    async "broadcast.run"({ broadcastId }) {
      await runBroadcast({ tenantId: config.TENANT_ID, broadcastId, now: now() });
    },
  };
}
