import mongoose from "mongoose";
import { DEFAULT_GST_SLABS } from "../commerce/gst.js";

// The boutique's own rules, set by the owner: business and GST details, which location ships online
// orders, cash-on-delivery rules, payment hold time and WhatsApp templates. One document per brand.
const slabSchema = new mongoose.Schema({ uptoPaise: { type: Number, default: null }, rate: { type: Number, required: true, min: 0, max: 28 } }, { _id: false });

const settingsSchema = new mongoose.Schema(
  {
    tenantId: { type: String, required: true },
    brandName: { type: String, default: "The Hanger", trim: true, maxlength: 80 },
    // Printed on every GST invoice.
    legalName: { type: String, default: "", trim: true, maxlength: 120 },
    gstin: { type: String, default: "", trim: true, uppercase: true, match: /^$|^\d{2}[A-Z]{5}\d{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/ },
    registeredAddress: { type: String, default: "", trim: true, maxlength: 300 },
    // GST state code of the registration (23 = Madhya Pradesh). Decides CGST+SGST versus IGST.
    stateCode: { type: String, default: "23", match: /^\d{2}$/ },
    orderPrefix: { type: String, default: "HWH", match: /^[A-Z]{2,5}$/ },
    // The location whose stock online orders (WhatsApp, website) are taken from and shipped.
    onlineLocationCode: { type: String, default: "", trim: true, uppercase: true },
    gstSlabs: { type: [slabSchema], default: () => DEFAULT_GST_SLABS.map((slab) => ({ ...slab })) },
    // HSN for a style that has none of its own (6204: women's woven dresses, suits, skirts, trousers).
    defaultHsn: { type: String, default: "6204", match: /^\d{4,8}$/ },
    // A prepaid order holds its stock this long while the customer pays.
    paymentHoldMinutes: { type: Number, default: 30, min: 5, max: 24 * 60 },
    cod: {
      enabled: { type: Boolean, default: true },
      // Orders above this value are prepaid only (0 = no limit).
      maxOrderPaise: { type: Number, default: 0, min: 0 },
      // Risk bands on the 0-1 score: below lowBelow ships at once; from highFrom the customer is asked
      // to prepay; in between, the customer confirms on WhatsApp first. Graded, set by the owner.
      lowBelow: { type: Number, default: 0.35, min: 0, max: 1 },
      highFrom: { type: Number, default: 0.6, min: 0, max: 1 },
      // An unconfirmed COD order is cancelled and its stock released after this many hours.
      confirmHours: { type: Number, default: 12, min: 1, max: 72 },
    },
    // Courier booking defaults. pickupLocation is the pickup address's name in the Shiprocket account.
    shipping: {
      pickupLocation: { type: String, default: "", trim: true, maxlength: 60 },
      weightGrams: { type: Number, default: 500, min: 50, max: 30000 },
      lengthCm: { type: Number, default: 30, min: 1, max: 200 },
      breadthCm: { type: Number, default: 25, min: 1, max: 200 },
      heightCm: { type: Number, default: 4, min: 1, max: 200 },
    },
    // Approved Utility template for order updates outside WhatsApp's 24-hour window
    // (blanks: first name, order number, status words).
    templates: {
      orderUpdate: { name: { type: String, default: "" }, language: { type: String, default: "en" } },
    },
  },
  { timestamps: true },
);

settingsSchema.index({ tenantId: 1 }, { unique: true });

export const Settings = mongoose.models.Settings || mongoose.model("Settings", settingsSchema);

/** The brand's settings, created with defaults the first time. */
export async function getSettings(tenantId, session) {
  return Settings.findOneAndUpdate({ tenantId }, { $setOnInsert: { tenantId } }, { upsert: true, new: true, session });
}
