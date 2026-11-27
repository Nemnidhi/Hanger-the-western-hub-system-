import { createHash, randomBytes, randomInt, timingSafeEqual } from "node:crypto";
import mongoose from "mongoose";
import { Contact, Conversation, CustomerSession, LoginCode, Order, Sku, StockLevel, Style, getSettings, nextNumber, orderLabel } from "../models/index.js";
import { enqueue } from "../jobs/queue.js";
import { queueOutbound } from "../whatsapp/outbound.js";
import { waIdFromPhone } from "./picks.js";
import { confirmOrder, historyEntry, httpError, onlineLocation, paymentOptions, priceLines, scheduleExpiry, scoreCod } from "./orders.js";
import { codBand } from "./codRisk.js";
import { holdStock } from "./stock.js";
import { findPincode, stateForAddress } from "./pincode.js";
import { applyDiscount, quoteDiscount, redeemPoints, tierFor, yearSpend } from "./loyalty.js";
import { memberPrices } from "./buying.js";
import { readCookie } from "../auth/sessions.js";

// The website storefront's side of the platform: the live collection with sizes in stock at the
// online location, search, size charts, sign-in with a WhatsApp code, the bag's price with codes and
// points, and the website order (same stock holds, COD score, invoice and messages as WhatsApp).

const trusted = (filter) => mongoose.trusted(filter);
const DAY_MS = 24 * 3600_000;
const CODE_MS = 10 * 60_000;
const SESSION_MS = 60 * DAY_MS;
const TOUCH_MS = 10 * 60_000;
export const SHOP_COOKIE = "hh_shop";
const sha = (value) => createHash("sha256").update(String(value)).digest("hex");
const NEW_DAYS = 21;

// ---- The collection ------------------------------------------------------------------------------

/** Sizes in stock at the online location, by SKU id. */
async function onlineStock({ tenantId, skuIds, settings }) {
  const location = await onlineLocation({ tenantId, settings, session: null });
  const levels = await StockLevel.find({ skuId: trusted({ $in: skuIds }), locationId: location._id }).lean();
  return new Map(levels.map((level) => [String(level.skuId), level.available]));
}

/** The public face of a style: what the website shows. No costs, no supplier. */
export function publicStyle(style, skus, stock, now = new Date()) {
  const sizes = skus
    .filter((sku) => String(sku.styleId) === String(style._id))
    .map((sku) => {
      const available = stock.get(String(sku._id)) || 0;
      return { code: sku.code, size: sku.size, pricePaise: sku.pricePaise, inStock: available > 0, few: available > 0 && available <= 2 };
    });
  const prices = sizes.map((size) => size.pricePaise);
  const publicMarkdown = style.markdown?.kind === "public" && style.markdown.listPaise > Math.min(...prices);
  return {
    code: style.code,
    slug: style.code.toLowerCase(),
    name: style.name,
    category: style.category,
    description: style.description || "",
    highlights: style.highlights || [],
    imageAlt: style.imageAlt || style.name,
    images: style.images || [],
    colour: style.attributes?.colour || "",
    fabric: style.attributes?.fabric || "",
    fit: style.attributes?.fit || "",
    pattern: style.attributes?.pattern || "",
    occasion: style.attributes?.occasion || [],
    sizing: style.sizing || "true",
    pairsWith: style.pairsWith || [],
    pricePaise: prices.length ? Math.min(...prices) : style.pricePaise,
    listPaise: publicMarkdown ? style.markdown.listPaise : 0,
    offPct: publicMarkdown ? style.markdown.pct : 0,
    isNew: Boolean(style.liveAt && now - style.liveAt < NEW_DAYS * DAY_MS),
    inStock: sizes.some((size) => size.inStock),
    sizes,
    liveAt: style.liveAt,
  };
}

async function liveStyles({ tenantId, filter = {} }) {
  const settings = await getSettings(tenantId);
  const styles = await Style.find({ tenantId, status: "live", ...filter }).lean();
  const skus = styles.length ? await Sku.find({ tenantId, styleId: trusted({ $in: styles.map((style) => style._id) }) }).lean() : [];
  const stock = skus.length ? await onlineStock({ tenantId, skuIds: skus.map((sku) => sku._id), settings }) : new Map();
  return { settings, list: styles.map((style) => publicStyle(style, skus, stock)) };
}

const SORTS = {
  new: (a, b) => Number(b.inStock) - Number(a.inStock) || new Date(b.liveAt || 0) - new Date(a.liveAt || 0),
  price_low: (a, b) => Number(b.inStock) - Number(a.inStock) || a.pricePaise - b.pricePaise,
  price_high: (a, b) => Number(b.inStock) - Number(a.inStock) || b.pricePaise - a.pricePaise,
};

/** The live collection, sold-out styles last. Filters: category, size in stock, occasion, on sale. */
export async function shopCatalog({ tenantId, category = "", size = "", occasion = "", sale = false, sort = "new" }) {
  const { list } = await liveStyles({ tenantId, filter: category ? { category: String(category).toLowerCase() } : {} });
  const rows = list
    .filter((style) => !size || style.sizes.some((row) => row.size === String(size).toUpperCase() && row.inStock))
    .filter((style) => !occasion || style.occasion.includes(String(occasion).toLowerCase()))
    .filter((style) => !sale || style.listPaise > 0)
    .sort(SORTS[sort] || SORTS.new);
  const all = (await liveStyles({ tenantId })).list;
  const facets = {
    categories: [...new Set(all.map((style) => style.category))].sort(),
    sizes: [...new Set(all.flatMap((style) => style.sizes.filter((row) => row.inStock).map((row) => row.size)))],
    occasions: [...new Set(all.flatMap((style) => style.occasion))].sort(),
    sale: all.some((style) => style.listPaise > 0),
  };
  return { styles: rows, facets };
}

/** One style with the pieces it pairs with (live, in stock). */
export async function shopStyle({ tenantId, code }) {
  const wanted = String(code || "").toUpperCase();
  const { settings, list } = await liveStyles({ tenantId, filter: { code: wanted } });
  const style = list[0];
  if (!style) throw httpError(404, "Not in the current collection", "NOT_FOUND");
  const pairCodes = style.pairsWith.map((value) => String(value).toUpperCase());
  let pairs = pairCodes.length ? (await liveStyles({ tenantId, filter: { code: trusted({ $in: pairCodes }) } })).list : [];
  // No pairings set: a few from the same occasion or colour, in stock.
  if (!pairs.length) {
    const others = (await liveStyles({ tenantId, filter: { code: trusted({ $ne: wanted }) } })).list.filter((row) => row.inStock && row.category !== style.category);
    const score = (row) => row.occasion.filter((value) => style.occasion.includes(value)).length * 2 + (row.colour && row.colour === style.colour ? 1 : 0);
    pairs = others.sort((a, b) => score(b) - score(a)).slice(0, 4);
  }
  return { style, pairs: pairs.filter((row) => row.inStock).slice(0, 4), sizeChart: sizeChartFor(settings, style.category) };
}

/** Search the live collection. Each word scores where it is found; best first. */
export async function shopSearch({ tenantId, q }) {
  const words = String(q || "")
    .toLowerCase()
    .split(/[^a-z0-9-]+/)
    .filter((word) => word.length >= 2)
    .slice(0, 6);
  if (!words.length) return { styles: [] };
  const { list } = await liveStyles({ tenantId });
  const score = (style) =>
    words.reduce((sum, word) => {
      const stem = word.replace(/(es|s)$/, "");
      const has = (text) => String(text || "").toLowerCase().includes(stem);
      return (
        sum +
        (style.code.toLowerCase() === word ? 10 : 0) +
        (has(style.name) ? 4 : 0) +
        (has(style.category) ? 3 : 0) +
        (has(style.colour) || has(style.fabric) || has(style.pattern) || has(style.fit) ? 2 : 0) +
        (style.occasion.some(has) ? 2 : 0) +
        (has(style.description) || style.highlights.some(has) ? 1 : 0)
      );
    }, 0);
  const styles = list
    .map((style) => ({ style, score: score(style) }))
    .filter((row) => row.score > 0)
    .sort((a, b) => b.score - a.score || Number(b.style.inStock) - Number(a.style.inStock))
    .slice(0, 48)
    .map((row) => row.style);
  return { styles };
}

/** The size chart for a category (Settings > Website), else the first chart. */
export function sizeChartFor(settings, category) {
  const charts = settings.shop?.sizeCharts || [];
  return charts.find((chart) => chart.categories.includes(category)) || charts.find((chart) => !chart.categories.length) || charts[0] || null;
}

/** What the website needs to know about the shop. */
export async function shopInfo({ tenantId, razorpayReady }) {
  const settings = await getSettings(tenantId);
  return {
    brandName: settings.brandName,
    legalName: settings.legalName,
    address: settings.registeredAddress,
    gstin: settings.gstin,
    orderPrefix: settings.orderPrefix,
    cod: { enabled: Boolean(settings.cod?.enabled), maxOrderPaise: settings.cod?.maxOrderPaise || 0 },
    prepaid: Boolean(razorpayReady),
    shippingNote: settings.shop?.shippingNote || "",
    returnsNote: settings.shop?.returnsNote || "",
    whatsapp: settings.shop?.whatsappNumber || "",
    instagram: settings.shop?.instagram || "",
    sizeCharts: settings.shop?.sizeCharts || [],
    loyalty: { enabled: settings.loyalty?.enabled !== false, pointValuePaise: settings.loyalty?.pointValuePaise || 100, tiers: settings.loyalty?.tiers || [] },
  };
}

// ---- Sign-in with a WhatsApp code ---------------------------------------------------------------

async function contactAndChat({ tenantId, waId, session }) {
  const contact = await Contact.findOneAndUpdate({ tenantId, waId }, { $setOnInsert: { firstSeenAt: new Date() } }, { upsert: true, new: true, session });
  const conversation = await Conversation.findOneAndUpdate({ tenantId, contactId: contact._id }, { $setOnInsert: { status: "open" } }, { upsert: true, new: true, session });
  return { contact, conversation };
}

/**
 * Sends a 6-digit sign-in code to her WhatsApp: the authentication template (Settings > Website),
 * or plain text when her chat window is open. At most one a minute and 5 an hour per number, 20 an
 * hour per address. `standIn` (development only) sends nothing and returns the code.
 */
export async function sendLoginCode({ tenantId, phone, ip = "", standIn = false, withTransaction, now = new Date() }) {
  const waId = waIdFromPhone(phone);
  if (!waId) throw httpError(400, "Type your 10-digit mobile number", "BAD_PHONE");
  const hourAgo = new Date(now.getTime() - 3600_000);
  const recent = await LoginCode.find({ tenantId, waId, createdAt: trusted({ $gte: hourAgo }) }).sort({ createdAt: -1 }).limit(6).lean();
  if (recent[0] && now - recent[0].createdAt < 60_000) throw httpError(429, "A code is on its way. Wait a minute before asking for another.", "WAIT");
  if (recent.length >= 5) throw httpError(429, "Too many codes for this number. Try again in an hour.", "TOO_MANY");
  if (ip && (await LoginCode.countDocuments({ tenantId, ip, createdAt: trusted({ $gte: hourAgo }) })) >= 20) throw httpError(429, "Too many sign-in codes from here. Try again later.", "TOO_MANY");

  const settings = await getSettings(tenantId);
  const template = settings.shop?.loginTemplate;
  const code = String(randomInt(0, 1_000_000)).padStart(6, "0");
  const via = await withTransaction(async (session) => {
    const { conversation } = await contactAndChat({ tenantId, waId, session });
    const insideWindow = Boolean(conversation.lastInboundAt && now - conversation.lastInboundAt < DAY_MS - 5 * 60_000);
    let content = null;
    if (template?.name) {
      // Meta authentication template: the code in the body and in the copy-code button.
      content = { template: { name: template.name, language: template.language || "en", components: [{ type: "body", parameters: [{ type: "text", text: code }] }, { type: "button", sub_type: "url", index: "0", parameters: [{ type: "text", text: code }] }] } };
    } else if (insideWindow) {
      content = { text: `${code} is your ${settings.brandName || "website"} sign-in code. It works for 10 minutes. Do not share it with anyone.` };
    } else if (!standIn) {
      throw httpError(409, "Website sign-in is not set up yet: the shop needs its WhatsApp code template (Settings > Website).", "NO_LOGIN_TEMPLATE");
    }
    if (content) await queueOutbound({ tenantId, session }, { conversationId: conversation._id, content: { ...content, purpose: "login" } });
    await LoginCode.create([{ tenantId, waId, codeHash: sha(`${waId}:${code}`), ip: String(ip).slice(0, 64), expiresAt: new Date(now.getTime() + CODE_MS) }], { session });
    return content ? (content.template ? "template" : "text") : "stand-in";
  });
  return { sent: true, via, waId, ...(via === "stand-in" ? { devCode: code } : {}) };
}

/** Checks the code and starts a 60-day website session. Returns { token, contact }. */
export async function verifyLoginCode({ tenantId, phone, code, offers = false, userAgent = "", now = new Date() }) {
  const waId = waIdFromPhone(phone);
  if (!waId) throw httpError(400, "Type your 10-digit mobile number", "BAD_PHONE");
  const row = await LoginCode.findOne({ tenantId, waId, usedAt: null, expiresAt: trusted({ $gt: now }) }).sort({ createdAt: -1 });
  if (!row) throw httpError(400, "That code has expired. Ask for a new one.", "EXPIRED");
  if (row.tries >= 5) throw httpError(429, "Too many wrong tries. Ask for a new code.", "TOO_MANY");
  const given = Buffer.from(sha(`${waId}:${String(code || "").replace(/\D/g, "")}`));
  if (!timingSafeEqual(given, Buffer.from(row.codeHash))) {
    row.tries += 1;
    await row.save();
    const left = 5 - row.tries;
    throw httpError(400, left > 0 ? `That code is not right. ${left} ${left === 1 ? "try" : "tries"} left.` : "Too many wrong tries. Ask for a new code.", "WRONG_CODE");
  }
  // One use only, even if two requests race.
  const used = await LoginCode.updateOne({ _id: row._id, usedAt: null }, { $set: { usedAt: now } });
  if (!used.modifiedCount) throw httpError(400, "That code was already used. Ask for a new one.", "EXPIRED");
  const contact = await Contact.findOneAndUpdate({ tenantId, waId }, { $setOnInsert: { firstSeenAt: now } }, { upsert: true, new: true });
  if (offers && !contact.consents?.offers?.given) {
    contact.set("consents.offers", { given: true, at: now, source: "website:sign-in", askedAt: now });
    await contact.save();
  }
  const token = randomBytes(32).toString("base64url");
  await CustomerSession.create({ tenantId, contactId: contact._id, tokenHash: sha(token), userAgent: String(userAgent).slice(0, 300), lastSeenAt: now, expiresAt: new Date(now.getTime() + SESSION_MS) });
  return { token, contact };
}

/** The signed-in customer of a request, or null. Slides the session's expiry. */
export async function customerFor(req, { tenantId, now = new Date() } = {}) {
  const token = readCookie(req, SHOP_COOKIE);
  if (!token) return null;
  const session = await CustomerSession.findOne({ tenantId, tokenHash: sha(token) });
  if (!session || session.expiresAt <= now) return null;
  if (now - session.lastSeenAt > TOUCH_MS) {
    session.lastSeenAt = now;
    session.expiresAt = new Date(now.getTime() + SESSION_MS);
    await session.save();
  }
  const contact = await Contact.findOne({ _id: session.contactId, tenantId });
  return contact ? { contact, session } : null;
}

export async function endCustomerSession(req, { tenantId }) {
  const token = readCookie(req, SHOP_COOKIE);
  if (token) await CustomerSession.deleteOne({ tenantId, tokenHash: sha(token) });
}

export function setShopCookie(res, token, { secure }) {
  res.cookie(SHOP_COOKIE, token, { httpOnly: true, secure, sameSite: "lax", path: "/", maxAge: SESSION_MS });
}
export function clearShopCookie(res, { secure }) {
  res.clearCookie(SHOP_COOKIE, { httpOnly: true, secure, sameSite: "lax", path: "/" });
}

/** Her account as the website shows it. */
export async function accountView({ tenantId, contact }) {
  const settings = await getSettings(tenantId);
  const spend = await yearSpend({ tenantId, contactId: contact._id });
  return {
    name: contact.name || contact.profileName || "",
    phone: contact.waId,
    usualSize: contact.fit?.usualSize || "",
    waist: contact.fit?.waist || "",
    offers: Boolean(contact.consents?.offers?.given),
    points: contact.loyalty?.points || 0,
    pointValuePaise: settings.loyalty?.pointValuePaise || 100,
    tier: tierFor(settings, spend),
    spendPaise: spend,
    referralCode: contact.loyalty?.referralCode || "",
    lastAddress: contact.lastAddress?.address ? { name: contact.lastAddress.name, address: contact.lastAddress.address, pincode: contact.lastAddress.pincode } : null,
  };
}

// ---- The bag and the website order ---------------------------------------------------------------

/** What the bag costs: members' prices when she is signed in, then her code and points. */
export async function shopQuote({ tenantId, contact, items, code = "", redeem = 0, razorpayReady }) {
  const settings = await getSettings(tenantId);
  const lines = await priceLines({ tenantId, items, settings, session: null });
  const listPaise = lines.reduce((sum, line) => sum + line.unitPaise * line.qty, 0);
  const memberSavingPaise = contact ? await memberPrices({ tenantId, lines, settings, session: null }) : 0;
  const grossPaise = lines.reduce((sum, line) => sum + line.unitPaise * line.qty, 0);
  const quote = await quoteDiscount({ tenantId, settings, contact, code, redeemPoints: redeem, grossPaise, session: null });
  const totalPaise = grossPaise - quote.totalPaise;
  const options = paymentOptions({ totals: { totalPaise } }, settings, razorpayReady);
  return { lines: lines.map(({ skuCode, styleCode, name, size, qty, unitPaise }) => ({ skuCode, styleCode, name, size, qty, unitPaise })), listPaise, memberSavingPaise, quote, totalPaise, ...options };
}

/**
 * A website order, in one step: prices the bag (members' prices, code, points), holds the stock at the
 * online location, records the address, then takes the payment choice. Prepaid: a payment link is made
 * (the page waits for it). COD: scored; low risk is confirmed now, medium waits for her to confirm on
 * the page, high needs online payment. Runs inside the caller's transaction.
 */
export async function placeWebsiteOrder({ tenantId, contact, items, address, method, code = "", redeem = 0, attribution = null, razorpayReady, session, now = new Date() }) {
  const settings = await getSettings(tenantId, session);
  const location = await onlineLocation({ tenantId, settings, session });
  const lines = await priceLines({ tenantId, items, settings, session });
  await memberPrices({ tenantId, lines, settings, session, now });
  const gross = lines.reduce((sum, line) => sum + line.unitPaise * line.qty, 0);
  const quote = code || redeem ? await quoteDiscount({ tenantId, settings, contact, code, redeemPoints: redeem, grossPaise: gross, session }) : null;
  if (quote) applyDiscount(lines, quote.totalPaise, settings);
  const itemsPaise = lines.reduce((sum, line) => sum + line.unitPaise * line.qty, 0);
  const options = paymentOptions({ totals: { totalPaise: itemsPaise } }, settings, razorpayReady);
  if (method === "prepaid" && !options.prepaidAllowed) throw httpError(409, "Online payment is not available yet. Choose cash on delivery.", "NO_PAYMENTS");
  if (method === "cod" && !options.codAllowed) throw httpError(409, "Cash on delivery is not available for this order. Pay online instead.", "NO_COD");

  const text = String(address.address || "").trim();
  const pincode = String(address.pincode || findPincode(text) || "").trim();
  if (!/^[1-9]\d{5}$/.test(pincode)) throw httpError(400, "The address needs a 6-digit pincode", "NO_PINCODE");
  const state = stateForAddress({ pincode, text });
  await holdStock({ tenantId, locationId: location._id, lines, session });
  const conversation = await Conversation.findOne({ tenantId, contactId: contact._id }).session(session);
  const name = String(address.name || contact.name || contact.profileName || "").trim().slice(0, 80);

  const order = new Order({
    tenantId,
    number: await nextNumber(`order:${tenantId}`, session),
    channel: "website",
    contactId: contact._id,
    attribution: attribution || undefined,
    conversationId: conversation?._id || null,
    customer: { name, phone: contact.waId },
    locationId: location._id,
    lines,
    totals: { itemsPaise, totalPaise: itemsPaise },
    discount: quote
      ? { code: quote.code?.code || "", kind: quote.code?.kind || "", creatorId: quote.code?.creatorId || null, referrerId: quote.code?.referrerId || null, codePaise: quote.code?.paise || 0, pointsUsed: quote.points.used, pointsPaise: quote.points.paise }
      : undefined,
    shipTo: { name, address: text.slice(0, 400), pincode, stateCode: state.stateCode, state: state.state, stateSure: state.sure },
    status: "draft",
    chatStep: "",
    stockState: "held",
    holdUntil: new Date(now.getTime() + settings.paymentHoldMinutes * 60_000),
    history: [historyEntry("customer", "placed", `${lines.reduce((sum, line) => sum + line.qty, 0)} piece(s) via website`, now), historyEntry("customer", "address", `${pincode}${state.state ? `, ${state.state}` : ""}`, now)],
  });
  if (quote?.points.used) await redeemPoints({ tenantId, contact, order, points: quote.points.used, by: "customer", session, now });
  await Contact.updateOne({ _id: contact._id }, { $set: { lastAddress: { name, address: order.shipTo.address, pincode }, ...(contact.name ? {} : name ? { name } : {}) } }, { session });

  if (method === "prepaid") {
    order.payment.method = "prepaid";
    order.payment.status = "pending";
    order.status = "awaiting_payment";
    order.history.push(historyEntry("customer", "payment_chosen", "prepaid", now));
    await scheduleExpiry(order, session);
    await enqueue("payment.createLink", { orderId: String(order._id) }, { session, dedupeKey: `paylink:${order._id}` });
    await order.save({ session });
    return order;
  }

  const { score, reasons } = await scoreCod({ tenantId, order, session, now });
  const band = codBand(score, settings.cod);
  order.payment.method = "cod";
  order.cod = { score, band, reasons, confirmedAt: null };
  order.history.push(historyEntry("customer", "payment_chosen", `cash on delivery, risk ${score} (${band}): ${reasons.join("; ")}`, now));
  if (band === "low") return confirmOrder({ tenantId, order, by: "system", session, now });
  order.status = "awaiting_confirmation";
  order.holdUntil = new Date(now.getTime() + settings.cod.confirmHours * 3600_000);
  await scheduleExpiry(order, session);
  await order.save({ session });
  return order;
}

const STEP_WORDS = {
  draft: "Not finished",
  awaiting_payment: "Waiting for payment",
  awaiting_confirmation: "Waiting for you to confirm",
  confirmed: "Confirmed: being packed",
  packed: "Packed: waiting for the courier",
  shipped: "On its way",
  out_for_delivery: "Out for delivery",
  delivered: "Delivered",
  cancelled: "Cancelled",
  expired: "Not completed in time",
  rto: "Returned to us",
  returned: "Returned",
};

/** An order as its customer sees it. */
export function customerOrder(order, settings) {
  return {
    _id: order._id,
    label: orderLabel(order, settings.orderPrefix),
    status: order.status,
    statusWords: STEP_WORDS[order.status] || order.status,
    placedAt: order.createdAt,
    lines: order.lines.map(({ skuCode, styleCode, name, size, qty, unitPaise, returnedQty }) => ({ skuCode, styleCode, slug: String(styleCode || "").toLowerCase(), name, size, qty, unitPaise, returnedQty: returnedQty || 0 })),
    totalPaise: order.totals.totalPaise,
    discount: order.discount?.code || order.discount?.pointsUsed ? { code: order.discount.code, codePaise: order.discount.codePaise, pointsUsed: order.discount.pointsUsed, pointsPaise: order.discount.pointsPaise } : null,
    payment: { method: order.payment.method, status: order.payment.status, url: order.status === "awaiting_payment" ? order.payment.url || "" : "" },
    cod: order.payment.method === "cod" ? { band: order.cod?.band || "", needsConfirm: order.status === "awaiting_confirmation" && order.cod?.band === "medium", prepayOnly: order.status === "awaiting_confirmation" && order.cod?.band === "high" } : null,
    holdUntil: order.holdUntil,
    shipTo: { name: order.shipTo?.name || "", address: order.shipTo?.address || "", pincode: order.shipTo?.pincode || "" },
    shipment: { courier: order.shipment?.courier || "", awb: order.shipment?.awb || "", trackingUrl: order.shipment?.awb && order.shipment?.provider === "shiprocket" ? `https://shiprocket.co/tracking/${encodeURIComponent(order.shipment.awb)}` : "" },
    invoiceId: order.invoiceId || null,
  };
}

/** For the automatic picks: the bag she left, if she is signed in and has not ordered since. */
export async function bagLeft({ tenantId, contact, pieces, schedulePicksFollowUp, now = new Date() }) {
  const codes = [...new Set((pieces || []).map((code) => String(code).toUpperCase()).filter(Boolean))].slice(0, 6);
  if (!codes.length) return null;
  return schedulePicksFollowUp({ tenantId, phone: contact.waId, pieces: codes, now });
}

// ---- The Google Merchant Center product feed ----------------------------------------------------

const xml = (value) =>
  String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
const money = (paise) => `${(paise / 100).toFixed(2)} INR`;

/** Every size of every live style as a Google Shopping item (RSS 2.0 with the g: namespace). */
export async function googleFeed({ tenantId, siteUrl }) {
  const { settings, list } = await liveStyles({ tenantId });
  const base = String(siteUrl || "").replace(/\/$/, "");
  const brand = settings.brandName || "The Hanger";
  const items = list.flatMap((style) =>
    style.sizes.map((size) => {
      const fields = [
        ["g:id", size.code],
        ["g:item_group_id", style.code],
        ["title", `${style.name} - ${size.size}`.slice(0, 150)],
        ["description", (style.description || style.highlights.join(". ") || style.name).slice(0, 5000)],
        ["link", `${base}/p/${style.slug}?size=${encodeURIComponent(size.size)}`],
        ["g:image_link", style.images[0] || ""],
        ...style.images.slice(1, 10).map((image) => ["g:additional_image_link", image]),
        ["g:availability", size.inStock ? "in_stock" : "out_of_stock"],
        ["g:price", money(style.listPaise && style.listPaise > size.pricePaise ? style.listPaise : size.pricePaise)],
        ...(style.listPaise && style.listPaise > size.pricePaise ? [["g:sale_price", money(size.pricePaise)]] : []),
        ["g:brand", brand],
        ["g:condition", "new"],
        ["g:identifier_exists", "no"],
        ["g:google_product_category", "1604"],
        ["g:product_type", `Women > ${style.category}`],
        ["g:gender", "female"],
        ["g:age_group", "adult"],
        ["g:size", size.size],
        ["g:size_system", "IN"],
        ...(style.colour ? [["g:color", style.colour]] : []),
        ...(style.fabric ? [["g:material", style.fabric]] : []),
        ...(style.pattern ? [["g:pattern", style.pattern]] : []),
        ["g:shipping", ""],
      ].filter(([key, value]) => key === "g:shipping" || value);
      const body = fields
        .map(([key, value]) => (key === "g:shipping" ? "<g:shipping><g:country>IN</g:country><g:price>0.00 INR</g:price></g:shipping>" : `<${key}>${xml(value)}</${key}>`))
        .join("");
      return `<item>${body}</item>`;
    }),
  );
  return `<?xml version="1.0" encoding="UTF-8"?>\n<rss version="2.0" xmlns:g="http://base.google.com/ns/1.0"><channel><title>${xml(brand)}</title><link>${xml(base)}</link><description>${xml(`${brand} collection`)}</description>${items.join("\n")}</channel></rss>\n`;
}
