import Anthropic from "@anthropic-ai/sdk";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import { z } from "zod";
import { RetryableError } from "../jobs/queue.js";

// The write-up for a piece, from its photos: name, attributes for the catalogue and outfit picks,
// the website description, selling points, the Instagram caption and hashtags, and alt text.
// Written by Claude on the brand's own Anthropic account. Only what the photo shows is stated as
// fact; anything else (fabric, lining, stretch) goes to "toCheck" for staff to confirm.

export const CATEGORIES = ["dresses", "tops", "shirts", "t-shirts", "trousers", "jeans", "skirts", "shorts", "co-ords", "jumpsuits", "jackets", "cardigans", "shrugs", "other"];

export const CopySchema = z.object({
  name: z.string().describe("Short product name, 2-5 words, e.g. 'Satin slip dress'"),
  category: z.enum(CATEGORIES),
  outfitPart: z.enum(["dress", "top", "bottom", "layer", "other"]).describe("dress = a whole look (dress, co-ord set, jumpsuit)"),
  colour: z.string().describe("Plain colour words a shopper would use, e.g. 'dusty rose'"),
  pattern: z.string().describe("solid, floral, stripes, checks, block print, ... or '' if unsure"),
  fabricLooksLike: z.string().describe("What the fabric looks like, e.g. 'satin-finish', 'linen-look'; '' if unsure"),
  neckline: z.string(),
  sleeve: z.string(),
  fit: z.string().describe("relaxed, fitted, bodycon, oversized, A-line, straight, ... or ''"),
  occasion: z.array(z.string()).describe("1-3 of: work, brunch, day out, date, party, festive, travel, college, vacation"),
  websiteDescription: z.string().describe("50-90 words for the product page"),
  highlights: z.array(z.string()).describe("3-5 short selling points, under 8 words each"),
  instagramCaption: z.string().describe("Caption without hashtags"),
  hashtags: z.array(z.string()).describe("8-12 hashtags without the # sign"),
  altText: z.string().describe("One plain sentence describing the photo for screen readers"),
  toCheck: z.array(z.string()).describe("Things staff must confirm before publishing"),
});

const SYSTEM = `You write product listings for an Indian western-wear boutique that sells on its own website, Instagram and WhatsApp. Staff send you plain photos of one piece of clothing (on a hanger, flat, or on a person) with a few notes.

Rules:
- Describe only what the photos show. Fabric, composition, lining, stretch, care and measurements are facts only when the staff notes give them. Otherwise put your best reading in fabricLooksLike, write "looks like" or nothing in the copy, and add a line to toCheck such as "Fabric: looks like satin, please confirm".
- Never invent prices, discounts, stock counts, delivery promises or sizes. Use the sizes and price only when the notes give them.
- Indian English, warm and clear, like a stylist talking to a regular customer. No "best", "perfect", "must-have", "elevate" or other filler, and no claims about quality the photo cannot show.
- Website description: 50-90 words. What it is, how it sits, one or two ways to style it.
- Highlights: 3-5 short lines (cut or fit, fabric look, a detail, a styling idea).
- Instagram caption: a short hook on the first line, one or two lines on how to wear it, then a call to action to DM or WhatsApp to order (with the sizes if known). At most two emoji. No hashtags in the caption.
- Hashtags: 8-12 without the # sign, no spaces; include the brand's own hashtags you are given, then specific ones (the piece, the colour, the occasion, the city).
- If the photo shows more than one piece, write about the main piece and say so in toCheck.`;

/** Turns the SDK's errors into the job queue's terms: retry later, or stop with a reason. */
function asJobError(error) {
  if (error instanceof Anthropic.RateLimitError || error instanceof Anthropic.InternalServerError || error instanceof Anthropic.APIConnectionError) {
    return new RetryableError(`Claude is busy (${error.message}); trying again shortly`);
  }
  if (error instanceof Anthropic.AuthenticationError || error instanceof Anthropic.PermissionDeniedError) {
    return Object.assign(new Error("The Anthropic API key was refused. Check ANTHROPIC_API_KEY on the server."), { permanent: true });
  }
  if (error instanceof Anthropic.BadRequestError) {
    return Object.assign(new Error(`Claude could not read this request: ${error.message}`), { permanent: true });
  }
  return error;
}

export function copywriterFromConfig(config) {
  if (!config.ANTHROPIC_API_KEY) return null;
  return createClaudeCopywriter({ client: new Anthropic({ apiKey: config.ANTHROPIC_API_KEY }), model: config.STUDIO_COPY_MODEL });
}

export function createClaudeCopywriter({ client, model = "claude-opus-5-5" }) {
  return {
    name: "claude",
    /**
     * images: [{ mediaType, base64 }], context: { brandName, city, voice, hashtags, notes, styleName, price, sizes }.
     * Returns the CopySchema object.
     */
    async write({ images, context }) {
      const facts = [
        `Brand: ${context.brandName || "the boutique"}${context.city ? `, ${context.city}` : ""}.`,
        context.voice ? `The owner's notes on the brand's voice: ${context.voice}` : "",
        context.hashtags?.length ? `The brand's own hashtags (always include): ${context.hashtags.join(", ")}` : "",
        context.styleName ? `Catalogue name so far: ${context.styleName}` : "",
        context.price ? `Price: ${context.price}` : "",
        context.sizes?.length ? `Sizes: ${context.sizes.join(", ")}` : "",
        context.notes ? `Staff notes: ${context.notes}` : "Staff notes: none.",
      ].filter(Boolean);
      let response;
      try {
        response = await client.beta.messages.parse({
          model,
          max_tokens: 16000,
          betas: ["server-side-fallback-2026-07-01"],
          // If a safety check declines (rare for product photos), the API retries on its own fallback model.
          fallbacks: "default",
          output_config: { effort: "medium", format: betaZodOutputFormat(CopySchema) },
          system: SYSTEM,
          messages: [
            {
              role: "user",
              content: [
                ...images.map((image) => ({ type: "image", source: { type: "base64", media_type: image.mediaType, data: image.base64 } })),
                { type: "text", text: `${facts.join("\n")}\n\nWrite the listing for this piece.` },
              ],
            },
          ],
        });
      } catch (error) {
        throw asJobError(error);
      }
      if (response.stop_reason === "refusal") {
        throw Object.assign(new Error(`Claude declined to describe this photo${response.stop_details?.explanation ? `: ${response.stop_details.explanation}` : ""}. Try a plainer photo of the piece.`), { permanent: true });
      }
      if (response.stop_reason === "max_tokens" || !response.parsed_output) {
        throw new RetryableError("The write-up came back incomplete; trying again");
      }
      return { ...response.parsed_output, writtenBy: response.model };
    },
  };
}
