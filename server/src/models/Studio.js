import mongoose from "mongoose";
import { tenantField } from "./tenant.js";

const { ObjectId } = mongoose.Schema.Types;

// The photo studio: staff upload a plain photo of a piece; the system makes the shop's photos from it
// (clean white, brand backdrop, and on request an AI model or ghost-mannequin shot) and writes the
// website description and Instagram caption. Staff check it, pick, edit and apply it to a style.
export const STUDIO_KINDS = ["white", "studio", "model", "ghost"];

const outputSchema = new mongoose.Schema(
  {
    kind: { type: String, enum: STUDIO_KINDS, required: true },
    status: { type: String, enum: ["queued", "done", "failed", "skipped"], default: "queued" },
    url: { type: String, default: "" },
    // AI-generated (a model or mannequin that was not in the photo): staff check the piece matches.
    generated: { type: Boolean, default: false },
    error: { type: String, default: "" },
  },
  { _id: false },
);

const copySchema = new mongoose.Schema(
  {
    name: String,
    category: String,
    outfitPart: String,
    colour: String,
    pattern: String,
    fabricLooksLike: String,
    neckline: String,
    sleeve: String,
    fit: String,
    occasion: [String],
    websiteDescription: String,
    highlights: [String],
    instagramCaption: String,
    hashtags: [String],
    altText: String,
    // What staff must confirm before it goes out (fabric, lining, how it fits...).
    toCheck: [String],
    writtenBy: String,
  },
  { _id: false },
);

const studioJobSchema = new mongoose.Schema(
  {
    ...tenantField,
    sources: { type: [String], default: [] },
    notes: { type: String, default: "", maxlength: 600 },
    styleId: { type: ObjectId, ref: "Style", default: null },
    outputs: { type: [outputSchema], default: [] },
    copyStatus: { type: String, enum: ["queued", "done", "failed", "skipped"], default: "queued" },
    copyError: { type: String, default: "" },
    copy: { type: copySchema, default: null },
    appliedTo: { type: ObjectId, ref: "Style", default: null },
    appliedAt: { type: Date, default: null },
    createdBy: { type: String, default: "" },
  },
  { timestamps: true },
);
studioJobSchema.index({ tenantId: 1, createdAt: -1 });

/** "working" while any part is queued, else "ready" (some parts may have failed or been skipped). */
studioJobSchema.virtual("status").get(function status() {
  return this.copyStatus === "queued" || this.outputs.some((output) => output.status === "queued") ? "working" : "ready";
});
studioJobSchema.set("toJSON", { virtuals: true });

export const StudioJob = mongoose.models.StudioJob || mongoose.model("StudioJob", studioJobSchema);
