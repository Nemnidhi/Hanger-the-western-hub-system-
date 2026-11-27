import { createHash } from "node:crypto";
import mongoose from "mongoose";
import { Contact, Order, getSettings } from "../models/index.js";
import { RetryableError } from "../jobs/queue.js";

// Meta ads, on the brand's own Business Manager.
// 1. Every confirmed order goes to Meta's Conversions API as a Purchase (server to server: no pixel on
//    the website needed), so Meta can tell which ads sold. Only hashed details leave: phone, name,
//    pincode, our customer id; plus the click id when she came from an ad. Website orders are
//    "website", WhatsApp orders "business_messaging" when she came from a Click-to-WhatsApp ad (else
//    "chat"), store sales "physical_store".
// 2. The Ads page reads spend, clicks and Meta's own purchase count per campaign, and sets them beside
//    our own sales from the same campaigns (the website's utm_campaign, the WhatsApp ad she tapped).

export const SALE_STATUSES = ["confirmed", "packed", "shipped", "delivered"];
const DAY_MS = 24 * 60 * 60 * 1000;
const sha = (value) => createHash("sha256").update(value).digest("hex");
const clean = (value) => String(value || "").trim().toLowerCase();

/** The Purchase event for one order (Meta's format). Pure: everything comes in. */
export function purchaseEvent({ order, contact, config }) {
  const phone = String(order.customer?.phone || contact?.waId || "").replace(/\D/g, "");
  const waPhone = /^[6-9]\d{9}$/.test(phone) ? `91${phone}` : phone;
  const [first, ...rest] = clean(order.shipTo?.name || order.customer?.name).split(/\s+/).filter(Boolean);
  const attribution = order.attribution || {};
  const user = {
    ...(waPhone ? { ph: [sha(waPhone)] } : {}),
    external_id: [sha(String(order.contactId || waPhone || order._id))],
    ...(first ? { fn: [sha(first.replace(/[^a-zऀ-ॿ]/g, ""))] } : {}),
    ...(rest.length ? { ln: [sha(rest.join("").replace(/[^a-zऀ-ॿ]/g, ""))] } : {}),
    ...(order.shipTo?.pincode ? { zp: [sha(order.shipTo.pincode)] } : {}),
    country: [sha("in")],
  };
  let actionSource = "other";
  const extra = {};
  if (order.channel === "website") {
    actionSource = "website";
    if (config.PUBLIC_STORE_URL) extra.event_source_url = `${config.PUBLIC_STORE_URL}/checkout`;
    if (attribution.ip) user.client_ip_address = attribution.ip;
    if (attribution.userAgent) user.client_user_agent = attribution.userAgent;
    if (attribution.fbclid) user.fbc = `fb.1.${new Date(attribution.landedAt || order.createdAt).getTime()}.${attribution.fbclid}`;
  } else if (order.channel === "whatsapp") {
    if (attribution.ctwaClid) {
      actionSource = "business_messaging";
      extra.messaging_channel = "whatsapp";
      user.ctwa_clid = attribution.ctwaClid;
      if (config.WHATSAPP_BUSINESS_ACCOUNT_ID) user.whatsapp_business_account_id = config.WHATSAPP_BUSINESS_ACCOUNT_ID;
    } else actionSource = "chat";
  } else if (order.channel === "store") actionSource = "physical_store";
  else if (order.channel === "phone") actionSource = "phone_call";

  return {
    event_name: "Purchase",
    event_time: Math.floor(new Date(order.confirmedAt || order.createdAt).getTime() / 1000),
    event_id: `purchase-${order._id}`,
    action_source: actionSource,
    ...extra,
    user_data: user,
    custom_data: {
      currency: "INR",
      value: Math.round(order.totals.totalPaise) / 100,
      order_id: String(order.number),
      content_type: "product",
      content_ids: [...new Set(order.lines.map((line) => line.skuCode))],
      contents: order.lines.map((line) => ({ id: line.skuCode, quantity: line.qty, item_price: line.unitPaise / 100 })),
      num_items: order.lines.reduce((sum, line) => sum + line.qty, 0),
    },
  };
}

function graphUrl(config, path) {
  return `${config.META_GRAPH_BASE.replace(/\/$/, "")}/${config.META_GRAPH_VERSION}/${path}`;
}

async function metaFetch({ config, fetchImpl, url, init = {} }) {
  let response;
  try {
    response = await fetchImpl(url, { ...init, headers: { Authorization: `Bearer ${config.META_ADS_TOKEN}`, ...(init.body ? { "Content-Type": "application/json" } : {}) }, signal: AbortSignal.timeout(20_000) });
  } catch (error) {
    throw new RetryableError(`Could not reach Meta: ${error?.message || error}`);
  }
  const data = await response.json().catch(() => ({}));
  if (response.ok) return data;
  const message = `Meta refused (HTTP ${response.status}${data?.error?.code ? `, code ${data.error.code}` : ""}): ${data?.error?.message || "no details"}`;
  if (response.status === 429 || response.status >= 500) throw new RetryableError(message);
  throw Object.assign(new Error(message), { permanent: true, status: response.status });
}

export function createAdsHandlers({ config, fetchImpl = fetch, now = () => new Date() }) {
  const tenantId = config.TENANT_ID;
  return {
    /** A confirmed order to the Conversions API, once. Nothing when no pixel is set or it is turned off. */
    async "meta.purchase"({ orderId }) {
      if (!config.META_PIXEL_ID || !config.META_ADS_TOKEN) return;
      const order = await Order.findOne({ _id: orderId, tenantId });
      if (!order || order.metaEvent?.status === "sent") return;
      const settings = await getSettings(tenantId);
      const skip = async (why) => Order.updateOne({ _id: order._id }, { $set: { metaEvent: { status: "skipped", at: now(), error: why } } });
      if (settings.ads?.sendPurchases === false) return skip("turned off in Settings");
      if (!(settings.ads?.channels || ["website", "whatsapp", "store"]).includes(order.channel)) return skip(`${order.channel} sales are not sent`);
      if (!SALE_STATUSES.includes(order.status)) return skip(`order is ${order.status}`);
      // Meta takes events up to 7 days old.
      if (now() - new Date(order.confirmedAt || order.createdAt) > 7 * DAY_MS) return skip("older than 7 days");
      const contact = order.contactId ? await Contact.findById(order.contactId).lean() : null;
      const body = { data: [purchaseEvent({ order, contact, config })], ...(config.META_TEST_EVENT_CODE ? { test_event_code: config.META_TEST_EVENT_CODE } : {}) };
      try {
        const result = await metaFetch({ config, fetchImpl, url: graphUrl(config, `${config.META_PIXEL_ID}/events`), init: { method: "POST", body: JSON.stringify(body) } });
        await Order.updateOne({ _id: order._id }, { $set: { metaEvent: { status: "sent", at: now(), error: "", received: Number(result?.events_received) || 0, test: Boolean(config.META_TEST_EVENT_CODE) } } });
      } catch (error) {
        if (error instanceof RetryableError) throw error;
        await Order.updateOne({ _id: order._id }, { $set: { metaEvent: { status: "failed", at: now(), error: String(error.message).slice(0, 300) } } });
      }
    },
  };
}

// ---- The Ads page -------------------------------------------------------------------------------
const PURCHASE_TYPES = ["purchase", "omni_purchase", "offsite_conversion.fb_pixel_purchase", "onsite_conversion.purchase", "onsite_web_purchase"];
const actionValue = (list, types) => {
  const rows = Array.isArray(list) ? list : [];
  for (const type of types) {
    const row = rows.find((entry) => entry.action_type === type);
    if (row) return Number(row.value) || 0;
  }
  return 0;
};
const ymd = (date) => date.toISOString().slice(0, 10);
const cache = new Map();

/** Spend, reach and Meta's own purchases per ad over a period, from the Marketing API (15 minutes cached). */
export async function metaInsights({ config, fetchImpl = fetch, since, until }) {
  const key = `${config.META_AD_ACCOUNT_ID}:${ymd(since)}:${ymd(until)}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < 15 * 60_000) return hit.rows;
  const params = new URLSearchParams({
    level: "ad",
    fields: "campaign_id,campaign_name,ad_id,ad_name,spend,impressions,clicks,actions,action_values",
    time_range: JSON.stringify({ since: ymd(since), until: ymd(until) }),
    limit: "500",
  });
  const rows = [];
  let url = graphUrl(config, `act_${config.META_AD_ACCOUNT_ID}/insights?${params}`);
  for (let page = 0; url && page < 20; page += 1) {
    const data = await metaFetch({ config, fetchImpl, url });
    for (const row of Array.isArray(data.data) ? data.data : []) {
      rows.push({
        campaignId: String(row.campaign_id || ""),
        campaignName: String(row.campaign_name || ""),
        adId: String(row.ad_id || ""),
        spendPaise: Math.round((Number(row.spend) || 0) * 100),
        impressions: Number(row.impressions) || 0,
        clicks: Number(row.clicks) || 0,
        metaPurchases: actionValue(row.actions, PURCHASE_TYPES),
        metaValuePaise: Math.round(actionValue(row.action_values, PURCHASE_TYPES) * 100),
      });
    }
    url = data.paging?.next || "";
  }
  cache.set(key, { at: Date.now(), rows });
  return rows;
}

/** Where a sale came from, in words for the page. */
export function sourceOf(order) {
  const attribution = order.attribution || {};
  if (attribution.adId || attribution.ctwaClid) return { source: "meta", medium: "whatsapp ad", campaign: attribution.campaign || "", adId: attribution.adId || "" };
  if (attribution.source || attribution.fbclid) return { source: clean(attribution.source) || "meta", medium: clean(attribution.medium) || (attribution.fbclid ? "paid" : ""), campaign: String(attribution.campaign || "").trim(), adId: "" };
  if (order.discount?.creatorId) return { source: "creator", medium: "code", campaign: order.discount.code || "", adId: "" };
  return { source: order.channel === "store" ? "store" : "direct", medium: order.channel, campaign: "", adId: "" };
}

/**
 * The Ads page: per Meta campaign, what Meta says (spend, clicks, its purchases) beside our own sales
 * from that campaign; then every other source of sales. ROAS = our sales / spend.
 */
export async function adsSummary({ tenantId, config, fetchImpl = fetch, days = 7, now = new Date() }) {
  const until = new Date(now);
  const since = new Date(now.getTime() - (days - 1) * DAY_MS);
  since.setUTCHours(0, 0, 0, 0);
  const orders = await Order.find({ tenantId, status: mongoose.trusted({ $in: SALE_STATUSES }), confirmedAt: mongoose.trusted({ $gte: since, $lte: until }) }).lean();

  let meta = { connected: Boolean(config.META_AD_ACCOUNT_ID && config.META_ADS_TOKEN), error: "", rows: [] };
  if (meta.connected) {
    try {
      meta.rows = await metaInsights({ config, fetchImpl, since, until });
    } catch (error) {
      meta.error = error.message;
    }
  }

  const campaigns = new Map();
  const adToCampaign = new Map();
  for (const row of meta.rows) {
    if (!campaigns.has(row.campaignId)) campaigns.set(row.campaignId, { id: row.campaignId, name: row.campaignName, spendPaise: 0, impressions: 0, clicks: 0, metaPurchases: 0, metaValuePaise: 0, orders: 0, salesPaise: 0 });
    const campaign = campaigns.get(row.campaignId);
    for (const field of ["spendPaise", "impressions", "clicks", "metaPurchases", "metaValuePaise"]) campaign[field] += row[field];
    adToCampaign.set(row.adId, row.campaignId);
  }
  const byName = new Map([...campaigns.values()].map((campaign) => [clean(campaign.name), campaign.id]));

  const others = new Map();
  for (const order of orders) {
    const from = sourceOf(order);
    const campaignId = (from.adId && adToCampaign.get(from.adId)) || (from.campaign && (campaigns.has(from.campaign) ? from.campaign : byName.get(clean(from.campaign))));
    if (campaignId) {
      const campaign = campaigns.get(campaignId);
      campaign.orders += 1;
      campaign.salesPaise += order.totals.totalPaise;
      continue;
    }
    const key = `${from.source}|${from.medium}|${from.campaign}`;
    if (!others.has(key)) others.set(key, { source: from.source, medium: from.medium, campaign: from.campaign, orders: 0, salesPaise: 0 });
    const row = others.get(key);
    row.orders += 1;
    row.salesPaise += order.totals.totalPaise;
  }

  const campaignRows = [...campaigns.values()]
    .map((campaign) => ({ ...campaign, roas: campaign.spendPaise ? Math.round((campaign.salesPaise / campaign.spendPaise) * 100) / 100 : null, costPerOrderPaise: campaign.orders ? Math.round(campaign.spendPaise / campaign.orders) : null }))
    .sort((a, b) => b.spendPaise - a.spendPaise);
  const spendPaise = campaignRows.reduce((sum, row) => sum + row.spendPaise, 0);
  const adSalesPaise = campaignRows.reduce((sum, row) => sum + row.salesPaise, 0);
  const salesPaise = orders.reduce((sum, order) => sum + order.totals.totalPaise, 0);
  const sent = await Order.countDocuments({ tenantId, "metaEvent.status": "sent", confirmedAt: mongoose.trusted({ $gte: since, $lte: until }) });
  const failed = await Order.find({ tenantId, "metaEvent.status": "failed", confirmedAt: mongoose.trusted({ $gte: since, $lte: until }) }).select("number metaEvent").limit(5).lean();
  return {
    period: { days, since, until },
    connected: meta.connected,
    error: meta.error,
    pixel: { connected: Boolean(config.META_PIXEL_ID && config.META_ADS_TOKEN), test: Boolean(config.META_TEST_EVENT_CODE), sent, failed: failed.map((order) => ({ number: order.number, error: order.metaEvent.error })) },
    totals: { orders: orders.length, salesPaise, spendPaise, adSalesPaise, roas: spendPaise ? Math.round((adSalesPaise / spendPaise) * 100) / 100 : null },
    campaigns: campaignRows,
    others: [...others.values()].sort((a, b) => b.salesPaise - a.salesPaise),
  };
}
