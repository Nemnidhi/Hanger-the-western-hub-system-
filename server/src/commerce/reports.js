import mongoose from "mongoose";
import { Invoice, Location, Order, Return, Sku, StockLevel, StockMove, Style } from "../models/index.js";

// The owner's reports: sales, stock (value and slow pieces) and the month's GST summary. Built from the
// invoices and credit notes (the legal record) and the stock ledger, never from anything staff can edit.
// Days are India days. Amounts in paise.

const IST = 330 * 60_000;
const DAY = 86_400_000;
const httpError = (status, message, code) => Object.assign(new Error(message), { status, code });
const trusted = (filter) => mongoose.trusted(filter);

/** The India date of an instant: "2026-11-27". */
export const istDay = (date) => new Date(new Date(date).getTime() + IST).toISOString().slice(0, 10);
/** The instant an India day starts. */
export function istStart(day) {
  const [year, month, date] = day.split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, date) - IST);
}

/** A report period: the India days from and to (both included), by default the last 30 days. */
export function periodOf({ from, to, now = new Date() }) {
  const valid = (day) => /^\d{4}-\d{2}-\d{2}$/.test(day) && istDay(istStart(day)) === day;
  const toDay = to || istDay(now);
  const fromDay = from || istDay(new Date(istStart(toDay).getTime() - 29 * DAY));
  if (!valid(fromDay) || !valid(toDay)) throw httpError(400, "Dates must be YYYY-MM-DD", "BAD_DATE");
  const start = istStart(fromDay);
  const end = new Date(istStart(toDay).getTime() + DAY);
  const days = Math.round((end - start) / DAY);
  if (days < 1) throw httpError(400, "The start date is after the end date", "BAD_PERIOD");
  if (days > 400) throw httpError(400, "Choose at most 400 days", "PERIOD_TOO_LONG");
  return { fromDay, toDay, start, end, days };
}

/** The size code on an invoice line (older lines only have it in the description). */
export const skuOfLine = (line) => line.skuCode || /\(([^()]+)\)\s*$/.exec(line.description || "")?.[1] || "";

async function catalogueFor(tenantId, skuCodes) {
  const skus = await Sku.find({ tenantId, code: trusted({ $in: [...new Set(skuCodes)] }) }, { code: 1, styleCode: 1, size: 1, styleId: 1 }).lean();
  const styles = await Style.find({ tenantId, _id: trusted({ $in: [...new Set(skus.map((sku) => String(sku.styleId)))] }) }, { code: 1, name: 1, category: 1, costPaise: 1, pricePaise: 1, supplierId: 1 }).lean();
  const styleById = new Map(styles.map((style) => [String(style._id), style]));
  return new Map(skus.map((sku) => [sku.code, { sku, style: styleById.get(String(sku.styleId)) || null }]));
}

const bump = (map, key, fields) => {
  const row = map.get(key) || Object.fromEntries(Object.keys(fields).map((field) => [field, 0]));
  for (const [field, value] of Object.entries(fields)) row[field] += value;
  map.set(key, row);
  return row;
};
const rows = (map, keyName) => [...map.entries()].map(([key, row]) => ({ [keyName]: key, ...row }));

/** Sales over a period: totals, by day, channel, payment and location, the best styles, sizes, categories. */
export async function salesReport({ tenantId, from, to, now = new Date() }) {
  const period = periodOf({ from, to, now });
  const invoices = await Invoice.find({ tenantId, date: trusted({ $gte: period.start, $lt: period.end }) }).lean();
  const orders = await Order.find({ tenantId, _id: trusted({ $in: invoices.map((invoice) => invoice.orderId) }) }, { channel: 1, "payment.method": 1, locationId: 1 }).lean();
  const orderById = new Map(orders.map((order) => [String(order._id), order]));
  const locations = await Location.find({ tenantId }, { code: 1, name: 1 }).lean();
  const locationName = new Map(locations.map((location) => [String(location._id), location.name || location.code]));
  const catalogue = await catalogueFor(tenantId, invoices.flatMap((invoice) => invoice.lines.map(skuOfLine)));

  const totals = { salesPaise: 0, returnsPaise: 0, netPaise: 0, taxablePaise: 0, gstPaise: 0, invoices: 0, creditNotes: 0, pieces: 0, piecesReturned: 0, costPaise: 0, costedTaxablePaise: 0 };
  const byDay = new Map();
  for (let day = period.start.getTime(); day < period.end.getTime(); day += DAY) byDay.set(istDay(day), { salesPaise: 0, returnsPaise: 0, bills: 0 });
  const byChannel = new Map();
  const byPayment = new Map();
  const byLocation = new Map();
  const byStyle = new Map();
  const bySize = new Map();
  const byCategory = new Map();

  for (const invoice of invoices) {
    const sign = invoice.kind === "invoice" ? 1 : -1;
    const total = invoice.totals.totalPaise;
    const order = orderById.get(String(invoice.orderId)) || {};
    if (sign > 0) {
      totals.salesPaise += total;
      totals.invoices += 1;
    } else {
      totals.returnsPaise += total;
      totals.creditNotes += 1;
    }
    totals.taxablePaise += sign * invoice.totals.taxablePaise;
    totals.gstPaise += sign * (invoice.totals.cgstPaise + invoice.totals.sgstPaise + invoice.totals.igstPaise);
    const day = byDay.get(istDay(invoice.date));
    if (day) {
      if (sign > 0) (day.salesPaise += total), (day.bills += 1);
      else day.returnsPaise += total;
    }
    const bills = sign > 0 ? 1 : 0;
    bump(byChannel, order.channel || "unknown", { netPaise: sign * total, bills });
    bump(byPayment, order.payment?.method || "unknown", { netPaise: sign * total, bills });
    bump(byLocation, locationName.get(String(invoice.locationId)) || "Unknown", { netPaise: sign * total, bills });

    for (const line of invoice.lines) {
      const code = skuOfLine(line);
      const { sku, style } = catalogue.get(code) || {};
      const qty = sign * line.qty;
      if (sign > 0) totals.pieces += line.qty;
      else totals.piecesReturned += line.qty;
      const cost = style?.costPaise ? style.costPaise * qty : 0;
      if (cost) {
        totals.costPaise += cost;
        totals.costedTaxablePaise += sign * line.taxablePaise;
      }
      const styleCode = style?.code || sku?.styleCode || code.replace(/-[^-]+$/, "") || "Unknown";
      const row = bump(byStyle, styleCode, { pieces: qty, netPaise: sign * line.totalPaise, taxablePaise: sign * line.taxablePaise, costPaise: cost, returned: sign < 0 ? line.qty : 0 });
      row.name = style?.name || line.description.replace(/ - [^-]+\([^()]*\)\s*$/, "");
      row.category = style?.category || "";
      row.costKnown = Boolean(style?.costPaise);
      bump(bySize, sku?.size || "?", { pieces: qty, netPaise: sign * line.totalPaise, returned: sign < 0 ? line.qty : 0 });
      bump(byCategory, style?.category || "unknown", { pieces: qty, netPaise: sign * line.totalPaise });
    }
  }
  totals.netPaise = totals.salesPaise - totals.returnsPaise;
  totals.averageBillPaise = totals.invoices ? Math.round(totals.salesPaise / totals.invoices) : 0;
  // Margin: the value before GST less the supplier cost, only over the pieces whose cost is entered.
  totals.marginPaise = totals.costedTaxablePaise - totals.costPaise;
  totals.costCoverage = totals.taxablePaise > 0 ? Math.min(1, totals.costedTaxablePaise / totals.taxablePaise) : 0;

  const styles = rows(byStyle, "styleCode")
    .map((row) => ({ ...row, marginPaise: row.costKnown ? row.taxablePaise - row.costPaise : null, marginPct: row.costKnown && row.taxablePaise > 0 ? (row.taxablePaise - row.costPaise) / row.taxablePaise : null }))
    .sort((a, b) => b.netPaise - a.netPaise);

  const delivery = await deliveryOutcomes({ tenantId, start: period.start, end: period.end });
  const returns = await returnReasons({ tenantId, start: period.start, end: period.end, soldByStyle: byStyle });
  return {
    period: { from: period.fromDay, to: period.toDay, days: period.days },
    totals,
    byDay: rows(byDay, "day"),
    byChannel: rows(byChannel, "channel").sort((a, b) => b.netPaise - a.netPaise),
    byPayment: rows(byPayment, "method").sort((a, b) => b.netPaise - a.netPaise),
    byLocation: rows(byLocation, "location").sort((a, b) => b.netPaise - a.netPaise),
    byCategory: rows(byCategory, "category").sort((a, b) => b.netPaise - a.netPaise),
    bySize: rows(bySize, "size").sort((a, b) => b.pieces - a.pieces),
    topStyles: styles.slice(0, 40),
    delivery,
    returns,
  };
}

/**
 * Why pieces came back in the period: by reason, by channel, and the styles that come back most, each
 * with its fit lean (-1 = every return "too small", +1 = every return "too big").
 */
async function returnReasons({ tenantId, start, end, soldByStyle }) {
  const returns = await Return.find({ tenantId, at: trusted({ $gte: start, $lt: end }) }, { lines: 1, channel: 1 }).lean();
  const byReason = new Map();
  const byChannel = new Map();
  const styles = new Map();
  for (const ret of returns) {
    for (const line of ret.lines) {
      const value = line.unitPaise * line.qty;
      bump(byReason, line.reason, { pieces: line.qty, valuePaise: value });
      bump(byChannel, ret.channel, { pieces: line.qty, valuePaise: value });
      const row = styles.get(line.styleCode) || { styleCode: line.styleCode, name: line.name, pieces: 0, reasons: {}, damaged: 0 };
      row.pieces += line.qty;
      row.reasons[line.reason] = (row.reasons[line.reason] || 0) + line.qty;
      if (line.condition === "damaged") row.damaged += line.qty;
      styles.set(line.styleCode, row);
    }
  }
  const topStyles = [...styles.values()]
    .map((row) => {
      const sold = soldByStyle.get(row.styleCode);
      const out = sold ? sold.pieces + sold.returned : 0; // pieces billed in the period
      const small = row.reasons.too_small || 0;
      const big = row.reasons.too_big || 0;
      return { ...row, soldInPeriod: out, returnRate: out ? Math.min(1, row.pieces / out) : null, fitLean: row.pieces ? (big - small) / row.pieces : 0 };
    })
    .sort((a, b) => b.pieces - a.pieces)
    .slice(0, 15);
  return {
    pieces: returns.reduce((sum, ret) => sum + ret.lines.reduce((n, line) => n + line.qty, 0), 0),
    byReason: rows(byReason, "reason").sort((a, b) => b.pieces - a.pieces),
    byChannel: rows(byChannel, "channel").sort((a, b) => b.pieces - a.pieces),
    topStyles,
  };
}

/** Online orders sent in the period: how many arrived, came back undelivered (RTO) or were returned. */
async function deliveryOutcomes({ tenantId, start, end }) {
  const sent = await Order.find({ tenantId, channel: trusted({ $ne: "store" }), "shipment.shippedAt": trusted({ $gte: start, $lt: end }) }, { status: 1, "payment.method": 1 }).lean();
  const out = { cod: { sent: 0, delivered: 0, rto: 0, returned: 0, onTheWay: 0 }, prepaid: { sent: 0, delivered: 0, rto: 0, returned: 0, onTheWay: 0 } };
  for (const order of sent) {
    const row = order.payment?.method === "cod" ? out.cod : out.prepaid;
    row.sent += 1;
    if (order.status === "delivered") row.delivered += 1;
    else if (order.status === "rto") row.rto += 1;
    else if (order.status === "returned") row.returned += 1;
    else row.onTheWay += 1;
  }
  for (const row of Object.values(out)) {
    const settled = row.delivered + row.rto + row.returned;
    row.rtoRate = settled ? row.rto / settled : null;
    row.returnRate = settled ? row.returned / settled : null;
  }
  return out;
}

/**
 * Stock: what is on hand and what it is worth, and the slow pieces ranked by a slowness score (0-100,
 * no cut-off): how long since the style last sold (half), how little of it sold in the last 60 days
 * (three tenths), and how long it has been on the rail (a fifth).
 */
export async function stockReport({ tenantId, now = new Date(), limit = 60 }) {
  const levels = await StockLevel.find({ tenantId, onHand: trusted({ $gt: 0 }) }).lean();
  const skus = await Sku.find({ tenantId, _id: trusted({ $in: levels.map((level) => level.skuId) }) }, { code: 1, size: 1, styleId: 1, pricePaise: 1 }).lean();
  const skuById = new Map(skus.map((sku) => [String(sku._id), sku]));
  const styles = await Style.find({ tenantId, _id: trusted({ $in: [...new Set(skus.map((sku) => String(sku.styleId)))] }) }, { code: 1, name: 1, category: 1, costPaise: 1, pricePaise: 1, liveAt: 1, createdAt: 1, status: 1 }).lean();
  const styleById = new Map(styles.map((style) => [String(style._id), style]));
  const locations = await Location.find({ tenantId }, { code: 1, name: 1 }).lean();
  const locationName = new Map(locations.map((location) => [String(location._id), location.name || location.code]));

  const value = { pieces: 0, atPricePaise: 0, atCostPaise: 0, costedPieces: 0, styles: 0 };
  const byLocation = new Map();
  const byCategory = new Map();
  const perStyle = new Map();
  for (const level of levels) {
    const sku = skuById.get(String(level.skuId));
    const style = sku && styleById.get(String(sku.styleId));
    if (!sku || !style) continue;
    const atPrice = sku.pricePaise * level.onHand;
    const atCost = (style.costPaise || 0) * level.onHand;
    value.pieces += level.onHand;
    value.atPricePaise += atPrice;
    value.atCostPaise += atCost;
    if (style.costPaise) value.costedPieces += level.onHand;
    bump(byLocation, locationName.get(String(level.locationId)) || "Unknown", { pieces: level.onHand, atPricePaise: atPrice, atCostPaise: atCost });
    bump(byCategory, style.category || "unknown", { pieces: level.onHand, atPricePaise: atPrice, atCostPaise: atCost });
    const row = perStyle.get(String(style._id)) || { style, onHand: 0, atPricePaise: 0, sizes: new Map() };
    row.onHand += level.onHand;
    row.atPricePaise += atPrice;
    row.sizes.set(sku.size, (row.sizes.get(sku.size) || 0) + level.onHand);
    perStyle.set(String(style._id), row);
  }
  value.styles = perStyle.size;

  // Sales and arrivals of these styles from the ledger.
  const styleSkus = await Sku.find({ tenantId, styleId: trusted({ $in: [...perStyle.keys()].map((key) => new mongoose.Types.ObjectId(key)) }) }, { styleId: 1 }).lean();
  const styleOfSku = new Map(styleSkus.map((sku) => [String(sku._id), String(sku.styleId)]));
  const moves = await StockMove.aggregate([
    { $match: { tenantId, skuId: trusted({ $in: styleSkus.map((sku) => sku._id) }), kind: trusted({ $in: ["sale", "return", "receive"] }) } },
    {
      $group: {
        _id: { skuId: "$skuId", kind: "$kind" },
        last: { $max: "$at" },
        first: { $min: "$at" },
        recent: { $sum: { $cond: [{ $gte: ["$at", new Date(now.getTime() - 60 * DAY)] }, "$qty", 0] } },
      },
    },
  ]);
  const ledger = new Map();
  for (const move of moves) {
    const styleId = styleOfSku.get(String(move._id.skuId));
    if (!styleId) continue;
    const row = ledger.get(styleId) || { lastSale: null, firstReceive: null, sold60: 0 };
    if (move._id.kind === "sale") {
      row.lastSale = !row.lastSale || move.last > row.lastSale ? move.last : row.lastSale;
      row.sold60 += -move.recent;
    } else if (move._id.kind === "return") row.sold60 -= move.recent;
    else row.firstReceive = !row.firstReceive || move.first < row.firstReceive ? move.first : row.firstReceive;
    ledger.set(styleId, row);
  }

  const daysBetween = (date) => Math.max(0, Math.floor((now - new Date(date)) / DAY));
  const slow = [...perStyle.entries()].map(([styleId, row]) => {
    const { style } = row;
    const moves = ledger.get(styleId) || { lastSale: null, firstReceive: null, sold60: 0 };
    const arrived = style.liveAt || moves.firstReceive || style.createdAt || now;
    const daysOnRail = daysBetween(arrived);
    const daysSinceSale = moves.lastSale ? daysBetween(moves.lastSale) : daysOnRail;
    const sold60 = Math.max(0, moves.sold60);
    const sellThrough = sold60 + row.onHand > 0 ? sold60 / (sold60 + row.onHand) : 0;
    const score = Math.round(100 * (0.5 * Math.min(1, daysSinceSale / 90) + 0.3 * (1 - sellThrough) + 0.2 * Math.min(1, daysOnRail / 120)));
    const pace = sold60 / 60; // pieces a day
    const why = [
      moves.lastSale ? `last sold ${daysSinceSale} day${daysSinceSale === 1 ? "" : "s"} ago` : `not sold since it arrived ${daysOnRail} day${daysOnRail === 1 ? "" : "s"} ago`,
      `${sold60} sold in 60 days (${Math.round(sellThrough * 100)}% sell-through)`,
      `${daysOnRail} days on the rail`,
    ];
    return {
      styleCode: style.code,
      name: style.name,
      category: style.category,
      status: style.status,
      onHand: row.onHand,
      sizes: Object.fromEntries(row.sizes),
      atPricePaise: row.atPricePaise,
      atCostPaise: (style.costPaise || 0) * row.onHand,
      daysOnRail,
      daysSinceSale,
      lastSoldAt: moves.lastSale,
      sold60,
      sellThrough,
      daysOfCover: pace > 0 ? Math.round(row.onHand / pace) : null,
      score,
      why,
    };
  });
  slow.sort((a, b) => b.score - a.score || b.atPricePaise - a.atPricePaise);

  return {
    asOf: now,
    value,
    byLocation: rows(byLocation, "location").sort((a, b) => b.atPricePaise - a.atPricePaise),
    byCategory: rows(byCategory, "category").sort((a, b) => b.atPricePaise - a.atPricePaise),
    slow: slow.slice(0, limit),
  };
}

// B2C (Large): an inter-state invoice to an unregistered buyer above Rs 1 lakh is listed one by one
// in GSTR-1; everything else is summed by state and rate (B2C small).
const B2CL_ABOVE_PAISE = 1_00_000_00;

/**
 * The month's GST summary in the shape of GSTR-1 for B2C sales: B2C small by place of supply and rate
 * (credit notes netted in), B2C large invoices, the HSN summary, and the documents issued per series.
 * For the CA to file from; not filed by the app.
 */
export async function gstReport({ tenantId, month }) {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month || "")) throw httpError(400, "Month must be YYYY-MM", "BAD_MONTH");
  const [year, mon] = month.split("-").map(Number);
  const start = istStart(`${month}-01`);
  const end = istStart(mon === 12 ? `${year + 1}-01-01` : `${year}-${String(mon + 1).padStart(2, "0")}-01`);
  const invoices = await Invoice.find({ tenantId, date: trusted({ $gte: start, $lt: end }) }).sort({ number: 1 }).lean();
  const originals = await Invoice.find({ tenantId, _id: trusted({ $in: invoices.filter((invoice) => invoice.againstInvoiceId).map((invoice) => invoice.againstInvoiceId) }) }, { number: 1, date: 1, totals: 1, interState: 1 }).lean();
  const originalById = new Map(originals.map((invoice) => [String(invoice._id), invoice]));
  const isLarge = (invoice) => invoice.interState && invoice.totals.totalPaise > B2CL_ABOVE_PAISE;

  const b2cs = new Map();
  const b2cl = [];
  const cdnur = [];
  const hsn = new Map();
  const series = new Map();
  const totals = { taxablePaise: 0, cgstPaise: 0, sgstPaise: 0, igstPaise: 0, totalPaise: 0 };

  for (const invoice of invoices) {
    const sign = invoice.kind === "invoice" ? 1 : -1;
    const original = invoice.againstInvoiceId ? originalById.get(String(invoice.againstInvoiceId)) : null;
    const large = sign > 0 ? isLarge(invoice) : Boolean(original && isLarge(original));
    for (const field of Object.keys(totals)) totals[field] += sign * invoice.totals[field];
    if (large) {
      const entry = { number: invoice.number, date: invoice.date, placeOfSupply: invoice.placeOfSupply, ...invoice.totals, rates: [...new Set(invoice.lines.map((line) => line.rate))] };
      if (sign > 0) b2cl.push(entry);
      else cdnur.push({ ...entry, against: original?.number || "" });
    } else {
      for (const line of invoice.lines) {
        const key = `${invoice.placeOfSupply.stateCode}|${line.rate}`;
        const row = bump(b2cs, key, { taxablePaise: sign * line.taxablePaise, cgstPaise: sign * line.cgstPaise, sgstPaise: sign * line.sgstPaise, igstPaise: sign * line.igstPaise });
        row.stateCode = invoice.placeOfSupply.stateCode;
        row.state = invoice.placeOfSupply.state;
        row.rate = line.rate;
        row.interState = invoice.interState;
      }
    }
    for (const line of invoice.lines) {
      const row = bump(hsn, `${line.hsn}|${line.rate}`, { qty: sign * line.qty, taxablePaise: sign * line.taxablePaise, cgstPaise: sign * line.cgstPaise, sgstPaise: sign * line.sgstPaise, igstPaise: sign * line.igstPaise, totalPaise: sign * line.totalPaise });
      row.hsn = line.hsn;
      row.rate = line.rate;
    }
    const prefix = invoice.number.slice(0, invoice.number.lastIndexOf("/"));
    const serial = Number(invoice.number.slice(invoice.number.lastIndexOf("/") + 1));
    const doc = series.get(prefix) || { series: prefix, kind: invoice.kind, from: invoice.number, to: invoice.number, low: serial, high: serial, count: 0 };
    if (serial < doc.low) (doc.low = serial), (doc.from = invoice.number);
    if (serial > doc.high) (doc.high = serial), (doc.to = invoice.number);
    doc.count += 1;
    series.set(prefix, doc);
  }

  const clean = (list) => list.map(({ low, high, ...doc }) => ({ ...doc, missing: high - low + 1 - doc.count }));
  return {
    month,
    totals,
    invoices: invoices.filter((invoice) => invoice.kind === "invoice").length,
    creditNotes: invoices.filter((invoice) => invoice.kind === "credit_note").length,
    b2cs: [...b2cs.values()].sort((a, b) => a.stateCode.localeCompare(b.stateCode) || a.rate - b.rate),
    b2cl,
    cdnur,
    hsn: [...hsn.values()].sort((a, b) => a.hsn.localeCompare(b.hsn) || a.rate - b.rate),
    documents: clean([...series.values()]).sort((a, b) => a.series.localeCompare(b.series)),
  };
}
