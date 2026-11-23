import mongoose from "mongoose";
import { tenantField } from "./tenant.js";

const { ObjectId } = mongoose.Schema.Types;

// A GST tax invoice (sale) or credit note (return, refusal, cancellation after invoicing). Written once
// and never edited: a correction is a credit note. Amounts in paise.
const invoiceLineSchema = new mongoose.Schema(
  {
    description: { type: String, required: true },
    hsn: { type: String, required: true },
    qty: { type: Number, required: true },
    unitPaise: { type: Number, required: true },
    rate: { type: Number, required: true },
    taxablePaise: { type: Number, required: true },
    cgstPaise: { type: Number, default: 0 },
    sgstPaise: { type: Number, default: 0 },
    igstPaise: { type: Number, default: 0 },
    totalPaise: { type: Number, required: true },
  },
  { _id: false },
);

const invoiceSchema = new mongoose.Schema(
  {
    ...tenantField,
    kind: { type: String, enum: ["invoice", "credit_note"], required: true },
    number: { type: String, required: true },
    fy: { type: String, required: true },
    date: { type: Date, required: true },
    orderId: { type: ObjectId, ref: "Order", required: true },
    locationId: { type: ObjectId, ref: "Location", required: true },
    // For a credit note: the invoice it reverses.
    againstInvoiceId: { type: ObjectId, ref: "Invoice", default: null },
    seller: { legalName: String, gstin: String, address: String, stateCode: String },
    buyer: { name: String, address: String },
    placeOfSupply: { stateCode: { type: String, required: true }, state: { type: String, default: "" } },
    interState: { type: Boolean, required: true },
    lines: { type: [invoiceLineSchema], required: true },
    totals: {
      taxablePaise: { type: Number, required: true },
      cgstPaise: { type: Number, default: 0 },
      sgstPaise: { type: Number, default: 0 },
      igstPaise: { type: Number, default: 0 },
      totalPaise: { type: Number, required: true },
    },
  },
  { timestamps: true },
);

invoiceSchema.index({ tenantId: 1, number: 1 }, { unique: true });
invoiceSchema.index({ tenantId: 1, date: -1 });
invoiceSchema.index({ orderId: 1, kind: 1 }, { unique: true });

export const Invoice = mongoose.models.Invoice || mongoose.model("Invoice", invoiceSchema);
