import test from "node:test";
import assert from "node:assert/strict";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import { CopySchema, createClaudeCopywriter } from "../src/studio/copywriter.js";
import { createPhotoroomClient, editFields } from "../src/studio/photoroom.js";
import { mediaFile } from "../src/studio/studio.js";
import { RetryableError } from "../src/jobs/queue.js";

// The studio's two outside services, without the network: what is sent, and how answers and errors are read.

const COPY = {
  name: "Satin slip dress", category: "dresses", outfitPart: "dress", colour: "wine", pattern: "solid", fabricLooksLike: "satin-finish",
  neckline: "cowl", sleeve: "strappy", fit: "bias cut", occasion: ["date", "party"], websiteDescription: "A wine slip dress...", highlights: ["Bias cut"],
  instagramCaption: "Date night, sorted.", hashtags: ["TheHangerIndore"], altText: "A wine satin slip dress on a hanger", toCheck: ["Fabric: looks like satin, please confirm"],
};

test("the write-up schema turns into a structured-output format", () => {
  const format = betaZodOutputFormat(CopySchema);
  assert.equal(format.type, "json_schema");
  assert.ok(format.schema.properties.instagramCaption);
  assert.deepEqual(CopySchema.parse(COPY), COPY);
});

test("Claude copywriter: sends the photos and facts, asks for fallbacks, reads the parsed answer", async () => {
  const calls = [];
  const client = { beta: { messages: { parse: async (params) => (calls.push(params), { stop_reason: "end_turn", parsed_output: COPY, model: "claude-opus-5-5" }) } } };
  const writer = createClaudeCopywriter({ client });
  const copy = await writer.write({ images: [{ mediaType: "image/jpeg", base64: "AAAA" }], context: { brandName: "The Hanger", hashtags: ["TheHangerIndore"], notes: "rayon, lined", sizes: ["S", "M"], price: "Rs 2,499" } });
  assert.equal(copy.name, "Satin slip dress");
  assert.equal(copy.writtenBy, "claude-opus-5-5");
  const [params] = calls;
  assert.equal(params.model, "claude-opus-5-5");
  assert.equal(params.fallbacks, "default");
  assert.deepEqual(params.betas, ["server-side-fallback-2026-07-01"]);
  assert.equal(params.output_config.format.type, "json_schema");
  const [image, text] = params.messages[0].content;
  assert.deepEqual(image, { type: "image", source: { type: "base64", media_type: "image/jpeg", data: "AAAA" } });
  assert.match(text.text, /Staff notes: rayon, lined/);
  assert.match(text.text, /Sizes: S, M/);
  assert.match(params.system, /Describe only what the photos show/);
});

test("Claude copywriter: a refusal stops with a reason; an incomplete answer is retried", async () => {
  const refuse = createClaudeCopywriter({ client: { beta: { messages: { parse: async () => ({ stop_reason: "refusal", stop_details: { explanation: "unclear image" }, parsed_output: null }) } } } });
  await assert.rejects(refuse.write({ images: [], context: {} }), (error) => error.permanent && /declined/.test(error.message));
  const cut = createClaudeCopywriter({ client: { beta: { messages: { parse: async () => ({ stop_reason: "max_tokens", parsed_output: null }) } } } });
  await assert.rejects(cut.write({ images: [], context: {} }), RetryableError);
});

test("Photoroom: the fields for each kind, the image back, and its errors", async () => {
  assert.equal(editFields("white")["background.color"], "FFFFFF");
  assert.equal(editFields("studio", { backdrop: "f4ece6" })["background.color"], "F4ECE6");
  assert.equal(editFields("model")["virtualModel.mode"], "ai.auto");
  assert.equal(editFields("ghost")["ghostMannequin.mode"], "ai.auto");
  const sent = [];
  const answers = [new Response(Buffer.from("PNGDATA"), { status: 200, headers: { "content-type": "image/png" } }), new Response(JSON.stringify({ detail: "No credits" }), { status: 402, headers: { "content-type": "application/json" } }), new Response("busy", { status: 503 })];
  const fetchImpl = async (url, init) => (sent.push({ url, init }), answers.shift());
  const client = createPhotoroomClient({ base: "https://image-api.photoroom.test", apiKey: "test-key-123", fetchImpl });
  const image = { buffer: Buffer.from("JPEG"), mediaType: "image/jpeg", name: "a.jpg" };
  const made = await client.render({ image, kind: "white" });
  assert.equal(made.mediaType, "image/png");
  assert.equal(made.buffer.toString(), "PNGDATA");
  assert.equal(sent[0].url, "https://image-api.photoroom.test/v2/edit");
  assert.equal(sent[0].init.headers["x-api-key"], "test-key-123");
  assert.equal(sent[0].init.body.get("shadow.mode"), "ai.soft");
  assert.ok(sent[0].init.body.get("imageFile") instanceof Blob);
  await assert.rejects(client.render({ image, kind: "white" }), (error) => error.permanent && /credits/.test(error.message));
  await assert.rejects(client.render({ image, kind: "white" }), RetryableError);
});

test("only the shop's own uploads are read", () => {
  const config = { UPLOAD_DIR: "/data/uploads" };
  assert.equal(mediaFile(config, "http://localhost:4200/media/abc123.jpg").name, "abc123.jpg");
  assert.equal(mediaFile(config, "https://evil.test/media/../../etc/passwd"), null);
  assert.equal(mediaFile(config, "/media/x.exe"), null);
});
