import mongoose from "mongoose";
import { Alert, Contact, Conversation, Creator, DailySummary, Markdown, Order, PurchaseOrder, getSettings } from "../models/index.js";
import { queueOutbound } from "../whatsapp/outbound.js";
import { istDay, salesReport } from "./reports.js";
import { buyingCalendar, markdownPlan, reorderPlan } from "./buying.js";
import { creatorStatement } from "./creators.js";
import { waIdFromPhone } from "./picks.js";

// The owner's morning brief: yesterday's sales against the same day last week, today's work (orders
// to confirm, pack and hand over), what is running out and what is slow, birthdays, buying dates and
// open alerts. Sent on WhatsApp to the owner's numbers at the hour set in Settings, and shown in the
// staff app. Outside WhatsApp's 24-hour window an approved template carries the headline; the owner
// replies BRIEF for the full text.

const DAY = 86_400_000;
const IST = 330 * 60_000;
const trusted = (filter) => mongoose.trusted(filter);
const rs = (paise) => `Rs ${Math.round((paise || 0) / 100).toLocaleString("en-IN")}`;
const plural = (count, word, many = `${word}s`) => `${count} ${count === 1 ? word : many}`;
const CHANNEL = { whatsapp: "WhatsApp", website: "website", store: "counter" };
export const BRIEF_WORD = /^\s*brief\s*[.!]?\s*$/i;

const shortDay = (day) => new Date(`${day}T12:00:00+05:30`).toLocaleDateString("en-IN", { day: "numeric", month: "short", timeZone: "Asia/Kolkata" });
const dayWords = (day) => new Date(`${day}T12:00:00+05:30`).toLocaleDateString("en-IN", { weekday: "long", day: "numeric", month: "short", timeZone: "Asia/Kolkata" });

/** Everything the brief says, as data. `now` is the morning it is for. */
export async function buildBrief({ tenantId, now = new Date() }) {
  const today = istDay(now);
  const yesterday = istDay(new Date(now.getTime() - DAY));
  const lastWeek = istDay(new Date(now.getTime() - 8 * DAY));
  const [sales, before] = await Promise.all([salesReport({ tenantId, from: yesterday, to: yesterday, now }), salesReport({ tenantId, from: lastWeek, to: lastWeek, now })]);

  const counts = await Order.aggregate([{ $match: { tenantId, status: trusted({ $in: ["awaiting_confirmation", "awaiting_payment", "confirmed", "packed"] }) } }, { $group: { _id: "$status", count: { $sum: 1 } } }]);
  const count = (status) => counts.find((row) => row._id === status)?.count || 0;
  const stateUnsure = await Order.countDocuments({ tenantId, status: trusted({ $in: ["draft", "awaiting_payment", "awaiting_confirmation", "confirmed"] }), "shipTo.stateSure": false });

  const { rows } = await reorderPlan({ tenantId, now });
  const runningOut = rows.filter((row) => row.coverDays === null || row.coverDays < 14).slice(0, 3).map((row) => ({ styleCode: row.styleCode, name: row.name, onHand: row.onHand, days: row.coverDays === null ? 0 : Math.round(row.coverDays), suggest: row.suggest.total }));
  const { plan } = await markdownPlan({ tenantId, now });

  const [, month, dayOfMonth] = today.split("-").map(Number);
  const birthdays = await Contact.find({ tenantId, "birthday.day": dayOfMonth, "birthday.month": month }, { name: 1, profileName: 1, "consents.offers.given": 1, "loyalty.tier": 1 }).limit(20).lean();
  const ydayStart = new Date(`${yesterday}T00:00:00+05:30`);
  const newMembers = await Contact.countDocuments({ tenantId, "loyalty.joinedAt": trusted({ $gte: ydayStart, $lt: new Date(ydayStart.getTime() + DAY) }) });

  const todayEnd = new Date(`${today}T23:59:59+05:30`);
  const overduePos = await PurchaseOrder.find({ tenantId, status: trusted({ $in: ["sent", "part_received"] }), expectedAt: trusted({ $lt: new Date(`${today}T00:00:00+05:30`) }) }, { number: 1, supplierId: 1, expectedAt: 1 }).lean();
  const duePos = await PurchaseOrder.countDocuments({ tenantId, status: trusted({ $in: ["sent", "part_received"] }), expectedAt: trusted({ $gte: new Date(`${today}T00:00:00+05:30`), $lte: todayEnd }) });
  const orderSoon = (await buyingCalendar({ tenantId, now })).filter((event) => event.orderInDays <= 7).slice(0, 3);
  const endingMarkdowns = await Markdown.countDocuments({ tenantId, status: "active", until: trusted({ $lte: new Date(todayEnd.getTime() + DAY) }) });

  // In the first week of a month: what last month's creators are owed and not yet paid.
  let creatorsDue = null;
  if (dayOfMonth <= 7) {
    const last = istDay(new Date(new Date(`${today.slice(0, 7)}-01T12:00:00+05:30`).getTime() - DAY)).slice(0, 7);
    let due = 0;
    let people = 0;
    for (const creator of await Creator.find({ tenantId })) {
      const statement = await creatorStatement({ tenantId, creator, month: last });
      if (!statement.payout && statement.payablePaise > 0) {
        due += statement.payablePaise;
        people += 1;
      }
    }
    if (people) creatorsDue = { month: last, people, paise: due };
  }
  const alerts = await Alert.find({ tenantId, resolvedAt: null }, { title: 1, severity: 1 }).sort({ severity: 1, lastAt: -1 }).limit(5).lean();

  const net = sales.totals.netPaise;
  const prev = before.totals.netPaise;
  return {
    date: today,
    yesterday,
    sales: {
      netPaise: net,
      bills: sales.totals.invoices,
      pieces: sales.totals.pieces,
      returned: sales.totals.piecesReturned,
      averageBillPaise: sales.totals.averageBillPaise,
      marginPaise: sales.totals.marginPaise,
      lastWeekPaise: prev,
      changePct: prev ? Math.round(((net - prev) / prev) * 100) : null,
      byChannel: sales.byChannel.map((row) => ({ channel: row.channel, netPaise: row.netPaise })),
      best: sales.topStyles.slice(0, 2).map((row) => ({ styleCode: row.styleCode, name: row.name, pieces: row.pieces })),
    },
    work: { toConfirm: count("awaiting_confirmation"), awaitingPayment: count("awaiting_payment"), toPack: count("confirmed"), toHandOver: count("packed"), stateUnsure },
    stock: { runningOut, slow: plan.length, slowValuePaise: plan.reduce((sum, row) => sum + row.pricePaise * row.onHand, 0) },
    customers: { birthdays: birthdays.map((row) => ({ name: row.name || row.profileName || "", offers: Boolean(row.consents?.offers?.given), tier: row.loyalty?.tier || "" })), newMembers },
    buying: { overduePos: overduePos.length, duePos, orderSoon: orderSoon.map((event) => ({ name: event.name, orderBy: event.orderBy, orderInDays: event.orderInDays })), endingMarkdowns },
    creatorsDue,
    alerts: alerts.map((row) => ({ title: row.title, severity: row.severity })),
  };
}

/** The one line for the template and the top of the message. */
export function briefHeadline(brief) {
  const parts = [`${rs(brief.sales.netPaise)} from ${plural(brief.sales.bills, "bill")}`];
  const work = brief.work.toConfirm + brief.work.toPack + brief.work.toHandOver;
  if (work) parts.push(`${plural(work, "order")} to handle`);
  if (brief.stock.runningOut.length) parts.push(`${brief.stock.runningOut.length} running out`);
  if (brief.alerts.length) parts.push(plural(brief.alerts.length, "alert"));
  return parts.join(", ");
}

/** The brief as a WhatsApp message (WhatsApp's *bold*). */
export function briefText(brief, brandName = "The Hanger") {
  const s = brief.sales;
  const out = [`*Good morning. ${brandName}, ${dayWords(brief.date)}*`, ""];
  out.push(`*Yesterday:* ${rs(s.netPaise)} from ${plural(s.bills, "bill")}, ${plural(s.pieces, "piece")}${s.changePct === null ? "" : ` (${s.changePct >= 0 ? "+" : ""}${s.changePct}% on last ${new Date(`${brief.yesterday}T12:00:00+05:30`).toLocaleDateString("en-IN", { weekday: "long", timeZone: "Asia/Kolkata" })})`}.`);
  if (s.byChannel.length > 1) out.push(s.byChannel.map((row) => `${CHANNEL[row.channel] || row.channel} ${rs(row.netPaise)}`).join(" · "));
  if (s.bills) out.push(`Average bill ${rs(s.averageBillPaise)}${s.marginPaise ? `, margin ${rs(s.marginPaise)}` : ""}${s.returned ? `, ${plural(s.returned, "piece")} came back` : ""}.`);
  if (s.best.length) out.push(`Best: ${s.best.map((row) => `${row.name} (${row.pieces})`).join(", ")}.`);

  const w = brief.work;
  const work = [w.toConfirm && `${w.toConfirm} COD to confirm`, w.awaitingPayment && `${w.awaitingPayment} waiting for payment`, w.toPack && `${w.toPack} to pack`, w.toHandOver && `${w.toHandOver} to hand to the courier`, w.stateUnsure && `${w.stateUnsure} need the delivery state checked`].filter(Boolean);
  out.push("", `*Today:* ${work.length ? work.join(", ") : "no orders waiting"}.`);

  if (brief.stock.runningOut.length) out.push("", "*Running out:*", ...brief.stock.runningOut.map((row) => `- ${row.name} (${row.styleCode}): ${row.onHand} left${row.days ? `, ~${row.days} days` : ""}${row.suggest ? `; buy ${row.suggest}` : ""}`));
  if (brief.stock.slow) out.push(`${plural(brief.stock.slow, "slow style")} (${rs(brief.stock.slowValuePaise)} at price) could be marked down: see Buying > Markdowns.`);

  const c = brief.customers;
  if (c.birthdays.length) out.push("", `*Birthdays today:* ${c.birthdays.map((row) => `${row.name || "a customer"}${row.tier ? ` (${row.tier})` : ""}`).join(", ")}.`);
  if (c.newMembers) out.push(`${plural(c.newMembers, "new member")} joined yesterday.`);

  const b = brief.buying;
  const buying = [b.overduePos && `${plural(b.overduePos, "supplier order")} late`, b.duePos && `${plural(b.duePos, "supplier order")} due today`, b.endingMarkdowns && `${plural(b.endingMarkdowns, "markdown")} ending`, ...b.orderSoon.map((event) => (event.orderInDays < 0 ? `order for ${event.name} (was due ${shortDay(event.orderBy)})` : `order for ${event.name} by ${shortDay(event.orderBy)}`))].filter(Boolean);
  if (buying.length) out.push("", `*Buying:* ${buying.join("; ")}.`);
  if (brief.creatorsDue) out.push(`Creators: ${rs(brief.creatorsDue.paise)} due to ${plural(brief.creatorsDue.people, "creator")} for ${brief.creatorsDue.month}.`);
  if (brief.alerts.length) out.push("", "*Needs you:*", ...brief.alerts.map((row) => `- ${row.title}`));
  return out.join("\n").replace(/\n{3,}/g, "\n\n");
}

/**
 * Sends the brief to each of the owner's numbers: the full text inside the 24-hour window, else the
 * template (date, headline) when one is set. Returns what happened per number.
 */
export async function sendBrief({ tenantId, brief, session, now = new Date() }) {
  const settings = await getSettings(tenantId, session);
  const conf = settings.brief || {};
  const text = briefText(brief, settings.brandName || "The Hanger");
  const results = [];
  for (const phone of conf.phones || []) {
    const waId = waIdFromPhone(phone);
    if (!waId) continue;
    const contact = await Contact.findOneAndUpdate({ tenantId, waId }, { $setOnInsert: { tenantId, waId, firstSeenAt: now } }, { upsert: true, new: true, session });
    const conversation = await Conversation.findOneAndUpdate({ tenantId, contactId: contact._id }, { $setOnInsert: { status: "open" } }, { upsert: true, new: true, session });
    const inWindow = conversation.lastInboundAt && now - conversation.lastInboundAt < DAY;
    if (inWindow) {
      await queueOutbound({ tenantId, session }, { conversationId: conversation._id, content: { text, purpose: "brief" } });
      results.push({ waId, sent: "text" });
    } else if (conf.template?.name) {
      const params = [dayWords(brief.date), briefHeadline(brief)];
      await queueOutbound({ tenantId, session }, { conversationId: conversation._id, content: { template: { name: conf.template.name, language: conf.template.language || "en", components: [{ type: "body", parameters: params.map((value) => ({ type: "text", text: value })) }] }, purpose: "brief" } });
      results.push({ waId, sent: "template" });
    } else results.push({ waId, sent: "none", why: "no message from this number in 24 hours and no brief template set" });
  }
  return { text, results };
}

/**
 * The morning job: builds the day's brief (many reads, outside any transaction), then keeps and sends
 * it once in one short transaction.
 */
export async function runMorningBrief({ tenantId, now = new Date() }) {
  const { withTransaction } = await import("../db.js");
  const brief = await buildBrief({ tenantId, now });
  return withTransaction(async (session) => {
    const existing = await DailySummary.findOne({ tenantId, date: brief.date }).session(session);
    if (existing?.data?.sentAt) return { brief: existing.data.brief, already: true };
    const sent = await sendBrief({ tenantId, brief, session, now });
    await DailySummary.updateOne({ tenantId, date: brief.date }, { $set: { data: { brief, sentAt: now, results: sent.results } } }, { upsert: true, session });
    return { brief, sent };
  });
}

/** True when it is the brief's hour (India time) or later today and the brief is switched on. */
export function briefDue(settings, now = new Date()) {
  const conf = settings.brief || {};
  if (!conf.enabled || !(conf.phones || []).length) return false;
  const local = new Date(now.getTime() + IST);
  return local.getUTCHours() * 60 + local.getUTCMinutes() >= (conf.hour ?? 9) * 60 + (conf.minute ?? 0);
}

export function createBriefHandlers({ config, now = () => new Date() }) {
  return {
    "brief.morning": async () => {
      await runMorningBrief({ tenantId: config.TENANT_ID, now: now() });
    },
    // The owner replied BRIEF: today's brief, fresh, in the chat (she just wrote, so free text is allowed).
    "brief.reply": async ({ conversationId }) => {
      const { withTransaction } = await import("../db.js");
      const tenantId = config.TENANT_ID;
      const settings = await getSettings(tenantId);
      const text = briefText(await buildBrief({ tenantId, now: now() }), settings.brandName || "The Hanger");
      await withTransaction((session) => queueOutbound({ tenantId, session }, { conversationId, content: { text, purpose: "brief" } }));
    },
  };
}

/** True (and the reply queued) when one of the owner's numbers writes BRIEF. */
export async function answerBriefRequest({ tenantId, message, contact, conversation, session }) {
  if (message.type !== "text" || !BRIEF_WORD.test(String(message.text || ""))) return false;
  const settings = await getSettings(tenantId, session);
  const owners = (settings.brief?.phones || []).map(waIdFromPhone);
  if (!owners.includes(contact.waId)) return false;
  const { enqueue } = await import("../jobs/queue.js");
  await enqueue("brief.reply", { conversationId: String(conversation._id) }, { session });
  return true;
}
