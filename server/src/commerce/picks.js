import mongoose from "mongoose";
import { Contact, Location, Order, Sku, StockLevel, Style, getSettings } from "../models/index.js";
import { SIZE_ORDER } from "./catalog.js";

// Outfit picks: for the pieces a customer is trying (in the website's fitting room or the store's
// trial room), every other live piece gets a score out of 100 from six graded parts, and the best
// ones that are in stock in her size come first. Nothing is a hard yes or no, except that a piece
// with no size left at that location cannot be offered. The owner sets the weights in Settings.

export const PARTS = [
  { key: "size", name: "Her size in stock" },
  { key: "pair", name: "Styled together by the staff" },
  { key: "colour", name: "Colours work together" },
  { key: "occasion", name: "Same occasion" },
  { key: "taste", name: "Her taste and budget" },
  { key: "push", name: "Shop's push (new or slow stock)" },
];
export const DEFAULT_WEIGHTS = { size: 30, pair: 20, colour: 15, occasion: 15, taste: 10, push: 10 };

const DAY_MS = 24 * 60 * 60 * 1000;
const BOUGHT_STATUSES = ["confirmed", "packed", "shipped", "delivered"];

// ---- Outfit parts -----------------------------------------------------------------------------
const PART_WORDS = [
  ["dress", /\b(dress|dresses|gown|jumpsuit|playsuit|romper|co-?ords?|sets?|maxi|midi dress)\b/],
  ["layer", /\b(jackets?|blazers?|shrugs?|cardigans?|coats?|kimonos?|overshirts?|waistcoats?)\b/],
  ["bottom", /\b(jeans|trousers|pants|skirts?|shorts|culottes|palazzos?|joggers|leggings)\b/],
  ["top", /\b(tops?|shirts?|tees?|t-shirts?|blouses?|tanks?|camis?|crop tops?|kurtis?|tunics?|bodysuits?|sweaters?)\b/],
];
/** The part of a look a style is: its own setting, else worked out from its category and name. */
export function outfitPart(style) {
  if (style.outfitPart) return style.outfitPart;
  const words = `${style.category || ""} ${style.name || ""}`.toLowerCase();
  return PART_WORDS.find(([, pattern]) => pattern.test(words))?.[0] || "other";
}

// ---- Colours ----------------------------------------------------------------------------------
// Colour names are free text, so they are read by their words. Neutrals go with anything.
const FAMILY_WORDS = [
  ["neutral", /\b(black|white|ivory|cream|off-?white|beige|nude|taupe|grey|gray|charcoal|navy|denim|light wash|mid wash|dark wash|mid blue|brown|cocoa|chocolate|tan|camel|khaki|sand|stone|champagne|gold|silver|ecru|oatmeal)\b/],
  ["red", /\b(red|maroon|wine|burgundy|cherry|crimson|oxblood)\b/],
  ["pink", /\b(pink|blush|rose|fuchsia|magenta|dusty rose|baby pink)\b/],
  ["orange", /\b(orange|rust|terracotta|peach|coral|apricot|tangerine)\b/],
  ["yellow", /\b(yellow|mustard|lemon|butter)\b/],
  ["green", /\b(green|sage|olive|emerald|mint|bottle green|forest|lime|pistachio)\b/],
  ["blue", /\b(blue|cobalt|indigo|powder blue|teal|turquoise|aqua|sky)\b/],
  ["purple", /\b(purple|lavender|lilac|plum|violet|mauve)\b/],
];
export function colourFamily(colour) {
  const words = String(colour || "").toLowerCase();
  if (!words.trim()) return "";
  return FAMILY_WORDS.find(([, pattern]) => pattern.test(words))?.[0] || "";
}
const GOOD_PAIRS = {
  "green|pink": 0.9, "blue|orange": 0.85, "pink|red": 0.75, "blue|pink": 0.7, "purple|yellow": 0.7, "blue|yellow": 0.65, "blue|green": 0.6,
  "green|orange": 0.55, "orange|pink": 0.55, "blue|purple": 0.6, "pink|purple": 0.6, "blue|red": 0.5, "orange|red": 0.4, "green|red": 0.35,
};
/** 0-1: how well two colours sit together. Unknown colours are a middling 0.6, not a guess. */
export function colourMatch(a, b) {
  const x = colourFamily(a);
  const y = colourFamily(b);
  if (!x || !y) return 0.6;
  if (x === "neutral" || y === "neutral") return String(a).toLowerCase() === String(b).toLowerCase() ? 0.7 : 1;
  if (x === y) return 0.7;
  return GOOD_PAIRS[[x, y].sort().join("|")] ?? 0.45;
}

// ---- Sizes ------------------------------------------------------------------------------------
const isNumeric = (size) => /^\d+$/.test(size);
export function orderSizes(sizes) {
  return [...sizes].sort((a, b) => {
    if (isNumeric(a) && isNumeric(b)) return Number(a) - Number(b);
    const ia = SIZE_ORDER.indexOf(a);
    const ib = SIZE_ORDER.indexOf(b);
    return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib);
  });
}

/**
 * Which size to offer her in this piece and how many are left. `stock` maps size -> available.
 * Her letter size (S, M...) or waist (28, 30...) comes from the customer profile; a piece that runs
 * small offers one size up, one that runs large one down. If that size is gone, the nearest one left.
 */
export function bestSize({ sizes, stock, sizing, letter, waist }) {
  const list = orderSizes(sizes);
  if (!list.length) return null;
  if (list.length === 1) {
    const only = list[0];
    return stock[only] > 0 ? { size: only, left: stock[only], note: only === "FREE" ? "free size" : "", exact: true } : null;
  }
  const numeric = isNumeric(list[0]);
  const base = numeric ? waist : letter;
  if (!base) {
    // No size known: the size with the most pieces, so staff can still bring something.
    const best = list.filter((size) => stock[size] > 0).sort((a, b) => stock[b] - stock[a])[0];
    return best ? { size: best, left: stock[best], note: "her size is not known yet", exact: false, unknown: true } : null;
  }
  let index = list.indexOf(base);
  if (index < 0) {
    // Her size is not made in this style: the nearest one up.
    const rank = (size) => (numeric ? Number(size) : SIZE_ORDER.indexOf(size));
    index = list.findIndex((size) => rank(size) >= rank(base));
    if (index < 0) index = list.length - 1;
  }
  let note = "";
  if (!numeric && sizing === "runs_small" && list[index + 1]) { index += 1; note = "runs small, so one size up"; }
  if (!numeric && sizing === "runs_large" && index > 0) { index -= 1; note = "runs large, so one size down"; }
  const want = list[index];
  if (stock[want] > 0) return { size: want, left: stock[want], note, exact: true };
  const near = [list[index + 1], list[index - 1]].find((size) => size && stock[size] > 0);
  return near ? { size: near, left: stock[near], note: `${want} is sold out here`, exact: false } : null;
}

// ---- Scoring ----------------------------------------------------------------------------------
const rupees = (paise) => `₹${Math.round(paise / 100).toLocaleString("en-IN")}`;
const lower = (text) => String(text || "").toLowerCase();

/**
 * Scores one candidate against the pieces on her (`others`: those it would be worn with). Pure: all
 * data comes in. Returns null when no size can be offered.
 */
export function scoreCandidate({ candidate, others, customer, weights, settings, now }) {
  const fit = bestSize({ sizes: candidate.sizes, stock: candidate.stock, sizing: candidate.sizing, letter: customer.letter, waist: customer.waist });
  if (!fit) return null;
  const parts = {};
  const why = {};

  parts.size = fit.unknown ? 0.5 : fit.exact ? (fit.left >= 2 ? 1 : 0.75) : 0.4;
  why.size = fit.unknown
    ? `Her size is not known: ${fit.size} has the most (${fit.left})`
    : fit.exact
      ? `Size ${fit.size} in stock${fit.left <= 2 ? ` (${fit.left} left)` : ""}${fit.note ? `: ${fit.note}` : ""}`
      : `${fit.note}; ${fit.size} has ${fit.left}`;

  const paired = others.find((other) => other.pairsWith.includes(candidate.code) || candidate.pairsWith.includes(other.code));
  parts.pair = paired ? 1 : 0;
  why.pair = paired ? `Staff pair it with the ${lower(paired.name)}` : "Not one of the staff's pairings";

  if (others.length) {
    const matches = others.map((other) => colourMatch(candidate.colour, other.colour));
    parts.colour = matches.reduce((sum, value) => sum + value, 0) / matches.length;
    const family = colourFamily(candidate.colour);
    why.colour = !candidate.colour
      ? "No colour set on this piece"
      : family === "neutral"
        ? `${candidate.colour} goes with anything`
        : parts.colour >= 0.75
          ? `${candidate.colour} works with ${others.map((other) => lower(other.colour) || "the rest").join(" and ")}`
          : `${candidate.colour} is a bolder mix with ${lower(others[0].colour) || "the rest"}`;
    const theirs = new Set(others.flatMap((other) => other.occasions));
    if (!candidate.occasions.length || !theirs.size) {
      parts.occasion = 0.5;
      why.occasion = "Occasions not set on these pieces";
    } else {
      const shared = candidate.occasions.filter((occasion) => theirs.has(occasion));
      parts.occasion = shared.length / candidate.occasions.length;
      why.occasion = shared.length ? `Same occasion: ${shared.join(", ")}` : "A different occasion from the rest";
    }
  } else {
    parts.colour = 0.6;
    parts.occasion = 0.5;
    why.colour = why.occasion = "Nothing on her yet to match";
  }

  if (customer.returned.includes(candidate.code)) {
    parts.taste = 0;
    why.taste = "She returned this before";
  } else if (customer.band) {
    const inBand = candidate.pricePaise >= customer.band[0] && candidate.pricePaise <= customer.band[1];
    const likes = candidate.colour && customer.colours.includes(lower(candidate.colour));
    parts.taste = (inBand ? 0.6 : 0.2) + (likes ? 0.4 : 0);
    why.taste = [inBand ? `In her usual ${rupees(customer.band[0])}–${rupees(customer.band[1])}` : `Outside her usual ${rupees(customer.band[0])}–${rupees(customer.band[1])}`, likes ? `she has bought ${lower(candidate.colour)} before` : ""].filter(Boolean).join("; ");
  } else {
    parts.taste = 0.5;
    why.taste = "No order history yet";
  }

  const days = Math.max(0, Math.floor((now - candidate.since) / DAY_MS));
  parts.push = days <= settings.newDays ? 0.8 : days >= settings.slowDays ? 1 : 0.3;
  why.push = days <= settings.newDays ? `New (${days} days on the rail)` : days >= settings.slowDays ? `On the rail ${days} days: the shop wants it moving` : `On the rail ${days} days`;

  for (const key of Object.keys(parts)) parts[key] = Math.round(parts[key] * 100) / 100;
  const totalWeight = PARTS.reduce((sum, part) => sum + weights[part.key], 0) || 1;
  const score = Math.round((PARTS.reduce((sum, part) => sum + weights[part.key] * parts[part.key], 0) / totalWeight) * 100);
  return { fit, parts, why, score };
}

/**
 * Ranks every candidate for the pieces she is trying. Parts of the look she has not got yet come
 * first ("complete"), then other pieces for a part she has ("swap"). Pure.
 */
export function rankPicks({ trying, candidates, customer, weights, settings, now = new Date(), limit = 6 }) {
  const parts = new Set(trying.map((piece) => piece.part));
  const hasDress = parts.has("dress");
  const open = (hasDress ? ["layer"] : ["top", "bottom", "layer"]).filter((part) => !parts.has(part));
  const tryingCodes = new Set(trying.map((piece) => piece.code));
  const rows = [];
  for (const candidate of candidates) {
    if (tryingCodes.has(candidate.code) || customer.bought.includes(candidate.code) || candidate.part === "other") continue;
    // A dress is not a pick for a top and bottom she is trying, nor a top or bottom for a dress.
    if (hasDress && (candidate.part === "top" || candidate.part === "bottom")) continue;
    if (!hasDress && trying.length && candidate.part === "dress") continue;
    const others = trying.filter((piece) => piece.part !== candidate.part);
    const scored = scoreCandidate({ candidate, others, customer, weights, settings, now });
    if (!scored) continue;
    rows.push({ candidate, kind: open.includes(candidate.part) ? "complete" : "swap", ...scored });
  }
  rows.sort((a, b) => (a.kind === b.kind ? b.score - a.score : a.kind === "complete" ? -1 : 1));
  const complete = rows.filter((row) => row.kind === "complete").slice(0, limit);
  const swap = rows.filter((row) => row.kind === "swap").slice(0, limit);
  return { complete, swap, considered: rows.length };
}

// ---- Loading from the database -----------------------------------------------------------------
const mostCommon = (values) => {
  const counts = new Map();
  for (const value of values) counts.set(value, (counts.get(value) || 0) + 1);
  return [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || "";
};

/** The customer's WhatsApp id from a phone number as staff type it (10 digits means India). */
export function waIdFromPhone(phone) {
  const digits = String(phone || "").replace(/\D/g, "");
  if (/^[6-9]\d{9}$/.test(digits)) return `91${digits}`;
  if (/^0[6-9]\d{9}$/.test(digits)) return `91${digits.slice(1)}`;
  if (/^\d{11,15}$/.test(digits)) return digits;
  return "";
}

/**
 * What the picks know about a customer: her sizes, what she bought and returned, her usual spend
 * and colours. From her contact record and her orders (WhatsApp orders by contact, store sales by phone).
 */
export async function customerProfile({ tenantId, contact, waId, letter = "", waist = "" }) {
  const phones = waId ? [waId, waId.replace(/^91/, "")] : [];
  const or = [];
  if (contact?._id) or.push({ contactId: contact._id });
  if (phones.length) or.push({ "customer.phone": mongoose.trusted({ $in: phones }) });
  const orders = or.length ? await Order.find({ tenantId, $or: or }).sort({ createdAt: -1 }).limit(50).lean() : [];
  const kept = orders.filter((order) => BOUGHT_STATUSES.includes(order.status));
  // Pieces she kept, and the styles she sent back (whole orders or one piece of one).
  const keptLines = kept.flatMap((order) => order.lines.filter((line) => line.qty > (line.returnedQty || 0)));
  const returnedLines = orders.flatMap((order) => order.lines.filter((line) => order.status === "returned" || (line.returnedQty || 0) > 0));
  const styleCodes = [...new Set(keptLines.map((line) => line.styleCode))];
  const styles = styleCodes.length ? await Style.find({ tenantId, code: mongoose.trusted({ $in: styleCodes }) }).lean() : [];
  const prices = keptLines.map((line) => line.unitPaise).sort((a, b) => a - b);
  const sizes = keptLines.map((line) => line.size);
  return {
    name: contact?.name || contact?.profileName || "",
    letter: letter || contact?.fit?.usualSize || mostCommon(sizes.filter((size) => !isNumeric(size) && size !== "FREE")),
    waist: waist || contact?.fit?.waist || mostCommon(sizes.filter(isNumeric)),
    bought: styleCodes,
    returned: [...new Set(returnedLines.map((line) => line.styleCode))],
    // Her usual spend: from her cheapest to her dearest piece, with a little room either side.
    band: prices.length >= 2 ? [Math.round((prices[0] * 0.85) / 10000) * 10000, Math.round((prices.at(-1) * 1.15) / 10000) * 10000] : null,
    colours: [...new Set(styles.map((style) => lower(style.attributes?.colour)).filter(Boolean))],
    orders: kept.length,
    history: kept.slice(0, 5).map((order) => ({ number: order.number, at: order.createdAt, lines: order.lines.map((line) => `${line.name} (${line.size})`), channel: order.channel })),
  };
}

const asPiece = (style) => ({
  code: style.code,
  name: style.name,
  part: outfitPart(style),
  colour: style.attributes?.colour || "",
  occasions: (style.attributes?.occasion || []).map(lower),
  pairsWith: (style.pairsWith || []).map((code) => String(code).toUpperCase()),
  sizing: style.sizing || "true",
  pricePaise: style.pricePaise,
  image: style.images?.[0] || "",
  since: new Date(style.liveAt || style.createdAt || Date.now()),
});

/** Live styles with their sizes and what is available at one location. */
export async function loadCandidates({ tenantId, locationId }) {
  const styles = await Style.find({ tenantId, status: "live" }).lean();
  const skus = await Sku.find({ tenantId, styleId: mongoose.trusted({ $in: styles.map((style) => style._id) }) }).lean();
  const levels = await StockLevel.find({ tenantId, locationId, skuId: mongoose.trusted({ $in: skus.map((sku) => sku._id) }) }).lean();
  const availableBySku = new Map(levels.map((level) => [String(level.skuId), level.available]));
  const skusByStyle = new Map();
  for (const sku of skus) {
    const key = String(sku.styleId);
    if (!skusByStyle.has(key)) skusByStyle.set(key, []);
    skusByStyle.get(key).push(sku);
  }
  return styles.map((style) => {
    const own = skusByStyle.get(String(style._id)) || [];
    return {
      ...asPiece(style),
      sizes: own.map((sku) => sku.size),
      stock: Object.fromEntries(own.map((sku) => [sku.size, availableBySku.get(String(sku._id)) || 0])),
      skuBySize: Object.fromEntries(own.map((sku) => [sku.size, sku.code])),
    };
  });
}

/** Where the picks look for stock: a store's own floor, or the online stock room. */
export async function pickLocation({ tenantId, code }) {
  const settings = await getSettings(tenantId);
  const wanted = String(code || settings.onlineLocationCode || "").toUpperCase();
  const location = wanted ? await Location.findOne({ tenantId, code: wanted }) : null;
  if (!location) throw Object.assign(new Error(wanted ? `No location ${wanted}` : "Set the online stock location in Settings first"), { status: 404 });
  return { location, settings };
}

const weightsFrom = (settings) => ({ ...DEFAULT_WEIGHTS, ...Object.fromEntries(Object.keys(DEFAULT_WEIGHTS).map((key) => [key, settings?.picks?.weights?.[key] ?? DEFAULT_WEIGHTS[key]])) });

/**
 * Picks for the pieces she is trying (style codes or size codes, as scanned), at a location.
 * `phone` finds her history; `letter` / `waist` override the sizes on file.
 */
export async function picksFor({ tenantId, pieces, phone = "", letter = "", waist = "", locationCode = "", limit = 6, now = new Date() }) {
  const { location, settings } = await pickLocation({ tenantId, code: locationCode });
  const codes = pieces.map((code) => String(code).toUpperCase());
  const skus = codes.length ? await Sku.find({ tenantId, code: mongoose.trusted({ $in: codes }) }).lean() : [];
  const styleCodes = [...new Set(codes.map((code) => skus.find((sku) => sku.code === code)?.styleCode || code))];
  const tryingStyles = styleCodes.length ? await Style.find({ tenantId, code: mongoose.trusted({ $in: styleCodes }) }).lean() : [];
  const unknown = styleCodes.filter((code) => !tryingStyles.some((style) => style.code === code));
  if (unknown.length) throw Object.assign(new Error(`Not in the catalogue: ${unknown.join(", ")}`), { status: 404 });
  // One piece per part of the look (the last scanned wins), so two tops do not both count.
  const byPart = new Map();
  for (const code of styleCodes) {
    const piece = asPiece(tryingStyles.find((style) => style.code === code));
    if (piece.part === "dress") { byPart.delete("top"); byPart.delete("bottom"); }
    if (piece.part === "top" || piece.part === "bottom") byPart.delete("dress");
    byPart.set(piece.part, piece);
  }
  const trying = [...byPart.values()];
  const waId = waIdFromPhone(phone);
  const contact = waId ? await Contact.findOne({ tenantId, waId }).lean() : null;
  const customer = await customerProfile({ tenantId, contact, waId, letter: String(letter || "").toUpperCase(), waist: String(waist || "") });
  const candidates = await loadCandidates({ tenantId, locationId: location._id });
  const weights = weightsFrom(settings);
  const ranked = rankPicks({ trying, candidates, customer, weights, settings: { newDays: settings.picks?.newDays ?? 14, slowDays: settings.picks?.slowDays ?? 45 }, now, limit });
  const view = (row) => ({
    styleCode: row.candidate.code,
    name: row.candidate.name,
    part: row.candidate.part,
    kind: row.kind,
    colour: row.candidate.colour,
    image: row.candidate.image,
    pricePaise: row.candidate.pricePaise,
    size: row.fit.size,
    skuCode: row.candidate.skuBySize[row.fit.size],
    left: row.fit.left,
    score: row.score,
    parts: row.parts,
    why: row.why,
  });
  return {
    location: { code: location.code, name: location.name, kind: location.kind },
    trying: trying.map((piece) => ({ styleCode: piece.code, name: piece.name, part: piece.part, colour: piece.colour, image: piece.image })),
    customer: { known: Boolean(contact || customer.orders), waId, contactId: contact?._id || null, name: customer.name, letter: customer.letter, waist: customer.waist, orders: customer.orders, band: customer.band, colours: customer.colours, history: customer.history, returned: customer.returned, offersConsent: Boolean(contact?.consents?.offers?.given) },
    weights,
    parts: PARTS,
    complete: ranked.complete.map(view),
    swap: ranked.swap.map(view),
    considered: ranked.considered,
  };
}

// ---- The WhatsApp message ---------------------------------------------------------------------
/**
 * What goes to her phone: inside WhatsApp's 24-hour window, a product list from the shop's Meta
 * catalogue (she can add to a cart right there); outside it, the owner's approved marketing template.
 */
export function picksMessage({ firstName, anchorName, picks, catalogId, insideWindow, template, brandName = "The Hanger", storeLine = "" }) {
  const greeting = firstName ? `Hi ${firstName}!` : "Hi!";
  const lines = picks.map((pick) => `${pick.name} (${pick.size}) ${rupees(pick.pricePaise)}`);
  if (insideWindow && catalogId) {
    return {
      kind: "products",
      content: {
        purpose: "picks",
        text: `${greeting} ${anchorName ? `These go with the ${lower(anchorName)}. ` : ""}All in your size and in stock today.`.slice(0, 1024),
        products: {
          header: "Picked for you",
          footer: (storeLine || brandName).slice(0, 60),
          catalogId,
          sections: [{ title: "Picked for you", productRetailerIds: picks.map((pick) => pick.skuCode) }],
        },
      },
    };
  }
  if (insideWindow) {
    return { kind: "text", content: { purpose: "picks", text: `${greeting} ${anchorName ? `These go with the ${lower(anchorName)}` : "Picked for you"}, all in your size and in stock today:\n${lines.map((line) => `• ${line}`).join("\n")}\n\nReply with the ones you'd like and we'll keep them aside.` } };
  }
  if (template?.name) {
    return {
      kind: "template",
      content: {
        purpose: "picks",
        template: {
          name: template.name,
          language: template.language || "en",
          components: [{ type: "body", parameters: [{ type: "text", text: firstName || "there" }, { type: "text", text: anchorName || "your look" }, { type: "text", text: lines.join(", ").slice(0, 900) }] }],
        },
      },
    };
  }
  return null;
}
