import { rupees } from "./gst.js";

// What the customer reads on WhatsApp, in one place so the wording can be tuned with the owner.
// Each returns { text } or { text, buttons } (at most 3 buttons, titles up to 20 characters).

const label = (order, prefix) => `${prefix}-${order.number}`;

function itemLines(order) {
  return order.lines.map((line) => `- ${line.name}, size ${line.size} x${line.qty}: ${rupees(line.unitPaise * line.qty)}`).join("\n");
}

export const outOfStock = (short) => ({
  text: `Sorry, these just sold out:\n${short.map((item) => `- ${item.skuCode} (size ${item.size}): ${item.available ? `only ${item.available} left` : "none left"}`).join("\n")}\n\nPlease update your cart and send it again, or ask us here for something similar.`,
});

export const unknownItems = (codes) => ({
  text: `Sorry, we could not find ${codes.join(", ")} in our current collection. Please send your cart again from the catalogue.`,
});

export const askAddress = (order, prefix) => ({
  text: `Thank you! Your order ${label(order, prefix)}:\n${itemLines(order)}\nTotal: ${rupees(order.totals.totalPaise)} (incl. GST)\n\nPlease send your full delivery address with the 6-digit pincode, and the name for delivery.`,
});

export const askSavedAddress = (order, prefix, saved) => ({
  text: `Thank you! Your order ${label(order, prefix)}:\n${itemLines(order)}\nTotal: ${rupees(order.totals.totalPaise)} (incl. GST)\n\nDeliver to your last address?\n${saved.name ? `${saved.name}, ` : ""}${saved.address}`,
  buttons: [
    { id: "addr_saved", title: "Yes, same address" },
    { id: "addr_new", title: "New address" },
  ],
});

export const askAddressAgain = () => ({ text: "Please send the full address including the 6-digit pincode (for example: 12 Saket Nagar, near the temple, Indore 452018)." });

export const askPayment = (order, { codAllowed, prepaidAllowed }) => {
  const buttons = [];
  if (prepaidAllowed) buttons.push({ id: "pay_prepaid", title: "Pay now (UPI/card)" });
  if (codAllowed) buttons.push({ id: "pay_cod", title: "Cash on delivery" });
  return { text: `Delivering to:\n${order.shipTo.name ? `${order.shipTo.name}, ` : ""}${order.shipTo.address}\n\nTotal ${rupees(order.totals.totalPaise)}. How would you like to pay?`, buttons };
};

export const noPaymentOption = () => ({ text: "Sorry, we cannot take this order online right now. Someone from the store will message you shortly." });

export const paymentLink = (order, prefix, url, holdMinutes) => ({
  text: `Pay ${rupees(order.totals.totalPaise)} for order ${label(order, prefix)} here:\n${url}\n\nYour pieces are kept for you for ${holdMinutes} minutes.`,
});

export const codConfirm = (order, prefix) => ({
  text: `Order ${label(order, prefix)}: ${rupees(order.totals.totalPaise)}, cash on delivery.\nPlease confirm so we can pack it. Paying now gets it out faster.`,
  buttons: [
    { id: "cod_yes", title: "Confirm COD" },
    { id: "pay_prepaid", title: "Pay now instead" },
    { id: "order_cancel", title: "Cancel order" },
  ],
});

export const codPrepayOnly = (order, prefix) => ({
  text: `For order ${label(order, prefix)} we can only take payment online. Pay now and we pack it today.`,
  buttons: [
    { id: "pay_prepaid", title: "Pay now (UPI/card)" },
    { id: "order_cancel", title: "Cancel order" },
  ],
});

export const confirmed = (order, prefix) => ({
  text: `Confirmed! Order ${label(order, prefix)} is being packed.${order.payment.method === "cod" ? ` Please keep ${rupees(order.totals.totalPaise)} ready at delivery.` : " Payment received, thank you."}\nWe will send the tracking details when it ships.`,
});

export const shipped = (order, prefix) => ({
  text: `Order ${label(order, prefix)} has shipped with ${order.shipment.courier}. Tracking number: ${order.shipment.awb}.${order.shipment.provider === "shiprocket" ? `
Track it here: https://shiprocket.co/tracking/${encodeURIComponent(order.shipment.awb)}` : ""}`,
});

export const outForDelivery = (order, prefix) => ({
  text: `Order ${label(order, prefix)} is out for delivery today with ${order.shipment.courier || "the courier"}.${order.payment.method === "cod" && order.payment.status !== "paid" ? ` Please keep ${rupees(order.totals.totalPaise)} ready.` : ""}`,
});

export const delivered = (order, prefix) => ({
  text: `Order ${label(order, prefix)} is delivered. We hope you love it! If anything does not fit, reply here and we will help with an exchange.`,
});

export const cancelled = (order, prefix) => ({
  text: `Order ${label(order, prefix)} is cancelled${order.cancelReason ? ` (${order.cancelReason})` : ""}. If this is a mistake, just send your cart again.`,
});

/** Words for the order-update template (outside the 24-hour window). */
export function statusWords(order) {
  return {
    confirmed: "confirmed and being packed",
    packed: "packed",
    shipped: `shipped (${order.shipment?.courier || "courier"} ${order.shipment?.awb || ""})`.trim(),
    delivered: "delivered",
    cancelled: "cancelled",
    rto: "returned to us",
    returned: "returned",
  }[order.status] || order.status;
}
