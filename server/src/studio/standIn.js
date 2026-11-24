// Development and tests only (STUDIO_STAND_IN=true): the studio without the Anthropic and Photoroom
// accounts. Photos come back unchanged and the write-up is a template marked as such, so the screens,
// jobs and "apply to style" can be tried end to end. Never used in production (config refuses it).

export function createStandInImages() {
  return {
    name: "stand-in",
    async render({ image }) {
      return { buffer: image.buffer, mediaType: image.mediaType };
    },
  };
}

export function createStandInCopywriter() {
  return {
    name: "stand-in",
    async write({ context }) {
      const name = context.styleName || "New arrival";
      const sizes = context.sizes?.length ? ` Sizes ${context.sizes.join(", ")}.` : "";
      return {
        name,
        category: "other",
        outfitPart: "other",
        colour: "",
        pattern: "",
        fabricLooksLike: "",
        neckline: "",
        sleeve: "",
        fit: "",
        occasion: [],
        websiteDescription: `[Stand-in write-up: connect Claude for the real one] ${name} from ${context.brandName || "the boutique"}, picked by hand in small batches.${context.notes ? ` Notes: ${context.notes}` : ""}`,
        highlights: ["Picked by hand", "Small batch"],
        instagramCaption: `New in: ${name}.\nDM us or WhatsApp to order.${sizes}`,
        hashtags: [...(context.hashtags || []), "NewIn"],
        altText: `Photo of the ${name.toLowerCase()}`,
        toCheck: ["This is a stand-in write-up: connect Claude (ANTHROPIC_API_KEY) for a real one"],
        writtenBy: "stand-in",
      };
    },
  };
}
