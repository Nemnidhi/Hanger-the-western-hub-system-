import http from "node:http";
import { createHmac } from "node:crypto";
import mongoose from "mongoose";
import { loadConfig } from "../src/config.js";
import { connectDb } from "../src/db.js";
import "../src/models/index.js";

// Tests run against a real MongoDB replica set (transactions are part of what is being tested).
// Default: the development replica set from the README, on port 27027.
export const TEST_MONGODB_URI = process.env.TEST_MONGODB_URI || "mongodb://127.0.0.1:27027/hanger_test?replicaSet=rs0";

export function testConfig(overrides = {}) {
  return loadConfig({
    NODE_ENV: "test",
    LOG_LEVEL: "silent",
    MONGODB_URI: TEST_MONGODB_URI,
    TENANT_ID: "test-hanger",
    WHATSAPP_APP_SECRET: "test-app-secret-0123456789",
    WHATSAPP_VERIFY_TOKEN: "test-verify-token-0123456789",
    WHATSAPP_ACCESS_TOKEN: "test-access-token",
    WHATSAPP_PHONE_NUMBER_ID: "1234567890",
    DATA_ENCRYPTION_KEY: "0".repeat(64),
    PUBLIC_STORE_URL: "https://store.hanger.test",
    ...overrides,
  });
}

export async function connectTestDb() {
  // Drop first, then build the indexes: the unique indexes are what the duplicate-handling tests rely on.
  await connectDb(TEST_MONGODB_URI, { buildIndexes: false });
  await mongoose.connection.db.dropDatabase();
  await Promise.all(Object.values(mongoose.models).map((model) => model.createIndexes()));
}

export async function clearCollections() {
  await Promise.all(Object.values(mongoose.models).map((model) => model.deleteMany({})));
}

export function listen(server) {
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve(`http://127.0.0.1:${server.address().port}`));
  });
}

/** A stand-in for Meta's Graph API: records requests and answers with queued responses. */
export async function startFakeMeta() {
  const requests = [];
  const queued = [];
  const getRoutes = [];
  let counter = 0;
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      if (req.method === "GET") {
        const handler = getRoutes.find((route) => req.url.startsWith(route.prefix));
        if (handler) return handler.respond(req, res, baseUrl);
        res.writeHead(404, { "content-type": "application/json" });
        return res.end(JSON.stringify({ error: { code: 100, message: "Unknown path" } }));
      }
      requests.push({ url: req.url, auth: req.headers.authorization, body: body ? JSON.parse(body) : null });
      const next = queued.shift();
      if (next) {
        res.writeHead(next.status, { "content-type": "application/json" });
        return res.end(JSON.stringify(next.body));
      }
      counter += 1;
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ messaging_product: "whatsapp", messages: [{ id: `wamid.out.${counter}` }] }));
    });
  });
  const baseUrl = await listen(server);
  return {
    baseUrl,
    requests,
    respondNext: (status, body) => queued.push({ status, body }),
    /** Answers GET requests whose path starts with `prefix`: respond(req, res, baseUrl). */
    onGet: (prefix, respond) => getRoutes.unshift({ prefix, respond }),
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

export function sign(rawBody, secret) {
  return `sha256=${createHmac("sha256", secret).update(rawBody).digest("hex")}`;
}

export function inboundTextPayload({ phoneNumberId = "1234567890", from = "919800000001", id = "wamid.in.1", text = "Hello", name = "Asha", timestamp = Math.floor(Date.now() / 1000) } = {}) {
  return {
    object: "whatsapp_business_account",
    entry: [
      {
        id: "waba-1",
        changes: [
          {
            field: "messages",
            value: {
              messaging_product: "whatsapp",
              metadata: { phone_number_id: phoneNumberId, display_phone_number: "919999999999" },
              contacts: [{ wa_id: from, profile: { name } }],
              messages: [{ id, from, timestamp: String(timestamp), type: "text", text: { body: text } }],
            },
          },
        ],
      },
    ],
  };
}

export function statusPayload({ phoneNumberId = "1234567890", id, status, errors, timestamp = Math.floor(Date.now() / 1000) }) {
  return {
    object: "whatsapp_business_account",
    entry: [
      {
        id: "waba-1",
        changes: [
          {
            field: "messages",
            value: {
              messaging_product: "whatsapp",
              metadata: { phone_number_id: phoneNumberId },
              statuses: [{ id, status, timestamp: String(timestamp), recipient_id: "919800000001", ...(errors ? { errors } : {}) }],
            },
          },
        ],
      },
    ],
  };
}

/** A cookie-keeping API client for the staff app's API. */
export function apiClient(baseUrl) {
  let cookie = "";
  async function api(path, { method = "GET", body, appHeader = true } = {}) {
    const headers = {};
    if (body !== undefined) headers["content-type"] = "application/json";
    if (appHeader) headers["x-hanger-app"] = "1";
    if (cookie) headers.cookie = cookie;
    const response = await fetch(`${baseUrl}${path}`, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined });
    for (const line of response.headers.getSetCookie()) {
      const [pair] = line.split(";");
      const [name, value] = pair.split("=");
      if (name === "hh_session") cookie = value ? `hh_session=${value}` : "";
    }
    const text = await response.text();
    let data = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = text;
    }
    return { status: response.status, data, headers: response.headers };
  }
  api.cookie = () => cookie;
  api.setCookie = (value) => (cookie = value);
  return api;
}

/** A WhatsApp catalogue cart ("order" message) as Meta sends it. */
export function inboundCartPayload({ phoneNumberId = "1234567890", from = "919800000001", id = "wamid.cart.1", name = "Asha", items = [], timestamp = Math.floor(Date.now() / 1000) } = {}) {
  const payload = inboundTextPayload({ phoneNumberId, from, id, name, timestamp });
  payload.entry[0].changes[0].value.messages = [{
    id, from, timestamp: String(timestamp), type: "order",
    order: { catalog_id: "999", product_items: items.map(({ skuCode, qty, pricePaise = 0 }) => ({ product_retailer_id: skuCode, quantity: qty, item_price: pricePaise / 100, currency: "INR" })) },
  }];
  return payload;
}

/** A tap on a reply button. */
export function inboundButtonPayload({ phoneNumberId = "1234567890", from = "919800000001", id, buttonId, title = "", timestamp = Math.floor(Date.now() / 1000) } = {}) {
  const payload = inboundTextPayload({ phoneNumberId, from, id, timestamp });
  payload.entry[0].changes[0].value.messages = [{ id, from, timestamp: String(timestamp), type: "interactive", interactive: { type: "button_reply", button_reply: { id: buttonId, title } } }];
  return payload;
}
