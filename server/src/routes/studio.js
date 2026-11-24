import express from "express";
import mongoose from "mongoose";
import { z } from "zod";
import { requireAuth, requirePermission } from "../auth/middleware.js";
import { can } from "../auth/permissions.js";
import { audit } from "../audit.js";
import { StudioJob } from "../models/index.js";
import { httpError, parseBody, route } from "./validate.js";
import { applyStudioJob, retryStudioJob, startStudioJob, studioReadiness } from "../studio/studio.js";
import { CATEGORIES } from "../studio/copywriter.js";

// The photo studio for the staff app: start a job from uploaded photos, follow it, try failed parts
// again, and apply the checked photos and write-up to a style (or a new draft style).

const id = z.string().refine((value) => mongoose.isValidObjectId(value), "an id");
const word = z.string().trim().max(60);

export function createStudioRouter({ config, services }) {
  const router = express.Router();
  const tenantId = config.TENANT_ID;
  router.param("jobId", (req, res, next, value) => (mongoose.isValidObjectId(value) ? next() : next(httpError(404, "Not found", "NOT_FOUND"))));

  async function loadJob(req) {
    const job = await StudioJob.findOne({ _id: req.params.jobId, tenantId });
    if (!job) throw httpError(404, "Studio job not found", "NOT_FOUND");
    return job;
  }

  router.get("/api/studio/status", requireAuth(), requirePermission("catalog:read"), route(async (req, res) => {
    res.json(studioReadiness(services));
  }));

  router.get("/api/studio/jobs", requireAuth(), requirePermission("catalog:read"), route(async (req, res) => {
    const jobs = await StudioJob.find({ tenantId }).sort({ createdAt: -1 }).limit(40);
    res.json({ jobs: jobs.map((job) => job.toJSON()), ready: studioReadiness(services) });
  }));

  router.get("/api/studio/jobs/:jobId", requireAuth(), requirePermission("catalog:read"), route(async (req, res) => {
    res.json({ job: (await loadJob(req)).toJSON() });
  }));

  router.post("/api/studio/jobs", requireAuth(), requirePermission("catalog:write", "studio:use"), route(async (req, res) => {
    const body = parseBody(
      z.object({
        images: z.array(z.string().max(500)).min(1).max(4),
        notes: z.string().trim().max(600).default(""),
        styleId: id.optional(),
        extras: z.object({ model: z.boolean().default(false), ghost: z.boolean().default(false) }).default({ model: false, ghost: false }),
      }),
      req,
    );
    const job = await startStudioJob({ tenantId, config, services, sources: body.images, notes: body.notes, extras: body.extras, styleId: body.styleId || null, by: req.user?.name || "" });
    await audit({ req, action: "studio.start", meta: { studioJobId: job._id, photos: body.images.length, extras: body.extras } });
    res.status(201).json({ job: job.toJSON() });
  }));

  router.post("/api/studio/jobs/:jobId/retry", requireAuth(), requirePermission("catalog:write", "studio:use"), route(async (req, res) => {
    const job = await retryStudioJob({ tenantId, services, job: await loadJob(req) });
    res.json({ job: job.toJSON() });
  }));

  router.post("/api/studio/jobs/:jobId/apply", requireAuth(), requirePermission("catalog:write", "studio:use"), route(async (req, res) => {
    const body = parseBody(
      z
        .object({
          styleId: id.optional(),
          newStyle: z
            .object({
              code: z.string().trim().toUpperCase().regex(/^[A-Z0-9][A-Z0-9-]{2,23}$/, "a style code like DRS-014"),
              sizes: z.array(z.string().trim().min(1).max(12)).min(1).max(15),
              price: z.number().min(1).max(1_000_000),
            })
            .optional(),
          images: z.array(z.string().max(500)).max(10).default([]),
          name: z.string().trim().min(2).max(120).optional(),
          category: z.enum(CATEGORIES).optional(),
          description: z.string().max(2000).optional(),
          outfitPart: z.enum(["", "dress", "top", "bottom", "layer", "other"]).optional(),
          highlights: z.array(z.string().trim().max(80)).max(6).optional(),
          altText: z.string().max(300).optional(),
          instagramCaption: z.string().max(2200).optional(),
          hashtags: z.array(z.string().trim().regex(/^#?[\p{L}\p{N}_]{1,60}$/u, "a hashtag without spaces").transform((value) => value.replace(/^#/, ""))).max(30).optional(),
          attributes: z.object({ colour: word, fabric: word, neckline: word, sleeve: word, fit: word, pattern: word, occasion: z.array(word).max(6) }).partial().optional(),
        })
        .refine((value) => Boolean(value.styleId) !== Boolean(value.newStyle), "Choose a style, or give a code, sizes and price for a new one"),
      req,
    );
    // Staff with the studio only can make a new draft style; changing an existing style needs catalog:write.
    if (body.styleId && !can(req.user.role, "catalog:write")) throw httpError(403, "Your role can make a new draft style from the studio; ask a manager to change an existing style.", "FORBIDDEN");
    const job = await loadJob(req);
    const { styleId, newStyle, images, ...fields } = body;
    const style = await applyStudioJob({ tenantId, job, styleId, newStyle: newStyle && { code: newStyle.code, sizes: newStyle.sizes, pricePaise: Math.round(newStyle.price * 100) }, images, fields });
    await audit({ req, action: "studio.apply", meta: { studioJobId: job._id, styleId: style._id, created: Boolean(newStyle), photos: images.length } });
    res.json({ style: { _id: style._id, code: style.code, name: style.name, status: style.status } });
  }));

  return router;
}
