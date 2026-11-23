import mongoose from "mongoose";
import { tenantField } from "./tenant.js";

const { ObjectId } = mongoose.Schema.Types;

// An order from any channel. Online orders hold their stock while the customer chooses how to pay
// (stockState "held"); a confirmed order has taken the stock ("committed") and has a GST invoice.
export const ORDER_STATUSES = [
  "draft", // cart received, waiting for the address
  "awaiting_payment", // prepaid: waiting for the payment
  "awaiting_confirmation", // cash on delivery: waiting for the customer's yes
  "confirmed",
  "packed",
  "shipped",
  "delivered",
  "rto", // refused or undeliverable, back at the store
  "returned",
  "cancelled",
];
export const OPEN_STATUSES = ["draft", "awaiting_payment", "awaiting_confirmation"];

const lineSchema = new mongoose.Schema(
  {
    skuId: { type: ObjectId, ref: "Sku", required: true },
    skuCode: { type: String, required: true },
    styleCode: { type: String, required: true },
    name: { type: String, required: true },
    size: { type: String, required: true },
    qty: { type: Number, required: true, min: 1, max: 20 },
    // GST-inclusive selling price per piece, and the GST rate it falls under.
    unitPaise: { type: Number, required: true, min: 0 },
    gstRate: { type: Number, required: true },
    hsn: { type: String, required: true },
  },
  { _id: false },
);

const historySchema = new mongoose.Schema(
  { at: { type: Date, default: () => new Date() }, by: { type: String, default: "system" }, event: { type: String, required: true }, note: { type: String, default: "" } },
  { _id: false },
);

const orderSchema = new mongoose.Schema(
  {
    ...tenantField,
    number: { type: Number, required: true },
    channel: { type: String, enum: ["whatsapp", "website", "store", "phone", "marketplace"], required: true },
    contactId: { type: ObjectId, ref: "Contact", default: null },
    conversationId: { type: ObjectId, ref: "Conversation", default: null },
    customer: { name: { type: String, default: "" }, phone: { type: String, default: "" } },
    shipTo: {
      name: { type: String, default: "" },
      address: { type: String, default: "" },
      pincode: { type: String, default: "" },
      stateCode: { type: String, default: "" },
      state: { type: String, default: "" },
      // False when the pincode block is shared between states and the address does not say which.
      stateSure: { type: Boolean, default: true },
    },
    locationId: { type: ObjectId, ref: "Location", required: true },
    lines: { type: [lineSchema], validate: [(lines) => lines.length > 0, "An order needs at least one item"] },
    totals: {
      itemsPaise: { type: Number, default: 0 },
      totalPaise: { type: Number, default: 0 },
    },
    payment: {
      method: { type: String, enum: ["", "prepaid", "cod", "store_cash", "store_upi", "store_card"], default: "" },
      status: { type: String, enum: ["none", "pending", "paid", "refunded"], default: "none" },
      linkId: { type: String, default: "" },
      url: { type: String, default: "" },
      paidAt: { type: Date, default: null },
    },
    cod: {
      score: { type: Number, default: null },
      band: { type: String, enum: ["", "low", "medium", "high"], default: "" },
      reasons: { type: [String], default: [] },
      confirmedAt: { type: Date, default: null },
    },
    status: { type: String, enum: ORDER_STATUSES, default: "draft" },
    // Where the WhatsApp conversation is in taking this order.
    chatStep: { type: String, enum: ["", "awaiting_address", "awaiting_payment_choice", "awaiting_cod_confirm"], default: "" },
    stockState: { type: String, enum: ["held", "committed", "released"], default: "held" },
    // An open order still holding stock at this time is cancelled and the stock released.
    holdUntil: { type: Date, default: null },
    confirmedAt: { type: Date, default: null },
    shipment: {
      courier: { type: String, default: "" },
      awb: { type: String, default: "" },
      shippedAt: { type: Date, default: null },
      deliveredAt: { type: Date, default: null },
      rtoAt: { type: Date, default: null },
    },
    invoiceId: { type: ObjectId, ref: "Invoice", default: null },
    creditNoteId: { type: ObjectId, ref: "Invoice", default: null },
    cancelReason: { type: String, default: "" },
    history: { type: [historySchema], default: [] },
  },
  { timestamps: true },
);

orderSchema.index({ tenantId: 1, number: 1 }, { unique: true });
orderSchema.index({ tenantId: 1, status: 1, createdAt: -1 });
orderSchema.index({ contactId: 1, createdAt: -1 });
orderSchema.index({ status: 1, holdUntil: 1 });
orderSchema.index({ tenantId: 1, "payment.linkId": 1 });

export const Order = mongoose.models.Order || mongoose.model("Order", orderSchema);

export const orderLabel = (order, prefix = "HWH") => `${prefix}-${order.number}`;
