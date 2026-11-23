// The day-one cash-on-delivery risk score: plain, readable rules that give a graded score from 0 to 1
// (never a hidden yes/no), with the reasons in words. It is replaced by a trained model once there are
// about 2,000 COD orders of the brand's own (System design, Models); the bands stay the owner's choice.
//
// Inputs are facts the platform already has: the customer's past orders, the pincode's delivery
// record, the order itself, and the address as typed.

const clamp = (value, low = 0, high = 1) => Math.min(high, Math.max(low, value));

/** How complete an address looks: a house or flat number, a street or area, and enough words. */
export function addressQuality(address) {
  const text = String(address || "").trim();
  let points = 0;
  if (/\d/.test(text.replace(/[1-9]\d{5}/, ""))) points += 1; // a house/flat/plot number besides the pincode
  if (/\b(road|rd|street|st|nagar|colony|sector|marg|lane|society|apartment|apt|tower|block|phase|vihar|enclave|layout|main)\b/i.test(text)) points += 1;
  if (text.split(/\s+/).length >= 6) points += 1;
  if (/\b(near|opp|opposite|behind|beside)\b/i.test(text)) points += 0.5;
  return clamp(points / 3);
}

/**
 * history: { delivered, refused } past COD outcomes of this customer; pincode: { delivered, rto }
 * outcomes of all orders to this pincode; order: { valuePaise, pieces, address, at }.
 * Returns { score, reasons }.
 */
export function codRiskScore({ history = {}, pincode = {}, order }) {
  const reasons = [];
  const delivered = history.delivered || 0;
  const refused = history.refused || 0;
  let score = 0.15;

  if (refused > 0) {
    const share = refused / (delivered + refused);
    score += 0.25 + 0.35 * share;
    reasons.push(`refused ${refused} of ${delivered + refused} earlier COD orders`);
  } else if (delivered > 0) {
    score -= Math.min(0.2, 0.06 * delivered);
    reasons.push(`took ${delivered} earlier COD order${delivered > 1 ? "s" : ""}`);
  } else {
    score += 0.12;
    reasons.push("first order");
  }

  // A pincode's return-to-origin rate, smoothed towards an assumed 20% until it has its own record.
  const pinOrders = (pincode.delivered || 0) + (pincode.rto || 0);
  const pinRate = ((pincode.rto || 0) + 1) / (pinOrders + 5);
  score += 0.4 * (pinRate - 0.2);
  if (pinOrders >= 5 && pinRate >= 0.3) reasons.push(`${Math.round(pinRate * 100)}% of orders to this pincode came back`);

  const value = order.valuePaise / 100;
  if (value > 1500) {
    score += 0.2 * clamp((value - 1500) / 3500);
    reasons.push(`order value Rs ${Math.round(value).toLocaleString("en-IN")}`);
  }
  if (order.pieces > 2) {
    score += Math.min(0.15, 0.05 * (order.pieces - 2));
    reasons.push(`${order.pieces} pieces`);
  }

  const quality = addressQuality(order.address);
  if (quality < 0.67) {
    score += 0.12 * (1 - quality);
    reasons.push("address looks incomplete");
  }

  const istHour = (new Date(order.at || Date.now()).getUTCHours() + 5.5) % 24;
  if (istHour >= 0 && istHour < 6) {
    score += 0.05;
    reasons.push("placed between midnight and 6 am");
  }

  return { score: Math.round(clamp(score) * 100) / 100, reasons };
}

/** The band (and so the action) for a score, from the owner's settings. */
export function codBand(score, { lowBelow = 0.35, highFrom = 0.6 } = {}) {
  if (score < lowBelow) return "low";
  if (score >= highFrom) return "high";
  return "medium";
}
