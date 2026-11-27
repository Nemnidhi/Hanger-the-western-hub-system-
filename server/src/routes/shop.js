import express from "express";
import mongoose from "mongoose";
import { z } from "zod";
import { Order, getSettings } from "../models/index.js";
import { withTransaction } from "../db.js";
import { httpError, parseBody, route } from "./validate.js";
import * as orders from "../commerce/orders.js";
import { schedulePicksFollowUp } from "../commerce/picksSend.js";
import {
  accountView,
  bagLeft,
  clearShopCookie,
  customerFor,
  customerOrder,
  endCustomerSession,
  googleFeed,
  placeWebsiteOrder,
  sendLoginCode,
  setShopCookie,
  shopCatalog,
  shopInfo,
  shopQuote,
  shopSearch,
  shopStyle,
  verifyLoginCode,
} from "../commerce/shop.js";

// The website storefront's API (/api/shop/...). Reading the collection is public; the bag's price is
// public too (members' prices and points need her signed in); orders and the account need her
// website session (a WhatsApp code). The website's own server forwards these calls, so the cookie is
// first-party; changes still need the app header like every other /api call.

const items = z.array(z.object({ skuCode: z.string().trim().min(3).max(40), qty: z.number().int().min(1).max(20) })).min(1).max(30);

export function createShopRouter({ config, services }) {
  const router = express.Router();
  const tenantId = config.TENANT_ID;
  const razorpayReady = Boolean(services?.razorpay);
  const secure = config.NODE_ENV === "production";
  const standIn = config.SHOP_CODE_STAND_IN && config.NODE_ENV !== "production";

  const signedIn = async (req) => {
    const found = await customerFor(req, { tenantId });
    if (!found) throw httpError(401, "Please sign in with your WhatsApp number");
    return found.contact;
  };

  router.get("/api/shop/info", route(async (req, res) => res.json(await shopInfo({ tenantId, razorpayReady }))));

  router.get("/api/shop/catalog", route(async (req, res) => {
    const query = z.object({ category: z.string().max(40).default(""), size: z.string().max(12).default(""), occasion: z.string().max(40).default(""), sale: z.string().optional(), sort: z.enum(["new", "price_low", "price_high"]).default("new") }).parse(req.query);
    res.json(await shopCatalog({ tenantId, ...query, sale: query.sale === "1" }));
  }));

  router.get("/api/shop/styles/:code", route(async (req, res) => res.json(await shopStyle({ tenantId, code: req.params.code }))));

  router.get("/api/shop/search", route(async (req, res) => res.json(await shopSearch({ tenantId, q: String(req.query.q || "").slice(0, 100) }))));

  // ---- Sign-in -------------------------------------------------------------------------------------
  router.post("/api/shop/login/code", route(async (req, res) => {
    const body = parseBody(z.object({ phone: z.string().max(20) }), req);
    const result = await sendLoginCode({ tenantId, phone: body.phone, ip: req.ip, standIn, withTransaction });
    res.json({ sent: true, via: result.via, ...(result.devCode ? { devCode: result.devCode } : {}) });
  }));

  router.post("/api/shop/login/verify", route(async (req, res) => {
    const body = parseBody(z.object({ phone: z.string().max(20), code: z.string().max(10), offers: z.boolean().default(false) }), req);
    const { token, contact } = await verifyLoginCode({ tenantId, phone: body.phone, code: body.code, offers: body.offers, userAgent: req.get("user-agent") || "" });
    setShopCookie(res, token, { secure });
    res.json({ account: await accountView({ tenantId, contact }) });
  }));

  router.post("/api/shop/logout", route(async (req, res) => {
    await endCustomerSession(req, { tenantId });
    clearShopCookie(res, { secure });
    res.json({ ok: true });
  }));

  router.get("/api/shop/me", route(async (req, res) => {
    const found = await customerFor(req, { tenantId });
    res.json({ account: found ? await accountView({ tenantId, contact: found.contact }) : null });
  }));

  router.patch("/api/shop/me", route(async (req, res) => {
    const contact = await signedIn(req);
    const body = parseBody(z.object({ name: z.string().trim().max(80).optional(), usualSize: z.string().trim().toUpperCase().max(12).optional(), waist: z.string().trim().max(4).optional(), offers: z.boolean().optional() }), req);
    if (body.name !== undefined) contact.name = body.name;
    if (body.usualSize !== undefined) contact.set("fit.usualSize", body.usualSize);
    if (body.waist !== undefined) contact.set("fit.waist", body.waist);
    if (body.offers !== undefined && body.offers !== Boolean(contact.consents?.offers?.given)) {
      contact.set("consents.offers", { given: body.offers, at: new Date(), source: "website:account", askedAt: contact.consents?.offers?.askedAt || new Date() });
    }
    await contact.save();
    res.json({ account: await accountView({ tenantId, contact }) });
  }));

  // ---- The bag and orders --------------------------------------------------------------------------
  router.post("/api/shop/quote", route(async (req, res) => {
    const body = parseBody(z.object({ items, code: z.string().trim().max(20).default(""), redeem: z.number().int().min(0).max(1_000_000).default(0) }), req);
    const found = await customerFor(req, { tenantId });
    res.json(await shopQuote({ tenantId, contact: found?.contact || null, items: body.items, code: body.code, redeem: body.redeem, razorpayReady }));
  }));

  // She signed in and left pieces in her bag: the automatic picks may follow on WhatsApp (if she agreed).
  router.post("/api/shop/bag-left", route(async (req, res) => {
    const contact = await signedIn(req);
    const body = parseBody(z.object({ pieces: z.array(z.string().max(40)).max(30) }), req);
    const job = await bagLeft({ tenantId, contact, pieces: body.pieces, schedulePicksFollowUp });
    res.json({ queued: Boolean(job) });
  }));

  router.post("/api/shop/orders", route(async (req, res) => {
    const contact = await signedIn(req);
    const body = parseBody(
      z.object({
        items,
        address: z.object({ name: z.string().trim().min(2, "Your name for delivery").max(80), address: z.string().trim().min(10, "The full delivery address").max(400), pincode: z.string().trim().regex(/^[1-9]\d{5}$/, "a 6-digit pincode") }),
        method: z.enum(["prepaid", "cod"]),
        code: z.string().trim().max(20).default(""),
        redeem: z.number().int().min(0).max(1_000_000).default(0),
        // Kept by the site from her first visit (utm_* and Meta's fbclid), for the Ads page and Meta.
        attribution: z
          .object({
            source: z.string().trim().toLowerCase().max(60).default(""),
            medium: z.string().trim().toLowerCase().max(60).default(""),
            campaign: z.string().trim().max(120).default(""),
            content: z.string().trim().max(120).default(""),
            fbclid: z.string().trim().regex(/^[\w-]{0,500}$/).default(""),
            landedAt: z.iso.datetime().optional(),
          })
          .optional(),
      }),
      req,
    );
    const attribution = body.attribution && (body.attribution.source || body.attribution.campaign || body.attribution.fbclid)
      ? { ...body.attribution, landedAt: body.attribution.landedAt ? new Date(body.attribution.landedAt) : null, ip: String(req.ip || "").slice(0, 60), userAgent: String(req.get("user-agent") || "").slice(0, 300) }
      : { ip: String(req.ip || "").slice(0, 60), userAgent: String(req.get("user-agent") || "").slice(0, 300) };
    const order = await withTransaction((session) => placeWebsiteOrder({ tenantId, contact, items: body.items, address: body.address, method: body.method, code: body.code, redeem: body.redeem, attribution, razorpayReady, session }));
    res.status(201).json({ order: customerOrder(order, await getSettings(tenantId)) });
  }));

  router.get("/api/shop/orders", route(async (req, res) => {
    const contact = await signedIn(req);
    const settings = await getSettings(tenantId);
    const list = await Order.find({ tenantId, contactId: contact._id, status: mongoose.trusted({ $ne: "draft" }) }).sort({ createdAt: -1 }).limit(50);
    res.json({ orders: list.map((order) => customerOrder(order, settings)) });
  }));

  async function herOrder(req) {
    const contact = await signedIn(req);
    if (!/^[0-9a-f]{24}$/i.test(req.params.id)) throw httpError(404, "Order not found");
    const order = await Order.findOne({ _id: req.params.id, tenantId, contactId: contact._id });
    if (!order) throw httpError(404, "Order not found");
    return order;
  }

  router.get("/api/shop/orders/:id", route(async (req, res) => {
    const order = await herOrder(req);
    res.json({ order: customerOrder(order, await getSettings(tenantId)) });
  }));

  // Medium-risk COD: she confirms on the page. High risk stays prepay-only (confirmOrder refuses).
  router.post("/api/shop/orders/:id/confirm-cod", route(async (req, res) => {
    const found = await herOrder(req);
    if (found.payment.method !== "cod" || found.status !== "awaiting_confirmation") throw httpError(409, "This order is not waiting for a cash-on-delivery confirmation.");
    const order = await withTransaction(async (session) => orders.confirmOrder({ tenantId, order: await Order.findById(found._id).session(session), by: "customer", session }));
    res.json({ order: customerOrder(order, await getSettings(tenantId)) });
  }));

  router.post("/api/shop/orders/:id/pay-online", route(async (req, res) => {
    const found = await herOrder(req);
    const order = await withTransaction(async (session) => orders.choosePayment({ tenantId, order: await Order.findById(found._id).session(session), method: "prepaid", razorpayReady, by: "customer", session }));
    res.json({ order: customerOrder(order, await getSettings(tenantId)) });
  }));

  router.post("/api/shop/orders/:id/cancel", route(async (req, res) => {
    const found = await herOrder(req);
    if (!["awaiting_payment", "awaiting_confirmation"].includes(found.status)) throw httpError(409, "This order can no longer be cancelled here. Message us on WhatsApp.");
    const order = await withTransaction(async (session) => orders.cancelOrder({ tenantId, order: await Order.findById(found._id).session(session), by: "customer", reason: "cancelled on the website", session }));
    res.json({ order: customerOrder(order, await getSettings(tenantId)) });
  }));

  return router;
}

/** Public feeds outside /api: the Google Merchant Center product feed. */
export function createFeedRouter({ config }) {
  const router = express.Router();
  router.get("/feeds/google-products.xml", route(async (req, res) => {
    if (!config.PUBLIC_STORE_URL) return res.status(404).type("text/plain").send("Set PUBLIC_STORE_URL (the website's address) first.");
    res.set("Cache-Control", "public, max-age=1800");
    res.type("application/xml").send(await googleFeed({ tenantId: config.TENANT_ID, siteUrl: config.PUBLIC_STORE_URL }));
  }));
  return router;
}
