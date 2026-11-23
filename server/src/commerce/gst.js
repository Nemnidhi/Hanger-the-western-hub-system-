// GST on clothing sold to consumers (B2C). Prices are shown to customers GST-inclusive (MRP), so the
// tax is taken out of the price, never added on top.
//
// Rate: clothing is taxed by the sale value of each piece. From 22 Sep 2025 (GST rate rationalisation)
// a piece up to Rs 2,500 is taxed at 5% and above Rs 2,500 at 18%. The slabs live in Settings so the
// owner's CA can change them without a code change if the rates move again.
// Intra-state sale (customer in the store's state): half CGST + half SGST. Inter-state: IGST.

export const DEFAULT_GST_SLABS = Object.freeze([
  { uptoPaise: 250000, rate: 5 },
  { uptoPaise: null, rate: 18 },
]);

/** The value before tax inside a GST-inclusive amount, in whole paise. */
export function taxableFrom(inclusivePaise, rate) {
  return Math.round((inclusivePaise * 100) / (100 + rate));
}

/**
 * The rate for one piece sold at `inclusivePaise` (after any discount). The slab test is on the value
 * before tax: a piece qualifies for a slab when its value at that slab's rate is within the limit.
 */
export function rateForPiece(inclusivePaise, slabs = DEFAULT_GST_SLABS) {
  if (!Number.isInteger(inclusivePaise) || inclusivePaise < 0) throw new Error("A price must be a whole number of paise");
  for (const slab of slabs) {
    if (slab.uptoPaise === null || slab.uptoPaise === undefined) return slab.rate;
    if (taxableFrom(inclusivePaise, slab.rate) <= slab.uptoPaise) return slab.rate;
  }
  throw new Error("GST slabs must end with an open-ended slab");
}

/**
 * The tax split of one invoice line (qty pieces at unitPaise each, GST-inclusive). Rounding is done
 * once per line and the halves always add back to the tax, so the invoice totals agree to the paisa.
 */
export function splitLine({ unitPaise, qty, rate, interState }) {
  const totalPaise = unitPaise * qty;
  const taxablePaise = taxableFrom(totalPaise, rate);
  const taxPaise = totalPaise - taxablePaise;
  if (interState) return { totalPaise, taxablePaise, rate, cgstPaise: 0, sgstPaise: 0, igstPaise: taxPaise };
  const cgstPaise = Math.floor(taxPaise / 2);
  return { totalPaise, taxablePaise, rate, cgstPaise, sgstPaise: taxPaise - cgstPaise, igstPaise: 0 };
}

/** India's financial year (April to March) for a date, in India time: "2026-27". */
export function financialYear(date = new Date()) {
  const ist = new Date(date.getTime() + 330 * 60 * 1000);
  const year = ist.getUTCFullYear();
  const start = ist.getUTCMonth() >= 3 ? year : year - 1;
  return `${start}-${String((start + 1) % 100).padStart(2, "0")}`;
}

/**
 * A GST invoice number: at most 16 characters, unique in the financial year, letters, digits, "/" and
 * "-" only (Rule 46). Format: <prefix>/<yyyy of the FY>/<serial>, e.g. "IN1/2627/00042".
 */
export function invoiceNumber(prefix, fy, serial) {
  const fyShort = `${fy.slice(2, 4)}${fy.slice(5, 7)}`;
  const number = `${prefix}/${fyShort}/${String(serial).padStart(5, "0")}`;
  if (number.length > 16 || !/^[A-Za-z0-9/-]+$/.test(number)) throw new Error(`Invoice number "${number}" breaks the GST format`);
  return number;
}

export const rupees = (paise) => `Rs ${(paise / 100).toLocaleString("en-IN", { minimumFractionDigits: paise % 100 ? 2 : 0, maximumFractionDigits: 2 })}`;
