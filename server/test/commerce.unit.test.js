import test from "node:test";
import assert from "node:assert/strict";
import { financialYear, invoiceNumber, rateForPiece, splitLine, taxableFrom } from "../src/commerce/gst.js";
import { findPincode, stateForAddress } from "../src/commerce/pincode.js";
import { addressQuality, codBand, codRiskScore } from "../src/commerce/codRisk.js";
import { sortSizes } from "../src/commerce/catalog.js";
import { metaItem } from "../src/commerce/metaCatalog.js";

test("GST on clothing: 5% up to Rs 2,500 a piece before tax, 18% above", () => {
  assert.equal(rateForPiece(199900), 5);
  // Rs 2,625 inclusive is exactly Rs 2,500 before 5% tax: still 5%.
  assert.equal(rateForPiece(262500), 5);
  assert.equal(rateForPiece(262600), 18);
  assert.equal(rateForPiece(450000), 18);
  assert.equal(taxableFrom(105000, 5), 100000);
});

test("a line's tax splits into CGST + SGST that add back to the paisa, or IGST", () => {
  const intra = splitLine({ unitPaise: 199900, qty: 3, rate: 5, interState: false });
  assert.equal(intra.totalPaise, 599700);
  assert.equal(intra.taxablePaise + intra.cgstPaise + intra.sgstPaise, 599700);
  assert.ok(Math.abs(intra.cgstPaise - intra.sgstPaise) <= 1);
  const inter = splitLine({ unitPaise: 199900, qty: 3, rate: 5, interState: true });
  assert.equal(inter.cgstPaise + inter.sgstPaise, 0);
  assert.equal(inter.taxablePaise + inter.igstPaise, 599700);
});

test("financial year runs April-March in India time; invoice numbers fit 16 characters", () => {
  assert.equal(financialYear(new Date("2026-11-23T10:00:00Z")), "2026-27");
  assert.equal(financialYear(new Date("2027-03-31T18:00:00Z")), "2026-27"); // 23:30 IST, 31 March
  assert.equal(financialYear(new Date("2027-03-31T18:31:00Z")), "2027-28"); // 00:01 IST, 1 April
  assert.equal(invoiceNumber("IN1", "2026-27", 42), "IN1/2627/00042");
  assert.ok(invoiceNumber("ST1C", "2026-27", 99999).length <= 16);
  assert.throws(() => invoiceNumber("TOOLONG", "2026-27", 1234567));
});

test("pincodes are found in typed addresses and mapped to the GST state", () => {
  assert.equal(findPincode("Flat 4, Vijay Nagar, Indore 452010"), "452010");
  assert.equal(findPincode("call 9876543210 Indore"), "");
  const indore = stateForAddress({ pincode: "452010", text: "Indore" });
  assert.equal(indore.stateCode, "23");
  assert.equal(indore.sure, true);
  assert.equal(stateForAddress({ pincode: "400001", text: "Mumbai" }).stateCode, "27");
  assert.equal(stateForAddress({ pincode: "403001", text: "Panaji" }).stateCode, "30");
  // 39 is shared by Gujarat and Daman: unsure unless the address names the state.
  assert.equal(stateForAddress({ pincode: "396001", text: "Valsad" }).sure, false);
  assert.equal(stateForAddress({ pincode: "396001", text: "Valsad, Gujarat" }).stateCode, "24");
});

test("COD risk is a graded score with reasons, banded by the owner's settings", () => {
  const good = codRiskScore({ history: { delivered: 3, refused: 0 }, pincode: { delivered: 40, rto: 2 }, order: { valuePaise: 149900, pieces: 1, address: "Flat 12, Shanti Apartment, Vijay Nagar main road, near C21 mall, Indore 452010", at: new Date("2026-11-23T08:00:00Z") } });
  const risky = codRiskScore({ history: { delivered: 0, refused: 2 }, pincode: { delivered: 10, rto: 10 }, order: { valuePaise: 600000, pieces: 5, address: "Indore 452010", at: new Date("2026-11-23T20:00:00Z") } });
  assert.ok(good.score < risky.score);
  assert.equal(codBand(good.score), "low");
  assert.equal(codBand(risky.score), "high");
  assert.ok(risky.reasons.some((reason) => reason.includes("refused 2 of 2")));
  assert.ok(addressQuality("Indore 452010") < addressQuality("Flat 12, Shanti Apartment, Vijay Nagar main road, near C21 mall, Indore 452010"));
  assert.equal(codBand(0.5, { lowBelow: 0.55, highFrom: 0.8 }), "low");
});

test("sizes sort the way a rack does; Meta items carry our SKU code, price and stock", () => {
  assert.deepEqual(sortSizes(["XL", "S", "FREE", "M", "XS", "L", "3XL"]), ["XS", "S", "M", "L", "XL", "3XL", "FREE"]);
  assert.deepEqual(sortSizes(["32", "28", "30"]), ["28", "30", "32"]);
  const style = { code: "DRS-001", name: "Linen midi dress", status: "live", attributes: { colour: "Sage" }, images: ["https://img.test/1.jpg", "https://img.test/2.jpg"] };
  const item = metaItem({ sku: { code: "DRS-001-M", size: "M", pricePaise: 199900 }, style, available: 3, storeUrl: "https://store.test" });
  assert.equal(item.id, "DRS-001-M");
  assert.equal(item.item_group_id, "DRS-001");
  assert.equal(item.price, "1999.00 INR");
  assert.equal(item.availability, "in stock");
  assert.equal(item.inventory, 3);
  assert.equal(metaItem({ sku: { code: "DRS-001-M", size: "M", pricePaise: 199900 }, style: { ...style, status: "archived" }, available: 3 }).availability, "out of stock");
});
