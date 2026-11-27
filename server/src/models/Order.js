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
    // The catalogue price before this order's discount (0 = no discount on this line).
    listUnitPaise: { type: Number, default: 0 },
    gstRate: { type: Number, required: true },
    hsn: { type: String, required: true },
    // Pieces of this line that came back (returns can be partial).
    returnedQty: { type: Number, default: 0, min: 0 },
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
    // Where the sale came from: the website's utm_* / fbclid on her first visit, or the
    // Click-to-WhatsApp ad she tapped (adId, ctwaClid). ip / userAgent: website orders, for Meta only.
    attribution: {
      source: { type: String, default: "" },
      medium: { type: String, default: "" },
      campaign: { type: String, default: "" },
      content: { type: String, default: "" },
      adId: { type: String, default: "" },
      fbclid: { type: String, default: "" },
      ctwaClid: { type: String, default: "" },
      landedAt: { type: Date, default: null },
      ip: { type: String, default: "" },
      userAgent: { type: String, default: "" },
    },
    // The Purchase sent to Meta's Conversions API (status "", sent, skipped, failed).
    metaEvent: {
      status: { type: String, default: "" },
      at: { type: Date, default: null },
      error: { type: String, default: "" },
      received: { type: Number, default: 0 },
      test: { type: Boolean, default: false },
    },
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
    // A discount on the whole bill: a creator's code, a referral code (first bill), and / or points.
    discount: {
      code: { type: String, default: "" },
      kind: { type: String, enum: ["", "creator", "referral"], default: "" },
      creatorId: { type: ObjectId, ref: "Creator", default: null },
      referrerId: { type: ObjectId, ref: "Contact", default: null },
      codePaise: { type: Number, default: 0 },
      pointsUsed: { type: Number, default: 0 },
      pointsPaise: { type: Number, default: 0 },
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
      // Set when the courier was booked through the shipping provider ("" = tracking typed in by hand).
      provider: { type: String, enum: ["", "shiprocket"], default: "" },
      providerOrderId: { type: String, default: "" },
      shipmentId: { type: String, default: "" },
      courierId: { type: Number, default: null },
      chargePaise: { type: Number, default: null },
      weightGrams: { type: Number, default: null },
      labelUrl: { type: String, default: "" },
      pickupNote: { type: String, default: "" },
      bookedAt: { type: Date, default: null },
      // A booking in progress (a lock, so two clicks cannot book two couriers). Cleared when done.
      bookingStartedAt: { type: Date, default: null },
      // Each new booking after a cancelled one gets a fresh reference at the provider.
      attempts: { type: Number, default: 0 },
      // The courier's latest word and its scans, from the webhook or the poll.
      trackingStatus: { type: String, default: "" },
      trackedAt: { type: Date, default: null },
      outForDeliveryAt: { type: Date, default: null },
      rtoStartedAt: { type: Date, default: null },
      events: {
        type: [new mongoose.Schema({ at: Date, status: String, activity: String, location: String }, { _id: false })],
        default: [],
      },
    },
    invoiceId: { type: ObjectId, ref: "Invoice", default: null },
    creditNoteId: { type: ObjectId, ref: "Invoice", default: null },
    // Partial or whole returns of a delivered order, each with its own credit note.
    returnIds: { type: [ObjectId], ref: "Return", default: [] },
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
orderSchema.index({ tenantId: 1, "shipment.awb": 1 });
orderSchema.index({ tenantId: 1, "discount.creatorId": 1, createdAt: -1 });

export const Order = mongoose.models.Order || mongoose.model("Order", orderSchema);

export const orderLabel = (order, prefix = "HWH") => `${prefix}-${order.number}`;
