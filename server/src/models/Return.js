import mongoose from "mongoose";
import { tenantField } from "./tenant.js";

const { ObjectId } = mongoose.Schema.Types;

// Why pieces come back, so buying and sizing can learn from it.
export const RETURN_REASONS = ["too_small", "too_big", "fit", "looks_different", "quality", "damaged", "wrong_item", "changed_mind", "late", "other"];
export const REFUND_METHODS = ["original", "cash", "upi", "card", "exchange", "store_credit", "none"];

// Pieces of a delivered order (online or a store bill) coming back: which, why, in what state, and how
// the money went back. Each return has its own GST credit note for exactly those pieces.
const returnLineSchema = new mongoose.Schema(
  {
    skuId: { type: ObjectId, ref: "Sku", required: true },
    skuCode: { type: String, required: true },
    styleCode: { type: String, required: true },
    name: { type: String, required: true },
    size: { type: String, required: true },
    qty: { type: Number, required: true, min: 1 },
    unitPaise: { type: Number, required: true },
    gstRate: { type: Number, required: true },
    hsn: { type: String, required: true },
    reason: { type: String, enum: RETURN_REASONS, required: true },
    // "resell": back on the shelf; "damaged": kept out of stock.
    condition: { type: String, enum: ["resell", "damaged"], default: "resell" },
  },
  { _id: false },
);

const returnSchema = new mongoose.Schema(
  {
    ...tenantField,
    number: { type: Number, required: true },
    orderId: { type: ObjectId, ref: "Order", required: true },
    orderNumber: { type: Number, required: true },
    channel: { type: String, required: true },
    contactId: { type: ObjectId, ref: "Contact", default: null },
    // Where the pieces came back to (a store for counter returns, else the order's own location).
    locationId: { type: ObjectId, ref: "Location", required: true },
    lines: { type: [returnLineSchema], validate: [(lines) => lines.length > 0, "Return at least one piece"] },
    note: { type: String, default: "", maxlength: 300 },
    refund: {
      method: { type: String, enum: REFUND_METHODS, required: true },
      amountPaise: { type: Number, required: true },
      note: { type: String, default: "", maxlength: 200 },
    },
    // An exchange: the new bill the credit went into.
    exchangeOrderId: { type: ObjectId, ref: "Order", default: null },
    creditNoteId: { type: ObjectId, ref: "Invoice", default: null },
    by: { type: String, default: "" },
    at: { type: Date, default: () => new Date() },
  },
  { timestamps: true },
);
returnSchema.index({ tenantId: 1, number: 1 }, { unique: true });
returnSchema.index({ tenantId: 1, at: -1 });
returnSchema.index({ orderId: 1 });

export const Return = mongoose.models.Return || mongoose.model("Return", returnSchema);
