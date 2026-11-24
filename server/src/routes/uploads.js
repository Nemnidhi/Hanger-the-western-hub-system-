import express from "express";
import path from "node:path";
import { mkdir, writeFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { requireAuth, requirePermission } from "../auth/middleware.js";
import { httpError, route } from "./validate.js";

// Product photos: staff upload them from the phone or computer; they are served at /media/<name> so the
// website and Meta's catalogue can fetch them. Only JPEG, PNG and WebP, checked by their first bytes.
const MAX_BYTES = 8 * 1024 * 1024;

function imageType(buffer) {
  if (buffer.length > 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return "jpg";
  if (buffer.length > 8 && buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "png";
  if (buffer.length > 12 && buffer.subarray(0, 4).toString("latin1") === "RIFF" && buffer.subarray(8, 12).toString("latin1") === "WEBP") return "webp";
  return "";
}

export function createUploadsRouter({ config }) {
  const router = express.Router();
  const dir = path.resolve(config.UPLOAD_DIR);

  router.use("/media", express.static(dir, { maxAge: "30d", immutable: true, index: false, dotfiles: "deny", fallthrough: false, setHeaders: (res) => res.set("Cross-Origin-Resource-Policy", "cross-origin") }));

  router.post(
    "/api/uploads",
    requireAuth(),
    requirePermission("catalog:write", "studio:use"),
    express.raw({ type: ["image/jpeg", "image/png", "image/webp"], limit: MAX_BYTES }),
    route(async (req, res) => {
      const body = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
      const ext = imageType(body);
      if (!ext) throw httpError(400, "Upload a JPEG, PNG or WebP photo (up to 8 MB).", "NOT_AN_IMAGE");
      await mkdir(dir, { recursive: true });
      const name = `${randomBytes(12).toString("hex")}.${ext}`;
      await writeFile(path.join(dir, name), body, { flag: "wx" });
      const base = (config.PUBLIC_BASE_URL || `${req.protocol}://${req.get("host")}`).replace(/\/$/, "");
      res.status(201).json({ url: `${base}/media/${name}` });
    }),
  );
  return router;
}
