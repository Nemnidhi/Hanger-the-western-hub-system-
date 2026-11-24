import { Invoice, Location, nextNumber } from "../models/index.js";
import { GST_STATES } from "./pincode.js";
import { financialYear, invoiceNumber, splitLine } from "./gst.js";

const httpError = (status, message, code) => Object.assign(new Error(message), { status, code });

/**
 * The place of supply. Goods sent to the customer: the delivery state. Sold over the counter: the
 * store's own state.
 */
/** The delivery address with its pincode, which the customer has usually typed already. */
function buyerAddress(shipTo = {}) {
  const address = String(shipTo.address || "").trim();
  const pincode = String(shipTo.pincode || "");
  return pincode && !address.includes(pincode) ? [address, pincode].filter(Boolean).join(", ") : address;
}

export function placeOfSupply(order, settings) {
  if (order.channel === "store") return { stateCode: settings.stateCode, state: GST_STATES[settings.stateCode] || "" };
  if (!order.shipTo?.stateCode || order.shipTo.stateSure === false) return null;
  return { stateCode: order.shipTo.stateCode, state: order.shipTo.state || GST_STATES[order.shipTo.stateCode] || "" };
}

/**
 * Writes the GST tax invoice for an order (once), or a credit note reversing it. Numbers come from a
 * counter inside the same transaction, so a rolled-back order leaves no gap in the series.
 */
export async function issueInvoice({ tenantId, order, settings, kind = "invoice", session, at = new Date() }) {
  const existing = await Invoice.findOne({ orderId: order._id, kind }).session(session);
  if (existing) return existing;
  const original = kind === "credit_note" ? await Invoice.findOne({ orderId: order._id, kind: "invoice" }).session(session) : null;
  if (kind === "credit_note" && !original) return null;

  const pos = original ? original.placeOfSupply : placeOfSupply(order, settings);
  if (!pos) throw httpError(409, "Confirm the delivery state before the invoice can be made (the pincode is shared by two states).", "STATE_UNSURE");

  const location = await Location.findById(order.locationId).session(session);
  if (!location) throw httpError(500, "The order's location is missing", "LOCATION_MISSING");
  const fy = financialYear(at);
  const prefix = kind === "invoice" ? location.invoicePrefix : `${location.invoicePrefix}C`;
  const serial = await nextNumber(`invoice:${tenantId}:${prefix}:${fy}`, session);
  const interState = original ? original.interState : pos.stateCode !== settings.stateCode;

  const lines = order.lines.map((line) => ({
    description: `${line.name} - ${line.size} (${line.skuCode})`,
    hsn: line.hsn,
    qty: line.qty,
    unitPaise: line.unitPaise,
    ...splitLine({ unitPaise: line.unitPaise, qty: line.qty, rate: line.gstRate, interState }),
  }));
  const sum = (field) => lines.reduce((total, line) => total + line[field], 0);

  const [invoice] = await Invoice.create(
    [
      {
        tenantId,
        kind,
        number: invoiceNumber(prefix, fy, serial),
        fy,
        date: at,
        orderId: order._id,
        locationId: location._id,
        againstInvoiceId: original?._id || null,
        seller: { legalName: settings.legalName || settings.brandName, gstin: settings.gstin, address: location.address || settings.registeredAddress, stateCode: settings.stateCode },
        buyer: { name: order.shipTo?.name || order.customer?.name || "", address: order.channel === "store" ? "" : buyerAddress(order.shipTo) },
        placeOfSupply: pos,
        interState,
        lines,
        totals: { taxablePaise: sum("taxablePaise"), cgstPaise: sum("cgstPaise"), sgstPaise: sum("sgstPaise"), igstPaise: sum("igstPaise"), totalPaise: sum("totalPaise") },
      },
    ],
    { session },
  );
  return invoice;
}
