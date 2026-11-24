import path from "node:path";
import { readFile, writeFile, mkdir, stat } from "node:fs/promises";
import mongoose from "mongoose";
import { getSettings, Sku, Style, StudioJob } from "../models/index.js";
import { enqueue, RetryableError } from "../jobs/queue.js";
import { withTransaction } from "../db.js";
import { createStyle, updateStyle } from "../commerce/catalog.js";
import { GENERATED_KINDS } from "./photoroom.js";

// The photo studio's work: a studio job per piece, one queue job per photo kind and one for the
// write-up (so a slow AI model shot never holds up the clean photo), and "apply" to put the chosen
// photos and the checked write-up on a style.

const MAX_ATTEMPTS = 4;
// Claude takes images up to 5 MB each; the staff app shrinks photos before upload, this is the guard.
const COPY_IMAGE_LIMIT = 5 * 1024 * 1024;
const MEDIA_TYPES = { jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", webp: "image/webp" };
const fail = (status, message, code) => Object.assign(new Error(message), { status, code });
const rupees = (paise) => `Rs ${(paise / 100).toLocaleString("en-IN")}`;

export function mediaBase(config) {
  return (config.PUBLIC_BASE_URL || `http://localhost:${config.PORT}`).replace(/\/$/, "");
}

/** The file behind one of our own /media URLs, or null (anything else is refused: no fetching other sites). */
export function mediaFile(config, url) {
  let pathname;
  try {
    pathname = new URL(url, "http://local").pathname;
  } catch {
    return null;
  }
  const match = /^\/media\/([A-Za-z0-9_-]+\.(jpg|jpeg|png|webp))$/.exec(pathname);
  return match ? { file: path.join(path.resolve(config.UPLOAD_DIR), match[1]), name: match[1], mediaType: MEDIA_TYPES[match[2]] } : null;
}

async function readSource(config, url) {
  const media = mediaFile(config, url);
  if (!media) throw Object.assign(new Error("The photo is not one of the shop's uploads"), { permanent: true });
  const buffer = await readFile(media.file).catch(() => null);
  if (!buffer) throw Object.assign(new Error("The uploaded photo is missing on the server"), { permanent: true });
  return { buffer, mediaType: media.mediaType, name: media.name };
}

/** What the studio can do right now, for the staff screen. */
export function studioReadiness(services) {
  return {
    images: services.studioImages ? services.studioImages.name : null,
    copy: services.copywriter ? services.copywriter.name : null,
  };
}

/** Starts a studio job: the photos staff uploaded, their notes, and which extra AI shots they want. */
export async function startStudioJob({ tenantId, config, services, sources, notes = "", extras = {}, styleId = null, by = "" }) {
  for (const url of sources) {
    const media = mediaFile(config, url);
    if (!media || !(await stat(media.file).catch(() => null))) throw fail(400, "Upload the photos here first (they must be the shop's own uploads).", "BAD_SOURCE");
  }
  if (styleId && !(await Style.exists({ _id: styleId, tenantId }))) throw fail(404, "Style not found", "NOT_FOUND");
  const kinds = ["white", "studio", ...(extras.model ? ["model"] : []), ...(extras.ghost ? ["ghost"] : [])];
  const imagesReady = Boolean(services.studioImages);
  const copyReady = Boolean(services.copywriter);
  return withTransaction(async (session) => {
    const [job] = await StudioJob.create(
      [{
        tenantId, sources, notes, styleId, createdBy: by,
        outputs: kinds.map((kind) => ({ kind, generated: GENERATED_KINDS.has(kind), status: imagesReady ? "queued" : "skipped", error: imagesReady ? "" : "Photo service not connected" })),
        copyStatus: copyReady ? "queued" : "skipped",
        copyError: copyReady ? "" : "Write-ups not connected",
      }],
      { session },
    );
    if (imagesReady) for (const kind of kinds) await enqueue("studio.image", { jobId: String(job._id), kind }, { maxAttempts: MAX_ATTEMPTS, session });
    if (copyReady) await enqueue("studio.copy", { jobId: String(job._id) }, { maxAttempts: MAX_ATTEMPTS, session });
    return job;
  });
}

/** Queues again the parts that failed (or were skipped because a service was not connected then). */
export async function retryStudioJob({ tenantId, services, job }) {
  const kinds = job.outputs.filter((output) => output.status === "failed" || (output.status === "skipped" && services.studioImages)).map((output) => output.kind);
  const copyAgain = job.copyStatus === "failed" || (job.copyStatus === "skipped" && services.copywriter);
  if (!kinds.length && !copyAgain) throw fail(409, "Nothing to try again", "NOTHING_TO_RETRY");
  return withTransaction(async (session) => {
    const fresh = await StudioJob.findOne({ _id: job._id, tenantId }).session(session);
    for (const output of fresh.outputs) if (kinds.includes(output.kind)) Object.assign(output, { status: "queued", error: "" });
    if (copyAgain) Object.assign(fresh, { copyStatus: "queued", copyError: "" });
    await fresh.save({ session });
    for (const kind of kinds) await enqueue("studio.image", { jobId: String(fresh._id), kind }, { maxAttempts: MAX_ATTEMPTS, session });
    if (copyAgain) await enqueue("studio.copy", { jobId: String(fresh._id) }, { maxAttempts: MAX_ATTEMPTS, session });
    return fresh;
  });
}

/** Records a failed part: a permanent failure at once, a retryable one only on its last attempt. */
async function recordFailure({ tenantId, jobId, kind, error, attempt }) {
  const last = !(error instanceof RetryableError) || attempt >= MAX_ATTEMPTS;
  if (!last) return;
  const message = String(error.message || error).slice(0, 300);
  if (kind) await StudioJob.updateOne({ _id: jobId, tenantId, "outputs.kind": kind }, { $set: { "outputs.$.status": "failed", "outputs.$.error": message } });
  else await StudioJob.updateOne({ _id: jobId, tenantId }, { $set: { copyStatus: "failed", copyError: message } });
}

export function createStudioHandlers({ config, services }) {
  const tenantId = config.TENANT_ID;
  const { studioImages, copywriter } = services;
  return {
    async "studio.image"({ jobId, kind }, { job: queued } = {}) {
      const job = await StudioJob.findOne({ _id: jobId, tenantId });
      const output = job?.outputs.find((row) => row.kind === kind);
      if (!output || output.status === "done" || !studioImages) return;
      try {
        const settings = await getSettings(tenantId);
        const source = await readSource(config, job.sources[0]);
        const made = await studioImages.render({ image: source, kind, backdrop: settings.studio?.backdrop });
        const ext = made.mediaType === "image/jpeg" ? "jpg" : made.mediaType === "image/webp" ? "webp" : "png";
        const name = `studio-${jobId}-${kind}.${ext}`;
        const dir = path.resolve(config.UPLOAD_DIR);
        await mkdir(dir, { recursive: true });
        await writeFile(path.join(dir, name), made.buffer);
        await StudioJob.updateOne({ _id: jobId, tenantId, "outputs.kind": kind }, { $set: { "outputs.$.status": "done", "outputs.$.url": `${mediaBase(config)}/media/${name}`, "outputs.$.error": "" } });
      } catch (error) {
        await recordFailure({ tenantId, jobId, kind, error, attempt: queued?.attempts ?? MAX_ATTEMPTS });
        if (error instanceof RetryableError) throw error;
      }
    },

    async "studio.copy"({ jobId }, { job: queued } = {}) {
      const job = await StudioJob.findOne({ _id: jobId, tenantId });
      if (!job || job.copyStatus === "done" || !copywriter) return;
      try {
        const settings = await getSettings(tenantId);
        const images = [];
        for (const url of job.sources.slice(0, 4)) {
          const source = await readSource(config, url);
          if (source.buffer.length <= COPY_IMAGE_LIMIT) images.push({ mediaType: source.mediaType, base64: source.buffer.toString("base64") });
        }
        if (!images.length) throw Object.assign(new Error("The photos are over 5 MB; upload them again from the studio screen (it shrinks them)"), { permanent: true });
        const style = job.styleId ? await Style.findById(job.styleId).lean() : null;
        const sizes = style ? (await Sku.find({ tenantId, styleId: style._id }).lean()).map((sku) => sku.size) : [];
        const copy = await copywriter.write({
          images,
          context: { brandName: settings.brandName, city: "Indore", voice: settings.studio?.voice, hashtags: settings.studio?.hashtags || [], notes: job.notes, styleName: style?.name || "", price: style ? rupees(style.pricePaise) : "", sizes },
        });
        await StudioJob.updateOne({ _id: jobId, tenantId }, { $set: { copy, copyStatus: "done", copyError: "" } });
      } catch (error) {
        await recordFailure({ tenantId, jobId, kind: null, error, attempt: queued?.attempts ?? MAX_ATTEMPTS });
        if (error instanceof RetryableError) throw error;
      }
    },
  };
}

/**
 * Puts the checked result on a style: the chosen photos first (in the order chosen, then the style's
 * earlier photos), the write-up, attributes and Instagram caption. With `newStyle` it makes a draft
 * style instead. Only photos from this studio job can be chosen.
 */
export async function applyStudioJob({ tenantId, job, styleId, newStyle, images, fields }) {
  const allowed = new Set([...job.sources, ...job.outputs.filter((output) => output.status === "done").map((output) => output.url)]);
  const chosen = [...new Set(images)];
  const stranger = chosen.find((url) => !allowed.has(url));
  if (stranger) throw fail(400, "Only photos from this studio job can be applied", "BAD_IMAGE");
  const data = {
    ...(fields.name ? { name: fields.name } : {}),
    ...(fields.category ? { category: fields.category } : {}),
    ...(fields.description !== undefined ? { description: fields.description } : {}),
    ...(fields.outfitPart !== undefined ? { outfitPart: fields.outfitPart } : {}),
    ...(fields.highlights ? { highlights: fields.highlights } : {}),
    ...(fields.altText !== undefined ? { imageAlt: fields.altText } : {}),
    ...(fields.instagramCaption !== undefined || fields.hashtags ? { social: { instagramCaption: fields.instagramCaption || "", hashtags: fields.hashtags || [] } } : {}),
  };
  return withTransaction(async (session) => {
    let style;
    if (newStyle) {
      if (!chosen.length) throw fail(400, "Choose at least one photo for the new style", "NO_IMAGES");
      ({ style } = await createStyle({
        tenantId,
        data: { code: newStyle.code, name: fields.name || newStyle.code, category: fields.category || "other", pricePaise: newStyle.pricePaise, attributes: fields.attributes || {}, images: chosen, ...data },
        sizes: newStyle.sizes,
        session,
      }));
    } else {
      const found = await Style.findOne({ _id: styleId, tenantId }).session(session);
      if (!found) throw fail(404, "Style not found", "NOT_FOUND");
      const merged = [...chosen, ...found.images.filter((url) => !chosen.includes(url))].slice(0, 10);
      const attributes = fields.attributes ? { ...found.attributes.toObject?.() ?? found.attributes, ...fields.attributes } : undefined;
      style = await updateStyle({ style: found, changes: { ...data, images: merged, ...(attributes ? { attributes } : {}) }, session });
    }
    await StudioJob.updateOne({ _id: job._id, tenantId }, { $set: { appliedTo: style._id, appliedAt: new Date() } }, { session });
    return style;
  });
}

export const isObjectId = (value) => mongoose.isValidObjectId(value);
