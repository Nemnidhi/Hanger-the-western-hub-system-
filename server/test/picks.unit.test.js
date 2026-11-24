import test from "node:test";
import assert from "node:assert/strict";
import { bestSize, colourFamily, colourMatch, outfitPart, picksMessage, rankPicks, waIdFromPhone, DEFAULT_WEIGHTS } from "../src/commerce/picks.js";

// The outfit picks' scoring, without a database.

const now = new Date("2026-11-24T10:00:00Z");
const daysAgo = (days) => new Date(now.getTime() - days * 86_400_000);
const piece = (code, part, extra = {}) => ({ code, name: code, part, colour: "", occasions: [], pairsWith: [], sizing: "true", pricePaise: 150000, since: daysAgo(20), sizes: ["S", "M", "L"], stock: { S: 3, M: 3, L: 3 }, skuBySize: {}, ...extra });
const newCustomer = { letter: "M", waist: "", bought: [], returned: [], band: null, colours: [] };
const settings = { newDays: 14, slowDays: 45 };

test("outfit part comes from the style's own setting, else its category and name", () => {
  assert.equal(outfitPart({ outfitPart: "layer", category: "tops" }), "layer");
  assert.equal(outfitPart({ category: "dresses", name: "Linen midi" }), "dress");
  assert.equal(outfitPart({ category: "jeans" }), "bottom");
  assert.equal(outfitPart({ category: "jackets", name: "Cropped denim jacket" }), "layer");
  assert.equal(outfitPart({ category: "co-ords" }), "dress");
  assert.equal(outfitPart({ category: "tops", name: "Satin wrap top" }), "top");
  assert.equal(outfitPart({ category: "bags" }), "other");
});

test("colours are read by their words; neutrals go with anything; unknown is middling", () => {
  assert.equal(colourFamily("Light wash"), "neutral");
  assert.equal(colourFamily("dusty rose"), "pink");
  assert.equal(colourFamily("emerald green"), "green");
  assert.equal(colourMatch("black", "wine"), 1);
  assert.equal(colourMatch("black", "black"), 0.7);
  assert.equal(colourMatch("emerald", "dusty rose"), 0.9);
  assert.equal(colourMatch("sage", "emerald"), 0.7);
  assert.equal(colourMatch("", "wine"), 0.6);
  assert.equal(colourMatch("sparkle", "wine"), 0.6);
});

test("best size: her size, one up when it runs small, the nearest when hers is gone, waist for jeans", () => {
  const stock = { S: 2, M: 1, L: 0 };
  assert.deepEqual(bestSize({ sizes: ["S", "M", "L"], stock, sizing: "true", letter: "M" }), { size: "M", left: 1, note: "", exact: true });
  const up = bestSize({ sizes: ["S", "M", "L"], stock: { S: 2, M: 1, L: 2 }, sizing: "runs_small", letter: "M" });
  assert.equal(up.size, "L");
  assert.match(up.note, /one size up/);
  const near = bestSize({ sizes: ["S", "M", "L"], stock: { S: 2, M: 0, L: 0 }, sizing: "true", letter: "M" });
  assert.equal(near.size, "S");
  assert.equal(near.exact, false);
  assert.equal(bestSize({ sizes: ["S", "M"], stock: { S: 0, M: 0 }, sizing: "true", letter: "M" }), null);
  assert.equal(bestSize({ sizes: ["26", "28", "30", "32"], stock: { 26: 1, 28: 2, 30: 2, 32: 1 }, sizing: "runs_small", letter: "M", waist: "30" }).size, "30");
  const unknown = bestSize({ sizes: ["S", "M", "L"], stock: { S: 1, M: 4, L: 2 }, sizing: "true", letter: "" });
  assert.equal(unknown.size, "M");
  assert.ok(unknown.unknown);
  assert.equal(bestSize({ sizes: ["FREE"], stock: { FREE: 2 }, sizing: "true", letter: "M" }).size, "FREE");
});

test("ranking: what completes the look comes first; staff pairings, stock and colour move the order", () => {
  const top = piece("TOP-1", "top", { colour: "white", occasions: ["work"], pairsWith: ["JKT-2"] });
  const trousers = piece("BTM-1", "bottom", { colour: "taupe", occasions: ["work"] });
  const candidates = [
    top, trousers,
    piece("JKT-1", "layer", { colour: "wine", occasions: ["party"], stock: { S: 0, M: 1, L: 0 } }),
    piece("JKT-2", "layer", { colour: "ivory", occasions: ["work"] }),
    piece("SKT-1", "bottom", { colour: "emerald", occasions: ["work"] }),
    piece("DRS-1", "dress", { colour: "sage" }),
    piece("GONE-1", "layer", { stock: { S: 0, M: 0, L: 0 } }),
  ];
  const ranked = rankPicks({ trying: [top, trousers], candidates, customer: newCustomer, weights: DEFAULT_WEIGHTS, settings, now });
  assert.deepEqual(ranked.complete.map((row) => row.candidate.code), ["JKT-2", "JKT-1"]);
  assert.deepEqual(ranked.swap.map((row) => row.candidate.code), ["SKT-1"]);
  assert.ok(!ranked.complete.concat(ranked.swap).some((row) => ["DRS-1", "GONE-1", "TOP-1"].includes(row.candidate.code)));
  const blazer = ranked.complete[0];
  assert.equal(blazer.parts.pair, 1);
  assert.match(blazer.why.pair, /top-1/i);
  assert.ok(blazer.score > ranked.complete[1].score);
});

test("her history: bought pieces are left out, returned ones score zero on taste, budget and colours count", () => {
  const dress = piece("DRS-1", "dress", { colour: "wine" });
  const candidates = [dress, piece("JKT-1", "layer", { colour: "black", pricePaise: 250000 }), piece("JKT-2", "layer", { colour: "black", pricePaise: 600000 }), piece("JKT-3", "layer"), piece("JKT-4", "layer")];
  const customer = { letter: "M", waist: "", bought: ["JKT-4"], returned: ["JKT-3"], band: [120000, 300000], colours: ["black"] };
  const ranked = rankPicks({ trying: [dress], candidates, customer, weights: DEFAULT_WEIGHTS, settings, now });
  const byCode = Object.fromEntries(ranked.complete.map((row) => [row.candidate.code, row]));
  assert.equal(byCode["JKT-4"], undefined);
  assert.equal(byCode["JKT-3"].parts.taste, 0);
  assert.equal(byCode["JKT-1"].parts.taste, 1);
  assert.equal(byCode["JKT-2"].parts.taste, 0.6);
  assert.equal(ranked.complete[0].candidate.code, "JKT-1");
});

test("the owner's weights change the order; new and slow pieces get the shop's push", () => {
  const dress = piece("DRS-1", "dress");
  const fresh = piece("JKT-NEW", "layer", { since: daysAgo(3), stock: { S: 1, M: 1, L: 1 } });
  const plenty = piece("JKT-OLD", "layer", { since: daysAgo(25) });
  const run = (weights) => rankPicks({ trying: [dress], candidates: [fresh, plenty], customer: newCustomer, weights, settings, now }).complete.map((row) => row.candidate.code);
  assert.deepEqual(run({ ...DEFAULT_WEIGHTS, push: 0 }), ["JKT-OLD", "JKT-NEW"]);
  assert.deepEqual(run({ ...DEFAULT_WEIGHTS, size: 5, push: 40 }), ["JKT-NEW", "JKT-OLD"]);
  const slow = rankPicks({ trying: [dress], candidates: [piece("JKT-SLOW", "layer", { since: daysAgo(60) })], customer: newCustomer, weights: DEFAULT_WEIGHTS, settings, now }).complete[0];
  assert.equal(slow.parts.push, 1);
  assert.match(slow.why.push, /60 days/);
});

test("phone numbers become WhatsApp ids; the message is a product list, a text or a template", () => {
  assert.equal(waIdFromPhone("98260 12345"), "919826012345");
  assert.equal(waIdFromPhone("+91 98260-12345"), "919826012345");
  assert.equal(waIdFromPhone("09826012345"), "919826012345");
  assert.equal(waIdFromPhone("12345"), "");
  const picks = [{ name: "Linen blazer", size: "M", pricePaise: 349900, skuCode: "JKT-010-M" }];
  const list = picksMessage({ firstName: "Riya", anchorName: "Poplin shirt", picks, catalogId: "999", insideWindow: true });
  assert.equal(list.kind, "products");
  assert.deepEqual(list.content.products.sections[0].productRetailerIds, ["JKT-010-M"]);
  assert.match(list.content.text, /Hi Riya! These go with the poplin shirt/);
  assert.equal(picksMessage({ picks, insideWindow: true }).kind, "text");
  assert.equal(picksMessage({ picks, insideWindow: false }), null);
  const template = picksMessage({ firstName: "Riya", anchorName: "Poplin shirt", picks, insideWindow: false, template: { name: "outfit_picks", language: "en" } });
  assert.equal(template.kind, "template");
  assert.equal(template.content.template.components[0].parameters[2].text, "Linen blazer (M) ₹3,499");
});
