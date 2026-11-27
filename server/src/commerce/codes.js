import mongoose from "mongoose";
import { Style } from "../models/index.js";

// Style codes by category, so a code tells staff what the piece is: DRS-015 is the 15th dress.
// A size is then STYLE-SIZE (DRS-015-M), which is the code on the price tag's barcode.

export const CODE_PREFIX = {
  dresses: "DRS", tops: "TOP", shirts: "SHT", "t-shirts": "TEE", jeans: "JNS", trousers: "BTM", shorts: "SHO",
  skirts: "SKT", "co-ords": "COR", jumpsuits: "JMP", jackets: "JKT", cardigans: "CRD", shrugs: "SHR",
  knitwear: "KNT", accessories: "ACC", other: "OTH",
};

/** The prefix for a category: the table above, else its first three letters. */
export function codePrefix(category) {
  const key = String(category || "").trim().toLowerCase();
  if (CODE_PREFIX[key]) return CODE_PREFIX[key];
  const letters = key.replace(/[^a-z]/g, "").slice(0, 3).toUpperCase();
  return letters.length === 3 ? letters : "OTH";
}

/** The next free code in a category: one more than the highest number used with that prefix. */
export async function nextStyleCode({ tenantId, category }) {
  const prefix = codePrefix(category);
  const used = await Style.find({ tenantId, code: mongoose.trusted({ $regex: `^${prefix}-\\d+$` }) }, { code: 1 }).lean();
  const highest = used.reduce((max, style) => Math.max(max, Number(style.code.slice(prefix.length + 1)) || 0), 0);
  return `${prefix}-${String(highest + 1).padStart(3, "0")}`;
}
