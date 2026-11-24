import "dotenv/config";
import { z } from "zod";

// Optional settings may be left empty in the .env file; empty means "not set".
const optional = (schema) => z.preprocess((value) => (value === "" ? undefined : value), schema.optional());

// Every setting is checked once, at start-up. A missing or malformed value stops the process with a
// clear message instead of surfacing later as a failed order or a lost WhatsApp message.
const schema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().positive().default(4200),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"]).default("info"),
  MONGODB_URI: z.string().min(1, "MONGODB_URI is required"),
  TENANT_ID: z.string().regex(/^[a-z0-9-]{2,40}$/, "TENANT_ID: lowercase letters, digits and dashes"),

  // The brand's own Meta app and WhatsApp number (Nemnidhi connects as tech partner).
  WHATSAPP_APP_SECRET: z.string().min(16, "WHATSAPP_APP_SECRET looks too short"),
  WHATSAPP_VERIFY_TOKEN: z.string().min(16, "WHATSAPP_VERIFY_TOKEN must be at least 16 characters"),
  WHATSAPP_ACCESS_TOKEN: z.string().min(1, "WHATSAPP_ACCESS_TOKEN is required"),
  WHATSAPP_PHONE_NUMBER_ID: z.string().regex(/^\d+$/, "WHATSAPP_PHONE_NUMBER_ID is Meta's numeric id"),
  WHATSAPP_BUSINESS_ACCOUNT_ID: optional(z.string().regex(/^\d+$/, "WHATSAPP_BUSINESS_ACCOUNT_ID is Meta's numeric id")),
  // The Meta commerce catalogue that WhatsApp and Instagram show. Empty: no catalogue sync.
  META_CATALOG_ID: optional(z.string().regex(/^\d+$/, "META_CATALOG_ID is Meta's numeric id")),
  META_GRAPH_VERSION: z.string().regex(/^v\d+\.\d+$/).default("v24.0"),
  // Only tests point this elsewhere (a local stand-in for Meta).
  META_GRAPH_BASE: z.url().default("https://graph.facebook.com"),

  // 32 random bytes as 64 hex characters: encrypts staff two-step login secrets.
  DATA_ENCRYPTION_KEY: z.string().regex(/^[0-9a-fA-F]{64}$/, "DATA_ENCRYPTION_KEY must be 64 hex characters (32 bytes)"),
  WORKER_CONCURRENCY: z.coerce.number().int().min(1).max(32).default(4),
  // Folder with the built staff app. When set, the API process serves it too.
  WEB_DIST_DIR: optional(z.string()),
  // The brand's website, used for product links in the Meta catalogue (e.g. https://thehanger.in).
  PUBLIC_STORE_URL: optional(z.url()),
  // This server's own public address (product photos are served from it, and Meta fetches them).
  PUBLIC_BASE_URL: optional(z.url()),
  // Where uploaded product photos are kept.
  UPLOAD_DIR: z.string().default("../.data/uploads"),

  // Payment gateway: Razorpay on the brand's own account. Without these, cash on delivery only.
  RAZORPAY_KEY_ID: optional(z.string()),
  RAZORPAY_KEY_SECRET: optional(z.string()),
  RAZORPAY_WEBHOOK_SECRET: optional(z.string().min(8)),
  RAZORPAY_API_BASE: z.url().default("https://api.razorpay.com"),

  // SMS backup for order updates when WhatsApp cannot deliver. India needs DLT registration.
  SMS_PROVIDER: z.enum(["none", "msg91"]).default("none"),
  MSG91_AUTH_KEY: optional(z.string().min(8)),
  MSG91_TEMPLATE_ORDER_UPDATE: optional(z.string().min(4)),
  MSG91_TEMPLATE_DELIVERY_CODE: optional(z.string().min(4)),
  MSG91_API_BASE: z.url().default("https://control.msg91.com"),

  // Photo studio. Write-ups by Claude (Anthropic API key on the brand's own account); product
  // photos (clean background, shadow, AI model / ghost mannequin) by Photoroom's image editing API.
  // Either can be left empty: that part of the studio says it is not connected.
  ANTHROPIC_API_KEY: optional(z.string().min(20)),
  STUDIO_COPY_MODEL: z.string().default("claude-opus-5-5"),
  PHOTOROOM_API_KEY: optional(z.string().min(10)),
  PHOTOROOM_API_BASE: z.url().default("https://image-api.photoroom.com"),
  // Development and tests only: a local stand-in that returns the photo as it is and a template
  // write-up, so the studio can be tried without either account. Refused in production.
  STUDIO_STAND_IN: z.preprocess((value) => value === "true" || value === true, z.boolean()).default(false),

  // Courier booking through Shiprocket, on the brand's own Shiprocket account. Use a separate API
  // user (Shiprocket > Settings > API), not the main login. "none": tracking numbers are typed in by hand.
  SHIPPING_PROVIDER: z.enum(["none", "shiprocket"]).default("none"),
  SHIPROCKET_EMAIL: optional(z.email()),
  SHIPROCKET_PASSWORD: optional(z.string().min(6)),
  // Sent by Shiprocket as x-api-key on every tracking update (set the same token in its webhook page).
  SHIPROCKET_WEBHOOK_TOKEN: optional(z.string().min(16, "SHIPROCKET_WEBHOOK_TOKEN must be at least 16 characters")),
  // Only tests and the demo point this elsewhere (a local stand-in for Shiprocket).
  SHIPROCKET_API_BASE: z.url().default("https://apiv2.shiprocket.in/v1/external"),
}).superRefine((value, ctx) => {
  const razorpay = [value.RAZORPAY_KEY_ID, value.RAZORPAY_KEY_SECRET, value.RAZORPAY_WEBHOOK_SECRET].filter(Boolean).length;
  if (razorpay && razorpay < 3) ctx.addIssue({ code: "custom", path: ["RAZORPAY_KEY_ID"], message: "Set all three Razorpay settings, or none" });
  if (value.STUDIO_STAND_IN && value.NODE_ENV === "production") ctx.addIssue({ code: "custom", path: ["STUDIO_STAND_IN"], message: "STUDIO_STAND_IN is for development only" });
  if (value.SHIPPING_PROVIDER === "shiprocket") {
    for (const name of ["SHIPROCKET_EMAIL", "SHIPROCKET_PASSWORD", "SHIPROCKET_WEBHOOK_TOKEN"]) {
      if (!value[name]) ctx.addIssue({ code: "custom", path: [name], message: `${name} is required for SHIPPING_PROVIDER=shiprocket` });
    }
  }
  if (value.SMS_PROVIDER === "msg91") {
    for (const name of ["MSG91_AUTH_KEY", "MSG91_TEMPLATE_ORDER_UPDATE", "MSG91_TEMPLATE_DELIVERY_CODE"]) {
      if (!value[name]) ctx.addIssue({ code: "custom", path: [name], message: `${name} is required for SMS_PROVIDER=msg91` });
    }
  }
});

export function loadConfig(env = process.env) {
  const result = schema.safeParse(env);
  if (!result.success) {
    const lines = result.error.issues.map((issue) => `- ${issue.path.join(".") || "config"}: ${issue.message}`);
    throw new Error(`Invalid configuration:\n${lines.join("\n")}`);
  }
  return Object.freeze(result.data);
}
