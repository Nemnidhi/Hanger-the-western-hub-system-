import mongoose from "mongoose";
import { tenantField } from "./tenant.js";

const { ObjectId } = mongoose.Schema.Types;

// Stock moved between the shop's own locations, with its delivery challan number and the transport
// details for an e-way bill. Value is at cost (the price before GST where no cost is entered). The
// e-way bill itself is made on the government portal; its number is written back here.
const transferSchema = new mongoose.Schema(
  {
    ...tenantField,
    number: { type: Number, required: true },
    challanNo: { type: String, required: true },
    fromLocationId: { type: ObjectId, ref: "Location", required: true },
    toLocationId: { type: ObjectId, ref: "Location", required: true },
    lines: {
      type: [
        new mongoose.Schema(
          {
            skuId: { type: ObjectId, ref: "Sku", required: true },
            skuCode: String,
            styleCode: String,
            name: String,
            size: String,
            hsn: String,
            qty: Number,
            unitValuePaise: Number,
            gstRate: Number,
          },
          { _id: false },
        ),
      ],
      default: [],
    },
    valuePaise: { type: Number, default: 0 },
    // Both ends under the same GSTIN (same state): a delivery challan, no tax. Different GSTINs (another
    // state): a supply between branches, which needs a tax invoice; the CA decides the value.
    sameGstin: { type: Boolean, default: true },
    ewayNeeded: { type: Boolean, default: false },
    transport: {
      mode: { type: String, enum: ["road", "rail", "air", "ship"], default: "road" },
      vehicleNo: { type: String, default: "", uppercase: true, trim: true, maxlength: 15 },
      transporterName: { type: String, default: "", maxlength: 100 },
      transporterId: { type: String, default: "", uppercase: true, trim: true, maxlength: 15 },
      distanceKm: { type: Number, default: 0, min: 0, max: 4000 },
    },
    ewayBillNo: { type: String, default: "", trim: true, maxlength: 20 },
    ewayBillAt: { type: Date, default: null },
    note: { type: String, default: "", maxlength: 300 },
    by: { type: String, default: "" },
    at: { type: Date, default: () => new Date() },
  },
  { timestamps: true },
);
transferSchema.index({ tenantId: 1, number: 1 }, { unique: true });
transferSchema.index({ tenantId: 1, at: -1 });

export const Transfer = mongoose.models.Transfer || mongoose.model("Transfer", transferSchema);
