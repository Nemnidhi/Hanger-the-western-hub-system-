import mongoose from "mongoose";
import { Contact, Location, Markdown, PurchaseOrder, Return, Sku, StockLevel, StockMove, Style, Supplier, getSettings, nextNumber } from "../models/index.js";
import { rateForPiece, taxableFrom } from "./gst.js";
import { receiveStock } from "./stock.js";
import { sortSizes } from "./catalog.js";
import { stockReport } from "./reports.js";

// The buying desk: what sells and how fast, what to buy again and in which sizes, the shop's own size
// mix, how each supplier does, how test buys went, what to mark down (openly or quietly for members),
// and when to buy for the moments ahead. Every judgement is a graded score with its reasons, never a
// pass / fail line; the owner decides.

const DAY = 86_400_000;
const trusted = (filter) => mongoose.trusted(filter);
const fail = (status, message, code) => Object.assign(new Error(message), { status, code });
const clamp = (value, low = 0, high = 1) => Math.max(low, Math.min(high, value));
const days = (from, to) => Math.max(0, (to - new Date(from)) / DAY);
const median = (values) => {
  const sorted = values.filter((value) => Number.isFinite(value)).sort((a, b) => a - b);
  if (!sorted.length) return null;
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
};
const QUALITY_REASONS = ["quality", "damaged", "looks_different", "wrong_item"];
const plural = (count, word) => `${count} ${word}${count === 1 ? "" : "s"}`;

/** A whole-rupee price ending in 9 (Rs 1,599), never below the floor. */
export function retailPrice(paise, floorPaise = 0) {
  const rupees = Math.round(paise / 1000) * 10 - 1;
  return Math.max(floorPaise, rupees * 100);
}

/** The lowest price a markdown may reach: cost plus the minimum markup, plus GST. Without a cost, half the price. */
export function floorPrice(style, settings) {
  if (!style.costPaise) return Math.round(style.pricePaise / 2);
  const exGst = style.costPaise * (1 + (settings.buying?.minMarkupPct ?? 15) / 100);
  const rate = rateForPiece(Math.round(exGst * 1.05), settings.gstSlabs);
  return Math.ceil((exGst * (1 + rate / 100)) / 100) * 100;
}

/**
 * Everything the desk knows per style: stock and on order by size, pieces sold and returned (all
 * channels), pace, sell-through, cover, margin. Styles that are live, or have stock, or sold in the
 * last 180 days.
 */
export async function styleStats({ tenantId, settings, now = new Date() }) {
  const since180 = new Date(now.getTime() - 180 * DAY);
  const styles = await Style.find({ tenantId, status: trusted({ $in: ["live", "draft", "archived"] }) }).lean();
  const skus = await Sku.find({ tenantId, styleId: trusted({ $in: styles.map((style) => style._id) }) }, { styleId: 1, code: 1, size: 1, pricePaise: 1 }).lean();
  const levels = await StockLevel.find({ tenantId, skuId: trusted({ $in: skus.map((sku) => sku._id) }) }, { skuId: 1, onHand: 1, available: 1 }).lean();
  const open = await PurchaseOrder.find({ tenantId, status: trusted({ $in: ["sent", "part_received"] }) }, { lines: 1 }).lean();
  const moves = await StockMove.aggregate([
    { $match: { tenantId, kind: trusted({ $in: ["sale", "cancel", "receive"] }), skuId: trusted({ $in: skus.map((sku) => sku._id) }) } },
    {
      $group: {
        _id: { skuId: "$skuId", kind: "$kind" },
        total: { $sum: "$qty" },
        d30: { $sum: { $cond: [{ $gte: ["$at", new Date(now.getTime() - 30 * DAY)] }, "$qty", 0] } },
        d90: { $sum: { $cond: [{ $gte: ["$at", new Date(now.getTime() - 90 * DAY)] }, "$qty", 0] } },
        d180: { $sum: { $cond: [{ $gte: ["$at", since180] }, "$qty", 0] } },
        first: { $min: "$at" },
        last: { $max: "$at" },
      },
    },
  ]);
  const returns = await Return.find({ tenantId, at: trusted({ $gte: since180 }) }, { lines: 1, at: 1 }).lean();

  const skuById = new Map(skus.map((sku) => [String(sku._id), sku]));
  const bySku = new Map(skus.map((sku) => [String(sku._id), { onHand: 0, available: 0, onOrder: 0, sold: 0, sold30: 0, sold90: 0, sold180: 0, received: 0, firstReceive: null, lastSale: null, returned: 0, quality: 0, tooSmall: 0, tooBig: 0 }]));
  for (const level of levels) {
    const row = bySku.get(String(level.skuId));
    if (row) {
      row.onHand += level.onHand;
      row.available += level.available;
    }
  }
  for (const po of open) for (const line of po.lines) {
    const row = bySku.get(String(line.skuId));
    if (row) row.onOrder += Math.max(0, line.qty - line.receivedQty);
  }
  for (const move of moves) {
    const row = bySku.get(String(move._id.skuId));
    if (!row) continue;
    if (move._id.kind === "receive") {
      row.received += move.total;
      row.firstReceive = move.first;
    } else {
      // Sales are negative moves; a cancelled order's pieces come back as positive "cancel" moves.
      row.sold -= move.total;
      row.sold30 -= move.d30;
      row.sold90 -= move.d90;
      row.sold180 -= move.d180;
      if (move._id.kind === "sale") row.lastSale = move.last;
    }
  }
  const skuByCode = new Map(skus.map((sku) => [sku.code, sku]));
  for (const ret of returns) for (const line of ret.lines) {
    const sku = skuByCode.get(line.skuCode);
    const row = sku && bySku.get(String(sku._id));
    if (!row) continue;
    row.returned += line.qty;
    if (QUALITY_REASONS.includes(line.reason)) row.quality += line.qty;
    if (line.reason === "too_small") row.tooSmall += line.qty;
    if (line.reason === "too_big") row.tooBig += line.qty;
  }

  const out = [];
  for (const style of styles) {
    const own = skus.filter((sku) => String(sku.styleId) === String(style._id));
    if (!own.length) continue;
    const sizes = sortSizes(own.map((sku) => sku.size)).map((size) => {
      const sku = own.find((row) => row.size === size);
      return { size, skuCode: sku.code, skuId: sku._id, pricePaise: sku.pricePaise, ...bySku.get(String(sku._id)) };
    });
    const sum = (key) => sizes.reduce((total, row) => total + row[key], 0);
    const onHand = sum("onHand");
    const sold = sum("sold");
    const sold180 = sum("sold180");
    if (style.status !== "live" && !onHand && !sold180) continue;
    const firstReceive = sizes.map((row) => row.firstReceive).filter(Boolean).sort((a, b) => a - b)[0] || null;
    const lastSale = sizes.map((row) => row.lastSale).filter(Boolean).sort((a, b) => b - a)[0] || null;
    const since = style.liveAt || firstReceive || style.createdAt;
    const daysLive = Math.max(1, days(since, now));
    // Pieces a day: the last 30 days count most, steadied by the last 90.
    const pace30 = sum("sold30") / Math.min(30, daysLive);
    const pace90 = sum("sold90") / Math.min(90, daysLive);
    const pace = Math.max(0, daysLive >= 30 ? 0.6 * pace30 + 0.4 * pace90 : pace30);
    const returned = sum("returned");
    const keptSold = Math.max(0, sold - returned);
    const rate = rateForPiece(style.pricePaise, settings.gstSlabs);
    const listPaise = style.markdown?.kind === "public" ? style.markdown.listPaise : style.pricePaise;
    const exGst = taxableFrom(style.pricePaise, rate);
    out.push({
      styleId: style._id,
      styleCode: style.code,
      name: style.name,
      category: style.category,
      status: style.status,
      image: style.images?.[0] || "",
      supplierId: style.supplierId || null,
      pricePaise: style.pricePaise,
      listPaise,
      costPaise: style.costPaise || 0,
      marginPct: style.costPaise ? (exGst - style.costPaise) / exGst : null,
      markdown: style.markdown?.kind ? style.markdown : null,
      sizes,
      onHand,
      onOrder: sum("onOrder"),
      received: sum("received"),
      sold,
      sold30: sum("sold30"),
      sold90: sum("sold90"),
      returned,
      quality: sum("quality"),
      returnRate: sold ? returned / sold : 0,
      sellThrough: keptSold + onHand > 0 ? keptSold / (keptSold + onHand) : 0,
      pace,
      coverDays: pace > 0 ? onHand / pace : null,
      daysLive: Math.round(daysLive),
      daysSinceSale: lastSale ? Math.round(days(lastSale, now)) : null,
      firstReceive,
      lastSale,
    });
  }
  return out;
}

/** The shop's own size mix per category over 180 days (pieces kept), with what fit returns say. */
export function sizeMixFrom(stats) {
  const byCategory = new Map();
  for (const style of stats) {
    const cat = byCategory.get(style.category) || new Map();
    for (const row of style.sizes) {
      const size = cat.get(row.size) || { size: row.size, sold: 0, kept: 0, received: 0, onHand: 0, tooSmall: 0, tooBig: 0 };
      size.sold += Math.max(0, row.sold180);
      size.kept += Math.max(0, row.sold180 - row.returned);
      size.received += row.received;
      size.onHand += row.onHand;
      size.tooSmall += row.tooSmall;
      size.tooBig += row.tooBig;
      cat.set(row.size, size);
    }
    byCategory.set(style.category, cat);
  }
  return [...byCategory.entries()]
    .map(([category, sizes]) => {
      const list = sortSizes([...sizes.keys()]).map((size) => sizes.get(size));
      const kept = list.reduce((sum, row) => sum + row.kept, 0);
      const received = list.reduce((sum, row) => sum + row.received, 0);
      return {
        category,
        kept,
        sizes: list.map((row) => {
          const share = kept ? row.kept / kept : 0;
          const bought = received ? row.received / received : 0;
          const notes = [];
          if (kept >= 10 && received >= 10 && share - bought >= 0.05) notes.push(`sells ${Math.round(share * 100)}% but is ${Math.round(bought * 100)}% of what came in: buy more ${row.size}`);
          if (kept >= 10 && received >= 10 && bought - share >= 0.05) notes.push(`is ${Math.round(bought * 100)}% of what came in but sells ${Math.round(share * 100)}%: buy less ${row.size}`);
          if (row.tooSmall >= 2 && row.tooSmall >= 2 * row.tooBig) notes.push(`${plural(row.tooSmall, "return")} too small: these may run small`);
          if (row.tooBig >= 2 && row.tooBig >= 2 * row.tooSmall) notes.push(`${plural(row.tooBig, "return")} too big: these may run large`);
          return { ...row, share, boughtShare: bought, notes };
        }),
      };
    })
    .filter((row) => row.kept > 0 || row.sizes.some((size) => size.onHand > 0))
    .sort((a, b) => b.kept - a.kept);
}

/** Each supplier's lead time in days from its purchase orders (sent to first pieces in), median. */
async function supplierLeadTimes(tenantId) {
  const pos = await PurchaseOrder.find({ tenantId, sentAt: trusted({ $ne: null }), firstReceivedAt: trusted({ $ne: null }) }, { supplierId: 1, sentAt: 1, firstReceivedAt: 1 }).lean();
  const bySupplier = new Map();
  for (const po of pos) {
    const list = bySupplier.get(String(po.supplierId)) || [];
    list.push(days(po.sentAt, po.firstReceivedAt));
    bySupplier.set(String(po.supplierId), list);
  }
  return new Map([...bySupplier.entries()].map(([id, list]) => [id, median(list)]));
}

/**
 * What to buy again, ranked by a reorder score (0-100) with its reasons, and how many of each size:
 * enough to sell for the supplier's lead time plus the cover days, less stock and what is on order.
 * Sizes follow the style's own sales, leaning on the category's mix while the style has few sales.
 */
export async function reorderPlan({ tenantId, now = new Date() }) {
  const settings = await getSettings(tenantId);
  const stats = await styleStats({ tenantId, settings, now });
  const mix = new Map(sizeMixFrom(stats).map((row) => [row.category, new Map(row.sizes.map((size) => [size.size, size.share]))]));
  const leads = await supplierLeadTimes(tenantId);
  const suppliers = new Map((await Supplier.find({ tenantId }, { name: 1 }).lean()).map((row) => [String(row._id), row.name]));
  const coverDays = settings.buying?.coverDays ?? 45;
  const selling = stats.filter((style) => style.status === "live" && style.sold90 > 0 && !style.markdown);
  const paces = selling.map((style) => style.pace).sort((a, b) => a - b);
  const paceRank = (pace) => (paces.length > 1 ? paces.filter((value) => value < pace).length / (paces.length - 1) : 1);

  const rows = selling.map((style) => {
    const lead = leads.get(String(style.supplierId)) ?? settings.buying?.leadDays ?? 14;
    const horizon = lead + coverDays;
    const need = style.pace * horizon;
    const have = style.onHand + style.onOrder;
    const shortage = need > 0 ? clamp(1 - have / need) : 0;
    const speed = paceRank(style.pace);
    const keep = 1 - clamp(style.returnRate * 2);
    const margin = style.marginPct === null ? 0.5 : clamp(style.marginPct / 0.6);
    const score = Math.round(100 * (0.35 * speed + 0.25 * style.sellThrough + 0.2 * shortage + 0.1 * margin + 0.1 * keep));

    // Sizes: the style's own share, shrunk towards the category's while it has few sales.
    const ownSold = style.sizes.reduce((sum, row) => sum + Math.max(0, row.sold90 - row.returned), 0);
    const weight = ownSold / (ownSold + 8);
    const catMix = mix.get(style.category) || new Map();
    const sizes = style.sizes.map((row) => {
      const ownShare = ownSold ? Math.max(0, row.sold90 - row.returned) / ownSold : 0;
      const share = weight * ownShare + (1 - weight) * (catMix.get(row.size) ?? 1 / style.sizes.length);
      return { size: row.size, skuCode: row.skuCode, share, onHand: row.onHand, onOrder: row.onOrder, suggest: Math.max(0, Math.round(style.pace * share * horizon - row.onHand - row.onOrder)) };
    });
    const total = sizes.reduce((sum, row) => sum + row.suggest, 0);
    const why = [
      `${style.pace >= 0.1 ? `${(style.pace * 7).toFixed(1)} a week` : `${Math.round(style.pace * 30)} a month`} (faster than ${Math.round(speed * 100)}% of what sells)`,
      `${Math.round(style.sellThrough * 100)}% sold of what came in`,
      style.coverDays === null ? "no stock left" : `${Math.round(style.coverDays)} days of stock left${style.onOrder ? `, ${style.onOrder} on order` : ""}`,
      style.marginPct === null ? "cost not entered" : `${Math.round(style.marginPct * 100)}% margin`,
    ];
    if (style.returned) why.push(`${Math.round(style.returnRate * 100)}% came back`);
    return {
      ...style,
      sizes: undefined,
      supplier: suppliers.get(String(style.supplierId)) || "",
      leadDays: Math.round(lead),
      score,
      why,
      suggest: { total, sizes, horizonDays: Math.round(horizon), costPaise: total * style.costPaise },
    };
  });
  rows.sort((a, b) => b.score - a.score);
  return { coverDays, rows };
}

/** Supplier scorecard: how what each supplier sent sells, earns, comes back, and arrives. */
export async function supplierScorecard({ tenantId, now = new Date() }) {
  const settings = await getSettings(tenantId);
  const stats = await styleStats({ tenantId, settings, now });
  const suppliers = await Supplier.find({ tenantId }).lean();
  const pos = await PurchaseOrder.find({ tenantId, status: trusted({ $in: ["sent", "part_received", "received"] }) }).lean();
  return suppliers
    .map((supplier) => {
      const own = stats.filter((style) => String(style.supplierId) === String(supplier._id));
      const orders = pos.filter((po) => String(po.supplierId) === String(supplier._id));
      const received = own.reduce((sum, style) => sum + style.received, 0);
      const sold = own.reduce((sum, style) => sum + style.sold, 0);
      const returned = own.reduce((sum, style) => sum + style.returned, 0);
      const quality = own.reduce((sum, style) => sum + style.quality, 0);
      const onHand = own.reduce((sum, style) => sum + style.onHand, 0);
      const kept = Math.max(0, sold - returned);
      const sellThrough = kept + onHand ? kept / (kept + onHand) : 0;
      const costed = own.filter((style) => style.marginPct !== null && style.sold);
      const margin = costed.length ? costed.reduce((sum, style) => sum + style.marginPct * style.sold, 0) / costed.reduce((sum, style) => sum + style.sold, 0) : null;
      const leads = orders.filter((po) => po.sentAt && po.firstReceivedAt).map((po) => days(po.sentAt, po.firstReceivedAt));
      const timed = orders.filter((po) => po.expectedAt && po.firstReceivedAt);
      const onTime = timed.length ? timed.filter((po) => po.firstReceivedAt <= new Date(new Date(po.expectedAt).getTime() + DAY)).length / timed.length : null;
      const ordered = orders.reduce((sum, po) => sum + po.lines.reduce((n, line) => n + line.qty, 0), 0);
      const came = orders.reduce((sum, po) => sum + po.lines.reduce((n, line) => n + line.receivedQty, 0), 0);
      const closed = orders.filter((po) => po.status === "received");
      const fill = closed.length ? closed.reduce((sum, po) => sum + po.lines.reduce((n, line) => n + Math.min(line.qty, line.receivedQty), 0), 0) / closed.reduce((sum, po) => sum + po.lines.reduce((n, line) => n + line.qty, 0), 0) : null;
      const qualityRate = sold ? quality / sold : 0;
      const returnRate = sold ? returned / sold : 0;
      const delivery = onTime === null && fill === null ? 0.5 : ((onTime ?? fill) + (fill ?? onTime)) / 2;
      const score = own.length ? Math.round(100 * (0.35 * sellThrough + 0.2 * (margin === null ? 0.5 : clamp(margin / 0.6)) + 0.2 * (1 - clamp(qualityRate * 5)) + 0.15 * delivery + 0.1 * (1 - clamp(returnRate * 2)))) : null;
      const why = own.length
        ? [
            `${Math.round(sellThrough * 100)}% of ${plural(received, "piece")} sold`,
            margin === null ? "costs not entered" : `${Math.round(margin * 100)}% margin`,
            sold ? `${Math.round(qualityRate * 100)}% came back for quality / damage / not as shown` : "nothing sold yet",
            leads.length ? `${Math.round(median(leads))} days to deliver${onTime !== null ? `, ${Math.round(onTime * 100)}% on time` : ""}` : "no orders through the app yet",
          ]
        : ["no styles linked to this supplier yet"];
      if (fill !== null) why.push(`${Math.round(fill * 100)}% of ordered pieces came`);
      return {
        _id: supplier._id,
        name: supplier.name,
        city: supplier.city,
        waId: supplier.waId,
        styles: own.length,
        received,
        sold,
        onHand,
        sellThrough,
        marginPct: margin,
        returnRate,
        qualityRate,
        leadDays: median(leads),
        onTime,
        fill,
        orders: orders.length,
        piecesOrdered: ordered,
        piecesCame: came,
        score,
        why,
        top: own.sort((a, b) => b.sold90 - a.sold90).slice(0, 3).map((style) => ({ styleCode: style.styleCode, name: style.name, sold90: style.sold90 })),
      };
    })
    .sort((a, b) => (b.score ?? -1) - (a.score ?? -1));
}

/**
 * Test buys: how each style from a trial order is doing against others in its category, scored 0-100
 * (sell-through, pace against the category's typical pace, pieces kept), with a suggested next step.
 */
export async function trialResults({ tenantId, now = new Date() }) {
  const settings = await getSettings(tenantId);
  const stats = await styleStats({ tenantId, settings, now });
  const trials = await PurchaseOrder.find({ tenantId, trial: true, status: trusted({ $in: ["part_received", "received"] }) }).sort({ firstReceivedAt: -1 }).limit(100).lean();
  const suppliers = new Map((await Supplier.find({ tenantId }, { name: 1 }).lean()).map((row) => [String(row._id), row.name]));
  const catPace = new Map();
  for (const style of stats) if (style.sold90 > 0) catPace.set(style.category, [...(catPace.get(style.category) || []), style.pace]);
  const trialDays = settings.buying?.trialDays ?? 21;
  const seen = new Set();
  const rows = [];
  for (const po of trials) {
    for (const styleId of new Set(po.lines.map((line) => String(line.styleId)))) {
      if (seen.has(styleId)) continue;
      seen.add(styleId);
      const style = stats.find((row) => String(row.styleId) === styleId);
      if (!style) continue;
      const typical = median(catPace.get(style.category) || []) || 0;
      const relative = typical ? clamp(style.pace / typical / 2) : style.pace > 0 ? 0.5 : 0;
      const daysIn = Math.round(days(po.firstReceivedAt, now));
      const score = Math.round(100 * (0.5 * style.sellThrough + 0.3 * relative + 0.2 * (1 - clamp(style.returnRate * 2))));
      const step = daysIn < trialDays ? `early: ${trialDays - daysIn} more days before judging` : score >= 65 ? "buy more: it sells like a good style" : score >= 40 ? "wait and see, or buy a few more in the selling sizes" : "do not repeat; consider a quiet markdown";
      rows.push({
        styleId: style.styleId,
        styleCode: style.styleCode,
        name: style.name,
        category: style.category,
        image: style.image,
        supplier: suppliers.get(String(po.supplierId)) || "",
        poNumber: po.number,
        daysIn,
        bought: po.lines.filter((line) => String(line.styleId) === styleId).reduce((sum, line) => sum + line.receivedQty, 0),
        sold: style.sold,
        onHand: style.onHand,
        sellThrough: style.sellThrough,
        pace: style.pace,
        typicalPace: typical,
        returnRate: style.returnRate,
        score,
        step,
        why: [`${Math.round(style.sellThrough * 100)}% sold in ${plural(daysIn, "day")}`, typical ? `${(style.pace / typical).toFixed(1)}x the usual pace for ${style.category}` : "no other styles in this category to compare", style.returned ? `${style.returned} came back` : "none came back"],
      });
    }
  }
  return { trialDays, rows: rows.sort((a, b) => b.score - a.score) };
}

/**
 * Markdown plan: slow styles (from the stock report's slow score) with a suggested markdown that grows
 * with the score, never below cost plus the minimum markup, and whether to do it quietly for members
 * first (newer styles and broken size runs) or openly.
 */
export async function markdownPlan({ tenantId, now = new Date() }) {
  const settings = await getSettings(tenantId);
  const report = await stockReport({ tenantId, now, limit: 80 });
  const styles = await Style.find({ tenantId, code: trusted({ $in: report.slow.map((row) => row.styleCode) }) }).lean();
  const byCode = new Map(styles.map((style) => [style.code, style]));
  const sizeCount = new Map();
  for (const sku of await Sku.find({ tenantId, styleId: trusted({ $in: styles.map((style) => style._id) }) }, { styleCode: 1 }).lean()) sizeCount.set(sku.styleCode, (sizeCount.get(sku.styleCode) || 0) + 1);
  const active = await Markdown.find({ tenantId, status: "active" }).sort({ startedAt: -1 }).lean();
  const activeCodes = new Set(active.map((row) => row.styleCode));
  const members = await Contact.aggregate([
    { $match: { tenantId, "consents.offers.given": true, "fit.usualSize": trusted({ $ne: "" }) } },
    { $group: { _id: "$fit.usualSize", count: { $sum: 1 } } },
  ]);
  const membersBySize = new Map(members.map((row) => [row._id, row.count]));

  const plan = report.slow
    .filter((row) => row.status === "live" && !activeCodes.has(row.styleCode) && row.score >= 35)
    .map((row) => {
      const style = byCode.get(row.styleCode);
      const floor = floorPrice(style, settings);
      const wanted = Math.round((10 + 30 * clamp((row.score - 40) / 60)) / 5) * 5;
      const maxPct = Math.max(0, Math.floor(((style.pricePaise - floor) / style.pricePaise) * 100));
      const pct = Math.min(wanted, maxPct);
      const sizesLeft = Object.entries(row.sizes).filter(([, qty]) => qty > 0).map(([size]) => size);
      // A broken run: some sizes sold out and at most half are left.
      const total = sizeCount.get(row.styleCode) || sizesLeft.length;
      const broken = sizesLeft.length < total && sizesLeft.length <= Math.ceil(total / 2);
      const kind = row.daysOnRail < 60 || broken ? "quiet" : "public";
      const reach = sizesLeft.reduce((sum, size) => sum + (membersBySize.get(size) || 0), 0);
      return {
        styleCode: row.styleCode,
        name: row.name,
        category: row.category,
        image: style.images?.[0] || "",
        onHand: row.onHand,
        sizesLeft,
        pricePaise: style.pricePaise,
        costPaise: style.costPaise || 0,
        floorPaise: floor,
        score: row.score,
        why: row.why,
        suggest: {
          pct,
          kind,
          pricePaise: pct ? retailPrice(style.pricePaise * (1 - pct / 100), floor) : style.pricePaise,
          note: !pct ? "already at the lowest price the markup allows" : kind === "quiet" ? (broken ? `only ${sizesLeft.join(", ")} left: offer it quietly to members in those sizes (${reach} said yes to offers)` : "new on the rail: try a members-only price before marking it down openly") : "a public markdown: it has had its time on the rail",
          clearsAtValuePaise: (pct ? retailPrice(style.pricePaise * (1 - pct / 100), floor) : style.pricePaise) * row.onHand,
        },
        reach,
      };
    });

  // How earlier markdowns did: pieces at the start against pieces left, and days running.
  const history = await Markdown.find({ tenantId }).sort({ startedAt: -1 }).limit(60).lean();
  const left = await styleStats({ tenantId, settings, now });
  const onHand = new Map(left.map((row) => [row.styleCode, row.onHand]));
  return {
    plan,
    markdowns: history.map((row) => ({ ...row, onHandNow: onHand.get(row.styleCode) ?? 0, cleared: row.piecesAtStart ? 1 - (onHand.get(row.styleCode) ?? 0) / row.piecesAtStart : null, daysRunning: Math.round(days(row.startedAt, row.endedAt || now)) })),
  };
}

/** Starts a markdown. Public changes every size's price (and the catalogue on WhatsApp); quiet changes nothing on show. */
export async function startMarkdown({ tenantId, styleCode, kind, pct, until = null, reason = "", by, session, now = new Date() }) {
  const settings = await getSettings(tenantId, session);
  const style = await Style.findOne({ tenantId, code: String(styleCode).toUpperCase() }).session(session);
  if (!style) throw fail(404, "Style not found", "NO_STYLE");
  if (style.markdown?.kind) throw fail(409, `${style.code} is already marked down; end that first.`, "ALREADY_MARKED");
  const floor = floorPrice(style, settings);
  const price = retailPrice(style.pricePaise * (1 - pct / 100));
  if (price < floor || price >= style.pricePaise) throw fail(409, `At ${pct}% the price would fall below cost plus the minimum markup (Rs ${Math.round(floor / 100)}).`, "BELOW_FLOOR");
  const skus = await Sku.find({ tenantId, styleId: style._id }).session(session);
  const pieces = (await StockLevel.find({ tenantId, skuId: trusted({ $in: skus.map((sku) => sku._id) }) }).session(session)).reduce((sum, level) => sum + level.onHand, 0);
  const realPct = Math.round((1 - price / style.pricePaise) * 1000) / 10;
  const skuPrices = [];
  if (kind === "public") {
    for (const sku of skus) {
      const next = retailPrice(sku.pricePaise * (price / style.pricePaise), floor);
      skuPrices.push({ skuId: sku._id, skuCode: sku.code, listPaise: sku.pricePaise, pricePaise: next });
      sku.pricePaise = next;
      sku.metaDirty = true;
      await sku.save({ session });
    }
    style.markdown = { kind, listPaise: style.pricePaise, memberPaise: 0, pct: realPct, until };
    style.pricePaise = price;
  } else {
    style.markdown = { kind, listPaise: style.pricePaise, memberPaise: price, pct: realPct, until };
  }
  await style.save({ session });
  const [markdown] = await Markdown.create([{ tenantId, styleId: style._id, styleCode: style.code, kind, listPaise: style.markdown.listPaise, pricePaise: price, pct: realPct, skuPrices, reason, until, piecesAtStart: pieces, by, startedAt: now }], { session });
  return markdown;
}

/** Ends a markdown: public prices go back to what they were. */
export async function endMarkdown({ tenantId, markdown, session, now = new Date() }) {
  if (markdown.status !== "active") throw fail(409, "That markdown has already ended.", "ENDED");
  const style = await Style.findOne({ _id: markdown.styleId, tenantId }).session(session);
  if (markdown.kind === "public") {
    for (const row of markdown.skuPrices) await Sku.updateOne({ _id: row.skuId, tenantId }, { $set: { pricePaise: row.listPaise, metaDirty: true } }, { session });
    if (style) style.pricePaise = markdown.listPaise;
  }
  if (style) {
    style.markdown = { kind: "", listPaise: 0, memberPaise: 0, pct: 0, until: null };
    await style.save({ session });
  }
  markdown.status = "ended";
  markdown.endedAt = now;
  await markdown.save({ session });
  return markdown;
}

/**
 * Members' prices on a counter bill: a style on a quiet markdown sells at its member price when the
 * customer is a member (her phone is on the bill). Returns the saving.
 */
export async function memberPrices({ tenantId, lines, settings, session, now = new Date() }) {
  const codes = [...new Set(lines.map((line) => line.styleCode))];
  const styles = await Style.find({ tenantId, code: trusted({ $in: codes }), "markdown.kind": "quiet" }).session(session);
  let saving = 0;
  for (const style of styles) {
    if (style.markdown.until && new Date(style.markdown.until) < now) continue;
    for (const line of lines.filter((row) => row.styleCode === style.code)) {
      const price = retailPrice(line.unitPaise * (style.markdown.memberPaise / style.pricePaise));
      if (price >= line.unitPaise) continue;
      line.listUnitPaise = line.unitPaise;
      saving += (line.unitPaise - price) * line.qty;
      line.unitPaise = price;
      line.gstRate = rateForPiece(price, settings.gstSlabs);
    }
  }
  return saving;
}

/** The buying calendar: the next date of each moment, when to order by (lead time + weeks before), and what is in stock for it. */
export async function buyingCalendar({ tenantId, now = new Date() }) {
  const settings = await getSettings(tenantId);
  const lead = settings.buying?.leadDays ?? 14;
  const today = new Date(now.getTime() + 330 * 60_000).toISOString().slice(0, 10);
  const stats = await styleStats({ tenantId, settings, now });
  return (settings.buying?.calendar || [])
    .map((event) => {
      let date = event.date;
      if (event.yearly) {
        const [, month, day] = event.date.split("-");
        let year = Number(today.slice(0, 4));
        while (`${year}-${month}-${day}` < today) year += 1;
        date = `${year}-${month}-${day}`;
      }
      const at = new Date(`${date}T00:00:00+05:30`);
      const orderBy = new Date(at.getTime() - (lead + (event.buyWeeksBefore || 0) * 7) * DAY);
      const relevant = stats.filter((style) => style.status === "live" && (!event.categories?.length || event.categories.includes(style.category)));
      return {
        name: event.name,
        date,
        past: date < today,
        daysAway: Math.round((at - now) / DAY),
        orderBy: new Date(orderBy.getTime() + 330 * 60_000).toISOString().slice(0, 10),
        orderInDays: Math.round((orderBy - now) / DAY),
        categories: event.categories || [],
        note: event.note || "",
        inStock: relevant.reduce((sum, style) => sum + style.onHand, 0),
        styles: relevant.length,
      };
    })
    .filter((event) => !event.past)
    .sort((a, b) => a.date.localeCompare(b.date));
}

// ---- Purchase orders ------------------------------------------------------------------------------

/** A purchase order from sizes and quantities: [{ skuCode, qty, costPaise? }]. */
export async function createPurchaseOrder({ tenantId, supplierId, locationId, items, trial = false, note = "", expectedAt = null, by, session }) {
  const supplier = await Supplier.findOne({ _id: supplierId, tenantId }).session(session);
  if (!supplier) throw fail(404, "Supplier not found", "NO_SUPPLIER");
  const location = await Location.findOne({ _id: locationId, tenantId, active: true }).session(session);
  if (!location) throw fail(404, "Location not found", "NO_LOCATION");
  const wanted = new Map();
  for (const item of items) {
    const code = String(item.skuCode || "").toUpperCase();
    if (!code || !Number.isInteger(item.qty) || item.qty < 1) throw fail(400, "Each line needs a size code and a quantity", "BAD_ITEM");
    const row = wanted.get(code) || { qty: 0, costPaise: item.costPaise };
    row.qty += item.qty;
    wanted.set(code, row);
  }
  if (!wanted.size) throw fail(400, "Add at least one size", "EMPTY");
  const skus = await Sku.find({ tenantId, code: trusted({ $in: [...wanted.keys()] }) }).session(session);
  const missing = [...wanted.keys()].filter((code) => !skus.some((sku) => sku.code === code));
  if (missing.length) throw fail(404, `Not in the catalogue: ${missing.join(", ")}. Add the style first (as a draft).`, "UNKNOWN_ITEMS");
  const styles = new Map((await Style.find({ tenantId, _id: trusted({ $in: skus.map((sku) => sku.styleId) }) }).session(session)).map((style) => [String(style._id), style]));
  const lines = [...wanted.entries()].map(([code, row]) => {
    const sku = skus.find((item) => item.code === code);
    const style = styles.get(String(sku.styleId));
    return { skuId: sku._id, skuCode: sku.code, styleId: style._id, styleCode: style.code, name: style.name, size: sku.size, qty: row.qty, costPaise: Number.isInteger(row.costPaise) ? row.costPaise : style.costPaise || 0 };
  });
  lines.sort((a, b) => a.styleCode.localeCompare(b.styleCode) || sortSizes([a.size, b.size]).indexOf(a.size) - sortSizes([a.size, b.size]).indexOf(b.size));
  const [po] = await PurchaseOrder.create([{ tenantId, number: await nextNumber(`po:${tenantId}`, session), supplierId: supplier._id, locationId: location._id, trial, lines, note, expectedAt, createdBy: by }], { session });
  return po;
}

/** The order as a WhatsApp message for the supplier: styles with their sizes, in her reference where known. */
export async function purchaseOrderText({ tenantId, po }) {
  const settings = await getSettings(tenantId);
  const styles = new Map((await Style.find({ tenantId, _id: trusted({ $in: po.lines.map((line) => line.styleId) }) }, { supplierStyleRef: 1, code: 1 }).lean()).map((style) => [String(style._id), style]));
  const byStyle = new Map();
  for (const line of po.lines) {
    const row = byStyle.get(String(line.styleId)) || { name: line.name, ref: styles.get(String(line.styleId))?.supplierStyleRef || "", code: line.styleCode, sizes: [] };
    row.sizes.push(`${line.size} x ${line.qty}`);
    byStyle.set(String(line.styleId), row);
  }
  const pieces = po.lines.reduce((sum, line) => sum + line.qty, 0);
  const lines = [...byStyle.values()].map((row) => `- ${row.ref ? `${row.ref} (${row.name})` : row.name} [${row.code}]: ${row.sizes.join(", ")}`);
  return [`Order #${po.number} from ${settings.brandName || "The Hanger"}`, ...lines, `Total ${plural(pieces, "piece")}.`, po.expectedAt ? `Needed by ${new Date(po.expectedAt).toLocaleDateString("en-IN", { day: "numeric", month: "short" })}.` : "", po.note || ""].filter(Boolean).join("\n");
}

/** Pieces arrived against an order: into stock at the order's location, and the order's record updated. */
export async function receivePurchaseOrder({ tenantId, po, items, note = "", by, session, now = new Date() }) {
  if (!["sent", "part_received"].includes(po.status)) throw fail(409, "Only a sent order can be received against.", "NOT_SENT");
  const taking = [];
  for (const item of items) {
    const qty = Number(item.qty);
    if (!qty) continue;
    const line = po.lines.find((row) => row.skuCode === String(item.skuCode).toUpperCase());
    if (!line) throw fail(400, `${item.skuCode} is not on this order.`, "NOT_ON_ORDER");
    if (!Number.isInteger(qty) || qty < 1 || qty > 10000) throw fail(400, `Quantity for ${line.skuCode} must be a whole number`, "BAD_QTY");
    taking.push({ line, qty });
  }
  if (!taking.length) throw fail(400, "Enter how many pieces came.", "NO_ITEMS");
  const skus = await Sku.find({ tenantId, _id: trusted({ $in: taking.map(({ line }) => line.skuId) }) }).session(session);
  await receiveStock({ tenantId, locationId: po.locationId, items: taking.map(({ line, qty }) => ({ sku: skus.find((sku) => String(sku._id) === String(line.skuId)), qty })), supplierId: po.supplierId, by, note: `PO #${po.number}${note ? `: ${note}` : ""}`, session, at: now });
  for (const { line, qty } of taking) line.receivedQty += qty;
  // A style with no cost yet takes it from the order, and its supplier is this one if none was set.
  for (const styleId of new Set(taking.map(({ line }) => String(line.styleId)))) {
    const line = po.lines.find((row) => String(row.styleId) === styleId);
    const changes = {};
    const style = await Style.findById(styleId).session(session);
    if (style && !style.costPaise && line.costPaise) changes.costPaise = line.costPaise;
    if (style && !style.supplierId) changes.supplierId = po.supplierId;
    if (Object.keys(changes).length) await Style.updateOne({ _id: styleId }, { $set: changes }, { session });
  }
  const pieces = taking.reduce((sum, { qty }) => sum + qty, 0);
  po.receipts.push({ at: now, by, pieces, note });
  if (!po.firstReceivedAt) po.firstReceivedAt = now;
  const complete = po.lines.every((line) => line.receivedQty >= line.qty);
  po.status = complete ? "received" : "part_received";
  if (complete) po.receivedAt = now;
  await po.save({ session });
  return po;
}

/** A draft order to one supplier with every suggested reorder of its styles. */
export async function reorderDraft({ tenantId, supplierId, locationId, by, session, now = new Date() }) {
  const { rows } = await reorderPlan({ tenantId, now });
  const items = rows.filter((row) => String(row.supplierId) === String(supplierId)).flatMap((row) => row.suggest.sizes.filter((size) => size.suggest > 0).map((size) => ({ skuCode: size.skuCode, qty: size.suggest })));
  if (!items.length) throw fail(409, "Nothing from this supplier needs buying again right now.", "NOTHING_TO_ORDER");
  return createPurchaseOrder({ tenantId, supplierId, locationId, items, note: "Reorder from the buying desk", by, session });
}
