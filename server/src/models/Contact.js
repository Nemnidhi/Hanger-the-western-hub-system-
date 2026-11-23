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
    fit: {
      usualSize: { type: String, default: "", uppercase: true, trim: true, maxlength: 12 },
      notes: { type: String, default: "", maxlength: 300 },
    },
  },
  { timestamps: true },
);

contactSchema.index({ tenantId: 1, waId: 1 }, { unique: true });
contactSchema.index({ tenantId: 1, "consents.offers.given": 1 });

export const Contact = mongoose.models.Contact || mongoose.model("Contact", contactSchema);
