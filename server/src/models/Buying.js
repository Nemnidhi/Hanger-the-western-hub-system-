import mongoose from "mongoose";
import { tenantField } from "./tenant.js";

const { ObjectId } = mongoose.Schema.Types;

// A purchase order to a supplier: sizes and quantities of styles already in the catalogue (a new
// style is added as a draft first, as staff do anyway to print its tags). A test buy is a small first
// order of a new style, judged on how it sells before buying more. Receiving against it puts the
// pieces in stock and records how long the supplier took and how much of the order came.
const poLineSchema = new mongoose.Schema(
  {
    skuId: { type: ObjectId, ref: "Sku", required: true },
    skuCode: { type: String, required: true },
    styleId: { type: ObjectId, ref: "Style", required: true },
    styleCode: { type: String, required: true },
    name: { type: String, default: "" },
    size: { type: String, required: true },
    qty: { type: Number, required: true, min: 1, max: 10000 },
    costPaise: { type: Number, default: 0, min: 0 },
    receivedQty: { type: Number, default: 0, min: 0 },
  },
  { _id: false },
);

const purchaseOrderSchema = new mongoose.Schema(
  {
    ...tenantField,
    number: { type: Number, required: true },
    supplierId: { type: ObjectId, ref: "Supplier", required: true },
    locationId: { type: ObjectId, ref: "Location", required: true },
    status: { type: String, enum: ["draft", "sent", "part_received", "received", "cancelled"], default: "draft" },
    trial: { type: Boolean, default: false },
    lines: { type: [poLineSchema], default: [] },
    note: { type: String, default: "", maxlength: 500 },
    expectedAt: { type: Date, default: null },
    sentAt: { type: Date, default: null },
    firstReceivedAt: { type: Date, default: null },
    receivedAt: { type: Date, default: null },
    receipts: { type: [{ _id: false, at: Date, by: String, pieces: Number, note: String }], default: [] },
    createdBy: { type: String, default: "" },
  },
  { timestamps: true },
);
purchaseOrderSchema.index({ tenantId: 1, number: 1 }, { unique: true });
purchaseOrderSchema.index({ tenantId: 1, supplierId: 1, createdAt: -1 });
purchaseOrderSchema.index({ tenantId: 1, status: 1 });

// A markdown on a style. Public: the selling price changes everywhere (the old price is kept to show
// struck through). Quiet: the price stays; members (a customer with her phone on the bill) pay the
// lower price at the counter, so the rail does not look on sale.
const markdownSchema = new mongoose.Schema(
  {
    ...tenantField,
    styleId: { type: ObjectId, ref: "Style", required: true },
    styleCode: { type: String, required: true },
    kind: { type: String, enum: ["public", "quiet"], required: true },
    listPaise: { type: Number, required: true },
    pricePaise: { type: Number, required: true },
    pct: { type: Number, required: true },
    // Public: each size's price before and after, so ending the markdown puts back exactly what was there.
    skuPrices: { type: [{ _id: false, skuId: ObjectId, skuCode: String, listPaise: Number, pricePaise: Number }], default: [] },
    reason: { type: String, default: "", maxlength: 300 },
    status: { type: String, enum: ["active", "ended"], default: "active" },
    startedAt: { type: Date, default: () => new Date() },
    until: { type: Date, default: null },
    endedAt: { type: Date, default: null },
    piecesAtStart: { type: Number, default: 0 },
    by: { type: String, default: "" },
  },
  { timestamps: true },
);
// One active markdown per style.
markdownSchema.index({ tenantId: 1, styleId: 1 }, { unique: true, partialFilterExpression: { status: "active" } });
markdownSchema.index({ tenantId: 1, status: 1, startedAt: -1 });

export const PurchaseOrder = mongoose.models.PurchaseOrder || mongoose.model("PurchaseOrder", purchaseOrderSchema);
export const Markdown = mongoose.models.Markdown || mongoose.model("Markdown", markdownSchema);
