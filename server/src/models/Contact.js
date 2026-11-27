import mongoose from "mongoose";
import { tenantField } from "./tenant.js";

// One customer on WhatsApp, keyed by their WhatsApp id (their number in international form).
const consentSchema = new mongoose.Schema(
  {
    given: { type: Boolean, default: false },
    at: { type: Date, default: null },
    source: { type: String, default: "" },
    // Set when the customer was asked, so they are asked only once.
    askedAt: { type: Date, default: null },
  },
  { _id: false },
);

const contactSchema = new mongoose.Schema(
  {
    ...tenantField,
    waId: { type: String, required: true },
    profileName: { type: String, default: "" },
    firstSeenAt: { type: Date, default: () => new Date() },
    lastInboundAt: { type: Date, default: null },
    // The last Click-to-WhatsApp ad she came from (Meta sends it with her first message after the tap).
    adReferral: {
      sourceId: { type: String, default: "" },
      sourceType: { type: String, default: "" },
      headline: { type: String, default: "" },
      ctwaClid: { type: String, default: "" },
      at: { type: Date, default: null },
    },
    // Separate consent per purpose (DPDP Act; WhatsApp's per-category opt-in).
    consents: {
      orderUpdates: { type: consentSchema, default: () => ({}) },

      // Marketing on WhatsApp (new drops, members' circle): only with this consent (DPDP Act).
      offers: { type: consentSchema, default: () => ({}) },
    },
    // Filled from orders: the name and delivery address last used, offered again on the next order.
    name: { type: String, default: "", trim: true, maxlength: 80 },
    lastAddress: {
      name: { type: String, default: "" },
      address: { type: String, default: "" },
      pincode: { type: String, default: "" },
    },
    // Fit profile (the stylist builds on this): usual size and notes in the customer's own words.
    // Outfit picks sent on WhatsApp: when the last ones went (automatic picks keep a gap).
    picks: { lastSentAt: { type: Date, default: null } },
    // The members' circle: points balance, her own referral code, and who referred her.
    loyalty: {
      points: { type: Number, default: 0 },
      tier: { type: String, default: "" },
      referralCode: { type: String, default: undefined, uppercase: true, trim: true },
      referredBy: { type: mongoose.Schema.Types.ObjectId, ref: "Contact", default: null },
      joinedAt: { type: Date, default: null },
    },
    // For staff: a birthday (day and month only) and notes in their own words.
    birthday: { day: { type: Number, default: null, min: 1, max: 31 }, month: { type: Number, default: null, min: 1, max: 12 } },
    notes: { type: String, default: "", maxlength: 500 },
    fit: {
      usualSize: { type: String, default: "", uppercase: true, trim: true, maxlength: 12 },
      // Waist size for jeans and trousers (26, 28...), when it is known.
      waist: { type: String, default: "", trim: true, maxlength: 4 },
      notes: { type: String, default: "", maxlength: 300 },
    },
  },
  { timestamps: true },
);

contactSchema.index({ tenantId: 1, waId: 1 }, { unique: true });
contactSchema.index({ tenantId: 1, "consents.offers.given": 1 });
contactSchema.index({ tenantId: 1, "loyalty.referralCode": 1 }, { unique: true, partialFilterExpression: { "loyalty.referralCode": { $type: "string" } } });

export const Contact = mongoose.models.Contact || mongoose.model("Contact", contactSchema);
