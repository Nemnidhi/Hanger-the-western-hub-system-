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
    // Outfit picks: how much each part of the score counts (0-40 each), when a piece counts as new or
    // slow, and the automatic follow-up after a customer saves or leaves a look on the website.
    picks: {
      weights: {
        size: { type: Number, default: 30, min: 0, max: 40 },
        pair: { type: Number, default: 20, min: 0, max: 40 },
        colour: { type: Number, default: 15, min: 0, max: 40 },
        occasion: { type: Number, default: 15, min: 0, max: 40 },
        taste: { type: Number, default: 10, min: 0, max: 40 },
        push: { type: Number, default: 10, min: 0, max: 40 },
      },
      newDays: { type: Number, default: 14, min: 1, max: 90 },
      slowDays: { type: Number, default: 45, min: 7, max: 365 },
      autoSend: { type: Boolean, default: false },
      autoSendDelayMinutes: { type: Number, default: 60, min: 10, max: 24 * 60 },
      // Automatic picks go to one customer at most once in this many days.
      minGapDays: { type: Number, default: 7, min: 1, max: 60 },
      // Approved Marketing template for picks outside WhatsApp's 24-hour window
      // (blanks: first name, the piece they looked at, the picks in one line).
      template: { name: { type: String, default: "" }, language: { type: String, default: "en" } },
    },
    // The members' circle: points per rupee kept, what a point is worth, how much of a bill points may
    // pay, the tiers by spend over the last 12 months, and the referral rewards.
    loyalty: {
      enabled: { type: Boolean, default: true },
      rupeesPerPoint: { type: Number, default: 100, min: 1, max: 10000 },
      pointValuePaise: { type: Number, default: 100, min: 1, max: 10000 },
      maxRedeemPct: { type: Number, default: 20, min: 0, max: 100 },
      minRedeemPoints: { type: Number, default: 100, min: 0, max: 100000 },
      tiers: {
        type: [{ _id: false, name: String, minSpendPaise: Number, multiplier: Number, perk: String }],
        default: [
          { name: "Circle", minSpendPaise: 0, multiplier: 1, perk: "1 point for every Rs 100 she keeps" },
          { name: "Inner Circle", minSpendPaise: 15_000_00, multiplier: 1.5, perk: "1.5x points, first look at new drops" },
          { name: "Front Row", minSpendPaise: 40_000_00, multiplier: 2, perk: "2x points, private trial hour" },
        ],
      },
      referrerPoints: { type: Number, default: 200, min: 0, max: 100000 },
      referralDiscountPct: { type: Number, default: 10, min: 0, max: 50 },
    },
    // WhatsApp broadcasts: one customer gets at most one offer in this many days, at most this many
    // customers are messaged a day (the WhatsApp number's limit), and only between these hours (India).
    broadcasts: {
      minGapDays: { type: Number, default: 3, min: 0, max: 30 },
      dailyLimit: { type: Number, default: 1000, min: 50, max: 100000 },
      sendFromHour: { type: Number, default: 10, min: 0, max: 23 },
      sendUntilHour: { type: Number, default: 20, min: 1, max: 24 },
    },
    // The website storefront: the WhatsApp authentication template for sign-in codes (blank: codes go
    // only to customers whose chat is open), the shop's WhatsApp and Instagram for the footer, the
    // delivery and returns lines shown on every product, and the size charts (by category; a chart
    // with no categories is the default).
    shop: {
      loginTemplate: { name: { type: String, default: "" }, language: { type: String, default: "en" } },
      whatsappNumber: { type: String, default: "" },
      instagram: { type: String, default: "" },
      shippingNote: { type: String, default: "Free delivery across India in 3 to 7 days. Cash on delivery on most pincodes." },
      returnsNote: { type: String, default: "Free size exchange within 7 days of delivery. Unworn, with tags." },
      sizeCharts: {
        type: [{ _id: false, name: String, categories: [String], unit: String, columns: [String], rows: [[String]], note: String }],
        default: [
          {
            name: "Tops, dresses and co-ords",
            categories: [],
            unit: "inches",
            columns: ["Size", "Bust", "Waist", "Hip"],
            rows: [["XS", "32", "26", "35"], ["S", "34", "28", "37"], ["M", "36", "30", "39"], ["L", "38", "32", "41"], ["XL", "40", "34", "43"], ["XXL", "42", "36", "45"]],
            note: "Body measurements. Between two sizes? Take the larger for a relaxed fit.",
          },
          {
            name: "Jeans and trousers",
            categories: ["jeans", "trousers", "skirts"],
            unit: "inches",
            columns: ["Size", "Waist", "Hip", "Inseam"],
            rows: [["26", "26", "35", "28"], ["28", "28", "37", "28"], ["30", "30", "39", "29"], ["32", "32", "41", "29"], ["34", "34", "43", "30"], ["36", "36", "45", "30"]],
            note: "Measure around your natural waist, where you wear your jeans.",
          },
        ],
      },
    },
    // E-way bills for stock moved between locations: needed from this value (Rs 50,000 by default; some
    // states set a different limit inside the state, so check with the CA), and the usual distance.
    eway: {
      thresholdPaise: { type: Number, default: 50_000_00, min: 0, max: 1_00_00_000_00 },
      defaultDistanceKm: { type: Number, default: 0, min: 0, max: 4000 },
    },
    // The owner's morning brief on WhatsApp: on or off, the time (India), the numbers it goes to, and
    // the approved Utility template used outside the 24-hour window (blanks: the date, the headline).
    brief: {
      enabled: { type: Boolean, default: false },
      hour: { type: Number, default: 9, min: 5, max: 12 },
      minute: { type: Number, default: 0, min: 0, max: 59 },
      phones: { type: [String], default: [] },
      template: { name: { type: String, default: "" }, language: { type: String, default: "en" } },
    },
    // The buying desk: how many days of selling a reorder should cover, the usual supplier lead time
    // (until a supplier has its own record), the smallest markup over cost a markdown may leave, how
    // long a test buy runs before it is judged, and the buying calendar (moments the shop buys for).
    buying: {
      coverDays: { type: Number, default: 45, min: 7, max: 180 },
      leadDays: { type: Number, default: 14, min: 1, max: 120 },
      minMarkupPct: { type: Number, default: 15, min: 0, max: 300 },
      trialDays: { type: Number, default: 21, min: 7, max: 90 },
      calendar: {
        type: [{ _id: false, name: String, date: String, yearly: Boolean, buyWeeksBefore: Number, categories: [String], note: String }],
        default: [
          { name: "Valentine's Day", date: "2027-02-14", yearly: true, buyWeeksBefore: 3, categories: ["dresses", "tops"], note: "Date-night dresses, red and pink" },
          { name: "Holi", date: "2027-03-22", yearly: false, buyWeeksBefore: 3, categories: ["tops", "tees"], note: "White kurtis-tops and tees; check the date" },
          { name: "Summer drop", date: "2027-04-01", yearly: true, buyWeeksBefore: 4, categories: ["dresses", "co-ords", "tops"], note: "Linen and cotton, light colours" },
          { name: "Monsoon", date: "2027-06-20", yearly: true, buyWeeksBefore: 3, categories: ["tops", "jeans"], note: "Quick-dry fabrics, darker colours" },
          { name: "End-of-season sale (summer)", date: "2027-07-01", yearly: true, buyWeeksBefore: 0, categories: [], note: "Clear summer stock before festive buying" },
          { name: "Festive season", date: "2027-10-01", yearly: true, buyWeeksBefore: 5, categories: ["dresses", "co-ords"], note: "Navratri to Diwali: fusion and party wear" },
          { name: "Diwali", date: "2027-10-29", yearly: false, buyWeeksBefore: 5, categories: ["dresses", "co-ords"], note: "Check the date each year" },
          { name: "Wedding season", date: "2027-11-15", yearly: true, buyWeeksBefore: 5, categories: ["dresses", "jackets"], note: "Cocktail and sangeet outfits" },
          { name: "New Year's Eve", date: "2026-12-31", yearly: true, buyWeeksBefore: 4, categories: ["dresses", "jumpsuits"], note: "Party wear, sequins, black" },
          { name: "End-of-season sale (winter)", date: "2027-01-10", yearly: true, buyWeeksBefore: 0, categories: [], note: "Clear winter and party stock" },
        ],
      },
    },
    // Photo studio: the backdrop colour of the brand photos (hex, no #), notes on the brand's voice for
    // the write-ups, and hashtags every Instagram caption carries (without the #).
    studio: {
      backdrop: { type: String, default: "F4ECE6", match: /^[0-9A-Fa-f]{6}$/ },
      voice: { type: String, default: "", maxlength: 600 },
      hashtags: { type: [String], default: ["TheHangerIndore", "IndoreFashion", "WesternWear"] },
    },
    // Price tags for the label printer: the brand line at the top, an optional link for the QR code
    // ("{code}" is replaced by the size code), a short line under the QR (the website, say), and the
    // label size in millimetres (the 4Barcode rolls are 2 x 1 inch).
    tags: {
      brandLine: { type: String, default: "", maxlength: 30 },
      qrUrl: { type: String, default: "", maxlength: 200 },
      footer: { type: String, default: "", maxlength: 30 },
      showName: { type: Boolean, default: true },
      widthMm: { type: Number, default: 50.8, min: 25, max: 110 },
      heightMm: { type: Number, default: 25.4, min: 15, max: 80 },
    },
    // The WhatsApp stylist (Claude): off until the owner turns it on. It answers free-text questions
    // ("do you have this in M?", "what goes with a white shirt?") with pieces in stock and hands the chat
    // to staff for complaints, returns, payments or anything it is unsure of. At most dailyLimit replies
    // a chat in 24 hours, quiet for pauseMinutes after a staff reply and handoffHours after handing over.
    // notes: the owner's own lines for it (tone, what to push, what never to say).
    stylist: {
      enabled: { type: Boolean, default: false },
      dailyLimit: { type: Number, default: 15, min: 1, max: 100 },
      pauseMinutes: { type: Number, default: 120, min: 0, max: 1440 },
      handoffHours: { type: Number, default: 24, min: 1, max: 168 },
      notes: { type: String, default: "", maxlength: 1500 },
    },
    // Meta ads: whether purchases go to Meta's Conversions API (only when META_PIXEL_ID is set on the
    // server), and which channels' sales count.
    ads: {
      sendPurchases: { type: Boolean, default: true },
      channels: { type: [String], default: ["website", "whatsapp", "store"] },
    },
    // Instagram: automatic private replies to comments that contain a keyword ("PRICE", "LINK"), with an
    // optional short public reply under the comment.
    instagram: {
      commentReplies: { type: Boolean, default: false },
      rules: {
        type: [{ _id: false, keyword: String, reply: String, publicReply: String }],
        default: [{ keyword: "price", reply: "Hi! Thank you for asking. Here are the details and sizes in stock: {link}", publicReply: "Sent you a DM!" }],
      },
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
