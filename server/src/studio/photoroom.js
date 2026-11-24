import { RetryableError } from "../jobs/queue.js";

// Product photos through Photoroom's image editing API (POST /v2/edit, the brand's own API key):
//   white   - background removed, white, soft shadow, 4:5 (website, Meta catalogue)
//   studio  - the brand's backdrop colour, soft shadow, 4:5 at Instagram's 1080x1350
//   model   - the piece on an AI model in a studio scene (generated: staff check it matches)
//   ghost   - ghost mannequin, the piece shown as if worn (generated: staff check it matches)
// The answer is the image itself.

export const KIND_LABEL = { white: "Clean white", studio: "Brand backdrop", model: "On a model (AI)", ghost: "Ghost mannequin (AI)" };
export const GENERATED_KINDS = new Set(["model", "ghost"]);

export function editFields(kind, { backdrop = "F4ECE6" } = {}) {
  switch (kind) {
    case "white":
      return { removeBackground: "true", "background.color": "FFFFFF", padding: "0.08", "shadow.mode": "ai.soft", outputSize: "1200x1500" };
    case "studio":
      return { removeBackground: "true", "background.color": backdrop.toUpperCase(), padding: "0.1", "shadow.mode": "ai.soft", outputSize: "1080x1350" };
    case "model":
      return { removeBackground: "false", referenceBox: "originalImage", "virtualModel.mode": "ai.auto", "virtualModel.scene.preset.name": "studio", "virtualModel.pose": "standing", "virtualModel.size": "PORTRAIT_HD_3_2" };
    case "ghost":
      return { "ghostMannequin.mode": "ai.auto", "ghostMannequin.size": "PORTRAIT_HD_4_3" };
    default:
      throw new Error(`Unknown studio photo kind "${kind}"`);
  }
}

export function photoroomFromConfig(config, fetchImpl = fetch) {
  if (!config.PHOTOROOM_API_KEY) return null;
  return createPhotoroomClient({ base: config.PHOTOROOM_API_BASE, apiKey: config.PHOTOROOM_API_KEY, fetchImpl });
}

export function createPhotoroomClient({ base, apiKey, fetchImpl = fetch }) {
  const url = `${base.replace(/\/$/, "")}/v2/edit`;
  return {
    name: "photoroom",
    /** Returns { buffer, mediaType } for `kind`, made from `image` ({ buffer, mediaType, name }). */
    async render({ image, kind, backdrop }) {
      const form = new FormData();
      form.append("imageFile", new Blob([image.buffer], { type: image.mediaType }), image.name || "photo.jpg");
      for (const [key, value] of Object.entries(editFields(kind, { backdrop }))) form.append(key, value);
      let response;
      try {
        response = await fetchImpl(url, { method: "POST", headers: { "x-api-key": apiKey }, body: form });
      } catch (error) {
        throw new RetryableError(`Photoroom could not be reached (${error.message})`);
      }
      const type = response.headers.get("content-type") || "";
      if (response.ok && type.startsWith("image/")) return { buffer: Buffer.from(await response.arrayBuffer()), mediaType: type.split(";")[0] };
      const text = await response.text().catch(() => "");
      let detail = text.slice(0, 300);
      try {
        const data = JSON.parse(text);
        detail = data.detail || data.message || data.error?.message || detail;
      } catch {
        /* not JSON */
      }
      if (response.status === 429 || response.status >= 500) throw new RetryableError(`Photoroom is busy (${response.status}); trying again shortly`);
      if (response.status === 401 || response.status === 403) throw Object.assign(new Error("Photoroom refused the API key. Check PHOTOROOM_API_KEY on the server."), { permanent: true });
      if (response.status === 402) throw Object.assign(new Error("Photoroom says the account is out of image credits."), { permanent: true });
      throw Object.assign(new Error(`Photoroom could not make this photo: ${detail || response.status}`), { permanent: true });
    },
  };
}
