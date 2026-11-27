import mongoose from "mongoose";
import { tenantField } from "./tenant.js";

const { ObjectId } = mongoose.Schema.Types;

// The members' circle: points earned on what a customer keeps, spent as a discount on a later bill.
// Every change to a balance is a row here; Contact.loyalty.points is the running total, changed in the
// same transaction.
const pointsEntrySchema = new mongoose.Schema(
  {
    ...tenantField,
    contactId: { type: ObjectId, ref: "Contact", required: true },
    kind: { type: String, enum: ["earn", "redeem", "reverse", "referral", "adjust"], required: true },
    points: { type: Number, required: true },
    orderId: { type: ObjectId, ref: "Order", default: null },
    returnId: { type: ObjectId, ref: "Return", default: null },
    // For an earn: the multiplier of her tier then, so a return takes back exactly what was given.
    multiplier: { type: Number, default: 1 },
    note: { type: String, default: "", maxlength: 200 },
    by: { type: String, default: "system" },
    at: { type: Date, default: () => new Date() },
  },
  { timestamps: false },
);
pointsEntrySchema.index({ contactId: 1, at: -1 });
// One earn, one redeem and one referral reward per order (reversals carry the return, not the order).
pointsEntrySchema.index({ orderId: 1, kind: 1, contactId: 1 }, { unique: true, partialFilterExpression: { orderId: { $type: "objectId" } } });
pointsEntrySchema.index({ returnId: 1 }, { unique: true, partialFilterExpression: { returnId: { $type: "objectId" } } });

// A creator (influencer, stylist, friend of the shop) with her own code: her followers get a discount,
// she earns a commission on what they keep, paid monthly.
const creatorSchema = new mongoose.Schema(
  {
    ...tenantField,
    name: { type: String, required: true, trim: true, maxlength: 80 },
    code: { type: String, required: true, uppercase: true, trim: true, match: /^[A-Z0-9]{3,16}$/ },
    phone: { type: String, default: "", maxlength: 15 },
    instagram: { type: String, default: "", maxlength: 60 },
    upi: { type: String, default: "", maxlength: 80 },
    discountPct: { type: Number, default: 10, min: 0, max: 50 },
    commissionPct: { type: Number, default: 10, min: 0, max: 50 },
    // Tax deducted from her payout, as the shop's CA advises (0 when not applicable).
    tdsPct: { type: Number, default: 0, min: 0, max: 30 },
    active: { type: Boolean, default: true },
    notes: { type: String, default: "", maxlength: 300 },
  },
  { timestamps: true },
);
creatorSchema.index({ tenantId: 1, code: 1 }, { unique: true });

// A month's payout to a creator, recorded when paid: the figures as they stood then.
const creatorPayoutSchema = new mongoose.Schema(
  {
    ...tenantField,
    creatorId: { type: ObjectId, ref: "Creator", required: true },
    month: { type: String, required: true, match: /^\d{4}-\d{2}$/ },
    orders: { type: Number, default: 0 },
    netSalesPaise: { type: Number, required: true },
    commissionPaise: { type: Number, required: true },
    tdsPaise: { type: Number, default: 0 },
    paidPaise: { type: Number, required: true },
    reference: { type: String, default: "", maxlength: 80 },
    paidAt: { type: Date, default: () => new Date() },
    by: { type: String, default: "" },
  },
  { timestamps: true },
);
creatorPayoutSchema.index({ tenantId: 1, creatorId: 1, month: 1 }, { unique: true });

export const PointsEntry = mongoose.models.PointsEntry || mongoose.model("PointsEntry", pointsEntrySchema);
export const Creator = mongoose.models.Creator || mongoose.model("Creator", creatorSchema);
export const CreatorPayout = mongoose.models.CreatorPayout || mongoose.model("CreatorPayout", creatorPayoutSchema);
