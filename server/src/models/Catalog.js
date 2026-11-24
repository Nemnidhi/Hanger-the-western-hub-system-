import mongoose from "mongoose";
import { tenantField } from "./tenant.js";

const { ObjectId } = mongoose.Schema.Types;

// A place that holds stock: the store on MG Road, a later store, a warehouse. Each has its own GST
// invoice series (prefix), because invoice numbers must be unique per series in a financial year.
const locationSchema = new mongoose.Schema(
  {
    ...tenantField,
    code: { type: String, required: true, uppercase: true, trim: true, match: /^[A-Z0-9]{2,6}$/ },
    name: { type: String, required: true, trim: true, maxlength: 80 },
    kind: { type: String, enum: ["store", "warehouse"], default: "store" },
    address: { type: String, default: "", trim: true, maxlength: 300 },
    pincode: { type: String, default: "", match: /^$|^[1-9]\d{5}$/ },
    // Invoice prefix, 2-4 characters (e.g. "IN1"): with "/2627/00042" it stays within GST's 16.
    invoicePrefix: { type: String, required: true, uppercase: true, match: /^[A-Z0-9]{2,4}$/ },
    active: { type: Boolean, default: true },
  },
  { timestamps: true },
);
locationSchema.index({ tenantId: 1, code: 1 }, { unique: true });
locationSchema.index({ tenantId: 1, invoicePrefix: 1 }, { unique: true });

// A supplier the boutique buys from. The supplier book (scorecards, reorders) builds on this.
const supplierSchema = new mongoose.Schema(
  {
    ...tenantField,
    name: { type: String, required: true, trim: true, maxlength: 120 },
    city: { type: String, default: "", trim: true, maxlength: 60 },
    // WhatsApp number in international form, for reorder messages.
    waId: { type: String, default: "", match: /^$|^\d{10,15}$/ },
    notes: { type: String, default: "", maxlength: 1000 },
  },
  { timestamps: true },
);
supplierSchema.index({ tenantId: 1, name: 1 }, { unique: true });

// A style: one design in one colour, sold in several sizes. Described by attributes so the system
// can learn which attributes sell, fit and come back.
const styleSchema = new mongoose.Schema(
  {
    ...tenantField,
    code: { type: String, required: true, uppercase: true, trim: true, match: /^[A-Z0-9][A-Z0-9-]{2,23}$/ },
    name: { type: String, required: true, trim: true, maxlength: 120 },
    category: { type: String, required: true, trim: true, lowercase: true, maxlength: 40 },
    description: { type: String, default: "", maxlength: 2000 },
    attributes: {
      colour: { type: String, default: "", trim: true, lowercase: true },
      fabric: { type: String, default: "", trim: true, lowercase: true },
      neckline: { type: String, default: "", trim: true, lowercase: true },
      sleeve: { type: String, default: "", trim: true, lowercase: true },
      fit: { type: String, default: "", trim: true, lowercase: true },
      pattern: { type: String, default: "", trim: true, lowercase: true },
      occasion: { type: [String], default: [] },
    },
    // For outfit picks: the part of a look this piece is ("" = worked out from the category), how its
    // sizes run, and the styles the staff say it goes with (style codes).
    outfitPart: { type: String, enum: ["", "dress", "top", "bottom", "layer", "other"], default: "" },
    sizing: { type: String, enum: ["true", "runs_small", "runs_large"], default: "true" },
    pairsWith: { type: [String], default: [] },
    images: { type: [String], default: [] },
    // Selling price per piece, GST-inclusive, in paise. Cost is what the boutique paid the supplier.
    pricePaise: { type: Number, required: true, min: 100 },
    costPaise: { type: Number, default: 0, min: 0 },
    hsn: { type: String, default: "", match: /^$|^\d{4,8}$/ },
    supplierId: { type: ObjectId, ref: "Supplier", default: null },
    supplierStyleRef: { type: String, default: "", trim: true, maxlength: 60 },
    status: { type: String, enum: ["draft", "live", "archived"], default: "draft" },
    liveAt: { type: Date, default: null },
  },
  { timestamps: true },
);
styleSchema.index({ tenantId: 1, code: 1 }, { unique: true });
styleSchema.index({ tenantId: 1, status: 1, liveAt: -1 });

// One size of a style: the unit that is stocked, sold and shown in Meta's catalogue (its code is the
// catalogue's retailer id, so a WhatsApp cart comes back with our own codes).
const skuSchema = new mongoose.Schema(
  {
    ...tenantField,
    styleId: { type: ObjectId, ref: "Style", required: true },
    styleCode: { type: String, required: true },
    code: { type: String, required: true, uppercase: true },
    size: { type: String, required: true, trim: true, uppercase: true, maxlength: 12 },
    barcode: { type: String, trim: true },
    pricePaise: { type: Number, required: true, min: 100 },
    // Set whenever price, status or stock changes; the catalogue sync sends it to Meta and clears it.
    metaDirty: { type: Boolean, default: true },
    metaSyncedAt: { type: Date, default: null },
  },
  { timestamps: true },
);
skuSchema.index({ tenantId: 1, code: 1 }, { unique: true });
skuSchema.index({ tenantId: 1, barcode: 1 }, { unique: true, partialFilterExpression: { barcode: { $type: "string" } } });
skuSchema.index({ styleId: 1 });
skuSchema.index({ tenantId: 1, metaDirty: 1 });

// Stock of one SKU at one location. `available` is always onHand - reserved and is kept in the same
// update, so "reserve if enough" is one conditional write: two buyers can never both get the last piece.
const stockLevelSchema = new mongoose.Schema(
  {
    ...tenantField,
    skuId: { type: ObjectId, ref: "Sku", required: true },
    locationId: { type: ObjectId, ref: "Location", required: true },
    onHand: { type: Number, default: 0, min: 0 },
    reserved: { type: Number, default: 0, min: 0 },
    available: { type: Number, default: 0, min: 0 },
  },
  { timestamps: true },
);
stockLevelSchema.index({ skuId: 1, locationId: 1 }, { unique: true });
stockLevelSchema.index({ tenantId: 1, locationId: 1 });

// The stock ledger: every change to onHand, with its reason. Stock is never edited without a row here.
const stockMoveSchema = new mongoose.Schema(
  {
    ...tenantField,
    skuId: { type: ObjectId, ref: "Sku", required: true },
    skuCode: { type: String, required: true },
    locationId: { type: ObjectId, ref: "Location", required: true },
    qty: { type: Number, required: true },
    kind: { type: String, enum: ["receive", "sale", "return", "cancel", "adjust", "transfer_out", "transfer_in"], required: true },
    orderId: { type: ObjectId, ref: "Order", default: null },
    supplierId: { type: ObjectId, ref: "Supplier", default: null },
    note: { type: String, default: "", maxlength: 300 },
    by: { type: String, default: "" },
    at: { type: Date, default: () => new Date() },
  },
  { timestamps: false },
);
stockMoveSchema.index({ skuId: 1, at: -1 });
stockMoveSchema.index({ tenantId: 1, kind: 1, at: -1 });

export const Location = mongoose.models.Location || mongoose.model("Location", locationSchema);
export const Supplier = mongoose.models.Supplier || mongoose.model("Supplier", supplierSchema);
export const Style = mongoose.models.Style || mongoose.model("Style", styleSchema);
export const Sku = mongoose.models.Sku || mongoose.model("Sku", skuSchema);
export const StockLevel = mongoose.models.StockLevel || mongoose.model("StockLevel", stockLevelSchema);
export const StockMove = mongoose.models.StockMove || mongoose.model("StockMove", stockMoveSchema);
