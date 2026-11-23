// Pincode to GST state, for the place of supply on invoices and for the intra- or inter-state tax split.
//
// The first two digits of a pincode mostly identify a state. Where a two-digit block is shared by
// two states or union territories (for example 40: Maharashtra and Goa), the answer is "unsure" and
// the state named in the address text decides; if that is missing too, staff confirm it before the
// invoice. Phase 2 replaces this table with India Post's all-India pincode directory (data.gov.in).

export const GST_STATES = Object.freeze({
  "01": "Jammu and Kashmir", "02": "Himachal Pradesh", "03": "Punjab", "04": "Chandigarh", "05": "Uttarakhand",
  "06": "Haryana", "07": "Delhi", "08": "Rajasthan", "09": "Uttar Pradesh", "10": "Bihar", "11": "Sikkim",
  "12": "Arunachal Pradesh", "13": "Nagaland", "14": "Manipur", "15": "Mizoram", "16": "Tripura", "17": "Meghalaya",
  "18": "Assam", "19": "West Bengal", "20": "Jharkhand", "21": "Odisha", "22": "Chhattisgarh", "23": "Madhya Pradesh",
  "24": "Gujarat", "26": "Dadra and Nagar Haveli and Daman and Diu", "27": "Maharashtra", "29": "Karnataka", "30": "Goa",
  "31": "Lakshadweep", "32": "Kerala", "33": "Tamil Nadu", "34": "Puducherry", "35": "Andaman and Nicobar Islands",
  "36": "Telangana", "37": "Andhra Pradesh", "38": "Ladakh",
});

// Two-digit pincode block -> GST state code, only where the block belongs to one state.
const BLOCKS = {
  11: "07", 12: "06", 13: "06", 14: "03", 15: "03", 17: "02",
  20: "09", 21: "09", 22: "09", 23: "09", 25: "09", 27: "09", 28: "09",
  30: "08", 31: "08", 32: "08", 33: "08", 34: "08",
  36: "24", 37: "24", 38: "24",
  40: "27", 41: "27", 42: "27", 43: "27", 44: "27",
  45: "23", 46: "23", 47: "23", 48: "23", 49: "22",
  50: "36", 51: "37", 52: "37",
  56: "29", 57: "29", 58: "29", 59: "29",
  61: "33", 62: "33", 63: "33", 64: "33",
  67: "32", 69: "32",
  70: "19", 71: "19", 72: "19",
  75: "21", 76: "21", 77: "21", 78: "18",
  80: "10", 84: "10", 85: "10",
};

// Three-digit exceptions inside a block above (403: Goa inside Maharashtra's 40).
const SUB_BLOCKS = { 403: "30" };

export function isPincode(value) {
  return /^[1-9]\d{5}$/.test(String(value || ""));
}

/** The first valid 6-digit pincode in a piece of text (an address typed in chat), or "". */
export function findPincode(text) {
  const match = /(?:^|\D)([1-9]\d{2}\s?\d{3})(?!\d)/.exec(String(text || ""));
  return match ? match[1].replace(/\s/, "") : "";
}

function stateNamedIn(text) {
  const lower = String(text || "").toLowerCase();
  // Longest names first, so "Andhra Pradesh" is not read as "Pradesh" of another state.
  const entries = Object.entries(GST_STATES).sort((a, b) => b[1].length - a[1].length);
  for (const [code, name] of entries) if (lower.includes(name.toLowerCase())) return code;
  if (/\bm\.?\s?p\.?\b/.test(lower)) return "23";
  return "";
}

/**
 * The GST state for a delivery address: { stateCode, state, sure }. `sure` is false when the pincode
 * block is shared and the address does not name the state; the order then waits for staff to check.
 */
export function stateForAddress({ pincode, text = "" }) {
  const pin = String(pincode || "");
  const fromPin = isPincode(pin) ? SUB_BLOCKS[Number(pin.slice(0, 3))] || BLOCKS[Number(pin.slice(0, 2))] || "" : "";
  const fromText = stateNamedIn(text);
  const stateCode = fromPin || fromText;
  return { stateCode, state: GST_STATES[stateCode] || "", sure: Boolean(fromPin) || Boolean(fromText) };
}
