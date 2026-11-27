import mongoose from "mongoose";
import { Location, Style, Transfer, getSettings, nextNumber } from "../models/index.js";
import { financialYear, invoiceNumber, rateForPiece, taxableFrom } from "./gst.js";
import { stateForAddress } from "./pincode.js";
import { transferStock } from "./stock.js";

// Stock moved between the shop's own locations gets a delivery challan and, when its value reaches
// the e-way bill limit (Settings; Rs 50,000 by default, check your state's limit with your CA), the
// data for the e-way bill in the layout of the government portal's bulk upload, to check and upload.

const trusted = (filter) => mongoose.trusted(filter);
const toRupees = (paise) => Math.round(paise) / 100;
const MODES = { road: 1, rail: 2, air: 3, ship: 4 };

/** The GSTIN, state and place of a location (its own GSTIN, else the business's). */
export function locationGst(location, settings) {
  const state = stateForAddress({ pincode: location.pincode, text: location.address });
  const gstin = location.gstin || settings.gstin || "";
  return { gstin, stateCode: state.stateCode || gstin.slice(0, 2) || settings.stateCode, place: location.city || location.name, pincode: location.pincode, address: location.address };
}

/** Moves the pieces and records the transfer with its challan number and value. */
export async function createTransfer({ tenantId, from, to, items, note = "", by, session, at = new Date() }) {
  await transferStock({ tenantId, fromLocationId: from._id, toLocationId: to._id, items, by, note, session, at });
  const settings = await getSettings(tenantId, session);
  const styles = new Map((await Style.find({ tenantId, _id: trusted({ $in: items.map(({ sku }) => sku.styleId) }) }).session(session)).map((style) => [String(style._id), style]));
  const lines = items.map(({ sku, qty }) => {
    const style = styles.get(String(sku.styleId));
    const unitValuePaise = style?.costPaise || taxableFrom(sku.pricePaise, rateForPiece(sku.pricePaise, settings.gstSlabs));
    return { skuId: sku._id, skuCode: sku.code, styleCode: style?.code || sku.styleCode, name: style?.name || "", size: sku.size, hsn: style?.hsn || settings.defaultHsn || "", qty, unitValuePaise, gstRate: rateForPiece(sku.pricePaise, settings.gstSlabs) };
  });
  const valuePaise = lines.reduce((sum, line) => sum + line.unitValuePaise * line.qty, 0);
  const a = locationGst(from, settings);
  const b = locationGst(to, settings);
  const number = await nextNumber(`transfer:${tenantId}`, session);
  const fy = financialYear(at);
  const challanNo = invoiceNumber(`${from.invoicePrefix}T`.slice(0, 5), fy, await nextNumber(`challan:${tenantId}:${from.invoicePrefix}:${fy}`, session));
  const [transfer] = await Transfer.create(
    [{ tenantId, number, challanNo, fromLocationId: from._id, toLocationId: to._id, lines, valuePaise, sameGstin: a.gstin === b.gstin, ewayNeeded: valuePaise >= (settings.eway?.thresholdPaise ?? 50_000_00), transport: { distanceKm: settings.eway?.defaultDistanceKm || 0 }, note, by, at }],
    { session },
  );
  return transfer;
}

const ddmmyyyy = (date) => {
  const ist = new Date(new Date(date).getTime() + 330 * 60_000);
  return `${String(ist.getUTCDate()).padStart(2, "0")}/${String(ist.getUTCMonth() + 1).padStart(2, "0")}/${ist.getUTCFullYear()}`;
};

/**
 * The e-way bill data for a transfer in the layout of the portal's bulk upload (JSON). Same GSTIN:
 * a delivery challan for own use, no tax. Different GSTINs: tax at the pieces' GST rate as IGST
 * (between states) and a note that a tax invoice is needed. Returns { json, problems }.
 */
export async function ewayBillData({ tenantId, transfer }) {
  const settings = await getSettings(tenantId);
  const [from, to] = await Promise.all([Location.findById(transfer.fromLocationId).lean(), Location.findById(transfer.toLocationId).lean()]);
  const a = locationGst(from, settings);
  const b = locationGst(to, settings);
  const interState = a.stateCode !== b.stateCode;
  const taxed = !transfer.sameGstin;
  const problems = [];
  if (!a.gstin) problems.push("The business GSTIN is not set (Settings > Business and GST).");
  if (!from.pincode || !to.pincode) problems.push("Both locations need a pincode.");
  if (!transfer.transport.distanceKm) problems.push("Enter the distance in km.");
  if (transfer.transport.mode === "road" && !transfer.transport.vehicleNo && !transfer.transport.transporterId) problems.push("Enter the vehicle number or the transporter's ID.");
  if (transfer.lines.some((line) => !line.hsn)) problems.push("Some pieces have no HSN code (catalogue, or the default in Settings).");
  if (taxed) problems.push("The two locations have different GSTINs: moving stock between them is a supply and needs a tax invoice, not only a challan. Check the value and tax with your CA.");

  // One item per style and HSN.
  const items = new Map();
  for (const line of transfer.lines) {
    const key = `${line.styleCode}|${line.hsn}`;
    const row = items.get(key) || { name: line.name || line.styleCode, styleCode: line.styleCode, hsn: line.hsn, qty: 0, valuePaise: 0, rate: line.gstRate };
    row.qty += line.qty;
    row.valuePaise += line.unitValuePaise * line.qty;
    items.set(key, row);
  }
  const itemList = [...items.values()].map((row, index) => ({
    itemNo: index + 1,
    productName: row.name.slice(0, 100),
    productDesc: `${row.styleCode} ready-made garments`.slice(0, 100),
    hsnCode: Number(row.hsn) || 0,
    quantity: row.qty,
    qtyUnit: "PCS",
    taxableAmount: toRupees(row.valuePaise),
    sgstRate: taxed && !interState ? row.rate / 2 : 0,
    cgstRate: taxed && !interState ? row.rate / 2 : 0,
    igstRate: taxed && interState ? row.rate : 0,
    cessRate: 0,
    cessNonAdvol: 0,
  }));
  const tax = (key) => [...items.values()].reduce((sum, row) => sum + (taxed ? (key === "igst" ? (interState ? (row.valuePaise * row.rate) / 100 : 0) : interState ? 0 : (row.valuePaise * row.rate) / 200) : 0), 0);
  const [cgst, sgst, igst] = [tax("cgst"), tax("sgst"), tax("igst")];
  const mainHsn = [...items.values()].sort((x, y) => y.valuePaise - x.valuePaise)[0]?.hsn || "";
  const bill = {
    userGstin: a.gstin,
    supplyType: "O",
    subSupplyType: taxed ? 1 : 5,
    subSupplyDesc: "",
    docType: taxed ? "INV" : "CHL",
    docNo: transfer.challanNo,
    docDate: ddmmyyyy(transfer.at),
    fromGstin: a.gstin,
    fromTrdName: settings.legalName || settings.brandName || "",
    fromAddr1: (a.address || "").slice(0, 120),
    fromAddr2: "",
    fromPlace: (a.place || "").slice(0, 50),
    fromPincode: Number(a.pincode) || 0,
    fromStateCode: Number(a.stateCode) || 0,
    actualFromStateCode: Number(a.stateCode) || 0,
    toGstin: b.gstin,
    toTrdName: settings.legalName || settings.brandName || "",
    toAddr1: (b.address || "").slice(0, 120),
    toAddr2: "",
    toPlace: (b.place || "").slice(0, 50),
    toPincode: Number(b.pincode) || 0,
    toStateCode: Number(b.stateCode) || 0,
    actualToStateCode: Number(b.stateCode) || 0,
    transactionType: 1,
    totalValue: toRupees(transfer.valuePaise),
    cgstValue: toRupees(cgst),
    sgstValue: toRupees(sgst),
    igstValue: toRupees(igst),
    cessValue: 0,
    cessNonAdvolValue: 0,
    otherValue: 0,
    totInvValue: toRupees(transfer.valuePaise + cgst + sgst + igst),
    transMode: MODES[transfer.transport.mode] || 1,
    transDistance: String(Math.round(transfer.transport.distanceKm || 0)),
    transporterName: transfer.transport.transporterName || "",
    transporterId: transfer.transport.transporterId || "",
    transDocNo: "",
    transDocDate: "",
    vehicleNo: transfer.transport.vehicleNo || "",
    vehicleType: "R",
    mainHsnCode: Number(mainHsn) || 0,
    itemList,
  };
  return { json: { version: "1.0.0621", billLists: [bill] }, problems, from: { ...a, name: from.name }, to: { ...b, name: to.name } };
}
