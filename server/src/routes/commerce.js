import express from "express";
import mongoose from "mongoose";
import { z } from "zod";
import { Invoice, Location, Order, ORDER_STATUSES, Settings, Sku, StockLevel, StockMove, Style, Supplier, getSettings } from "../models/index.js";
import { requireAuth, requirePermission } from "../auth/middleware.js";
import { withTransaction, isDuplicateKeyError } from "../db.js";
import { audit } from "../audit.js";
import { httpError, parseBody, route } from "./validate.js";
import { addSizes, createStyle, updateStyle } from "../commerce/catalog.js";
import { adjustStock, receiveStock, transferStock } from "../commerce/stock.js";
import { GST_STATES } from "../commerce/pincode.js";
import * as orders from "../commerce/orders.js";
import { bookCourier, cancelBooking, courierRates, refreshLabel } from "../shipping/courier.js";

// The staff app's API for the catalogue, stock, orders, invoices and settings.

const rupeesToPaise = z.number().positive().max(10_000_000).transform((rupees) => Math.round(rupees * 100));
const id = z.string().regex(/^[0-9a-f]{24}$/i, "not a valid id");
const items = z.array(z.object({ skuCode: z.string().min(3).max(40), qty: z.number().int().min(1).max(500) })).min(1).max(200);

const styleFields = {
  name: z.string().trim().min(2).max(120),
  category: z.string().trim().min(2).max(40),
  description: z.string().max(2000).optional(),
  attributes: z
    .object({
      colour: z.string().max(40).optional(),
      fabric: z.string().max(40).optional(),
      neckline: z.string().max(40).optional(),
      sleeve: z.string().max(40).optional(),
      fit: z.string().max(40).optional(),
      pattern: z.string().max(40).optional(),
      occasion: z.array(z.string().max(40)).max(10).optional(),
    })
    .optional(),
  images: z.array(z.url()).max(20).optional(),
  price: rupeesToPaise,
  cost: z.number().min(0).max(10_000_000).transform((rupees) => Math.round(rupees * 100)).optional(),
  hsn: z.string().regex(/^\d{4,8}$/).optional(),
  supplierId: id.optional(),
  supplierStyleRef: z.string().max(60).optional(),
};

const toStyleData = ({ price, cost, ...rest }) => ({ ...rest, ...(price !== undefined ? { pricePaise: price } : {}), ...(cost !== undefined ? { costPaise: cost } : {}) });

export function createCommerceRouter({ config, services }) {
  const router = express.Router();
  const tenantId = config.TENANT_ID;
  // A malformed id is "not found", never a database cast error.
  router.param("id", (req, res, next, value) => (mongoose.isValidObjectId(value) ? next() : next(httpError(404, "Not found", "NOT_FOUND"))));
  const razorpayReady = Boolean(services?.razorpay);
  const courier = services?.courier || null;

  async function skusByCode(codes, session) {
    const skus = await Sku.find({ tenantId, code: mongoose.trusted({ $in: codes.map((code) => code.toUpperCase()) }) }).session(session || null);
    const missing = codes.filter((code) => !skus.some((sku) => sku.code === code.toUpperCase()));
    if (missing.length) throw httpError(404, `Unknown size codes: ${missing.join(", ")}`, "UNKNOWN_SKU");
    return (code) => skus.find((sku) => sku.code === code.toUpperCase());
  }

  async function locationByCode(code, session) {
    const location = await Location.findOne({ tenantId, code: String(code).toUpperCase() }).session(session || null);
    if (!location) throw httpError(404, `No location ${code}`, "NO_LOCATION");
    return location;
  }

  // ---- Locations and suppliers -------------------------------------------------------------------
  router.get("/api/locations", requireAuth(), route(async (req, res) => {
    res.json({ locations: await Location.find({ tenantId }).sort({ createdAt: 1 }).lean() });
  }));

  router.post("/api/locations", requireAuth(), requirePermission("settings:write"), route(async (req, res) => {
    const body = parseBody(z.object({ code: z.string().regex(/^[A-Za-z0-9]{2,6}$/), name: z.string().min(2).max(80), kind: z.enum(["store", "warehouse"]).default("store"), address: z.string().max(300).default(""), pincode: z.string().regex(/^[1-9]\d{5}$/).optional(), invoicePrefix: z.string().regex(/^[A-Za-z0-9]{2,4}$/) }), req);
    try {
      const location = await Location.create({ tenantId, ...body });
      await audit({ req, action: "location.create", meta: { locationId: location._id, code: location.code } });
      res.status(201).json({ location });
    } catch (error) {
      if (isDuplicateKeyError(error)) throw httpError(409, "That location code or invoice prefix is already used", "DUPLICATE");
      throw error;
    }
  }));

  router.get("/api/suppliers", requireAuth(), requirePermission("catalog:read"), route(async (req, res) => {
    res.json({ suppliers: await Supplier.find({ tenantId }).sort({ name: 1 }).lean() });
  }));

  router.post("/api/suppliers", requireAuth(), requirePermission("catalog:write"), route(async (req, res) => {
    const body = parseBody(z.object({ name: z.string().trim().min(2).max(120), city: z.string().max(60).default(""), waId: z.string().regex(/^\d{10,15}$/).optional(), notes: z.string().max(1000).default("") }), req);
    try {
      res.status(201).json({ supplier: await Supplier.create({ tenantId, ...body }) });
    } catch (error) {
      if (isDuplicateKeyError(error)) throw httpError(409, "A supplier with that name exists", "DUPLICATE");
      throw error;
    }
  }));

  // ---- Styles and sizes --------------------------------------------------------------------------
  router.get("/api/styles", requireAuth(), requirePermission("catalog:read"), route(async (req, res) => {
    const filter = { tenantId };
    if (["draft", "live", "archived"].includes(req.query.status)) filter.status = req.query.status;
    const styles = await Style.find(filter).sort({ updatedAt: -1 }).limit(500).lean();
    const skus = await Sku.find({ styleId: mongoose.trusted({ $in: styles.map((style) => style._id) }) }).lean();
    const levels = await StockLevel.find({ skuId: mongoose.trusted({ $in: skus.map((sku) => sku._id) }) }).lean();
    res.json({
      styles: styles.map((style) => ({
        ...style,
        sizes: skus.filter((sku) => String(sku.styleId) === String(style._id)).map((sku) => ({
          code: sku.code,
          size: sku.size,
          barcode: sku.barcode || "",
          pricePaise: sku.pricePaise,
          stock: levels.filter((level) => String(level.skuId) === String(sku._id)).map(({ locationId, onHand, reserved, available }) => ({ locationId, onHand, reserved, available })),
        })),
      })),
    });
  }));

  router.post("/api/styles", requireAuth(), requirePermission("catalog:write"), route(async (req, res) => {
    const body = parseBody(z.object({ code: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9-]{2,23}$/), sizes: z.array(z.string().min(1).max(12)).min(1).max(15), ...styleFields }), req);
    const { sizes, ...data } = body;
    const result = await withTransaction((session) => createStyle({ tenantId, data: toStyleData(data), sizes, session }));
    await audit({ req, action: "style.create", meta: { styleId: result.style._id, code: result.style.code } });
    res.status(201).json(result);
  }));

  router.patch("/api/styles/:id", requireAuth(), requirePermission("catalog:write"), route(async (req, res) => {
    const partial = Object.fromEntries(Object.entries(styleFields).map(([key, schema]) => [key, schema.optional()]));
    const body = parseBody(z.object({ ...partial, status: z.enum(["draft", "live", "archived"]).optional(), addSizes: z.array(z.string().min(1).max(12)).max(15).optional() }), req);
    const { addSizes: newSizes, ...changes } = body;
    const style = await withTransaction(async (session) => {
      const found = await Style.findOne({ _id: req.params.id, tenantId }).session(session);
      if (!found) throw httpError(404, "Style not found");
      if (newSizes?.length) await addSizes({ tenantId, style: found, sizes: newSizes, session });
      return updateStyle({ style: found, changes: toStyleData(changes), session });
    });
    await audit({ req, action: "style.update", meta: { styleId: style._id, fields: Object.keys(body) } });
    res.json({ style });
  }));

  router.patch("/api/skus/:code", requireAuth(), requirePermission("catalog:write"), route(async (req, res) => {
    const body = parseBody(z.object({ barcode: z.string().trim().min(4).max(40) }), req);
    try {
      const sku = await Sku.findOneAndUpdate({ tenantId, code: String(req.params.code).toUpperCase() }, { $set: { barcode: body.barcode } }, { new: true });
      if (!sku) throw httpError(404, "Size code not found");
      res.json({ sku });
    } catch (error) {
      if (isDuplicateKeyError(error)) throw httpError(409, "That barcode is on another piece", "DUPLICATE");
      throw error;
    }
  }));

  // ---- Stock -------------------------------------------------------------------------------------
  router.get("/api/stock/moves", requireAuth(), requirePermission("stock:read"), route(async (req, res) => {
    const filter = { tenantId };
    if (req.query.sku) filter.skuCode = String(req.query.sku).toUpperCase();
    res.json({ moves: await StockMove.find(filter).sort({ at: -1 }).limit(200).lean() });
  }));

  router.post("/api/stock/receive", requireAuth(), requirePermission("stock:write"), route(async (req, res) => {
    const body = parseBody(z.object({ location: z.string(), items, supplierId: id.optional(), note: z.string().max(300).default("") }), req);
    await withTransaction(async (session) => {
      const location = await locationByCode(body.location, session);
      const find = await skusByCode(body.items.map((item) => item.skuCode), session);
      await receiveStock({ tenantId, locationId: location._id, items: body.items.map((item) => ({ sku: find(item.skuCode), qty: item.qty })), supplierId: body.supplierId || null, by: req.user.name, note: body.note, session });
    });
    await audit({ req, action: "stock.receive", meta: { location: body.location, pieces: body.items.reduce((total, item) => total + item.qty, 0) } });
    res.json({ ok: true });
  }));

  router.post("/api/stock/count", requireAuth(), requirePermission("stock:write"), route(async (req, res) => {
    const body = parseBody(z.object({ location: z.string(), skuCode: z.string(), counted: z.number().int().min(0).max(100000), note: z.string().min(2).max(300) }), req);
    const change = await withTransaction(async (session) => {
      const location = await locationByCode(body.location, session);
      const find = await skusByCode([body.skuCode], session);
      return adjustStock({ tenantId, locationId: location._id, sku: find(body.skuCode), counted: body.counted, by: req.user.name, note: body.note, session });
    });
    await audit({ req, action: "stock.count", meta: { skuCode: body.skuCode, change } });
    res.json({ change });
  }));

  router.post("/api/stock/transfer", requireAuth(), requirePermission("stock:write"), route(async (req, res) => {
    const body = parseBody(z.object({ from: z.string(), to: z.string(), items, note: z.string().max(300).default("") }), req);
    await withTransaction(async (session) => {
      const [from, to] = [await locationByCode(body.from, session), await locationByCode(body.to, session)];
      const find = await skusByCode(body.items.map((item) => item.skuCode), session);
      await transferStock({ tenantId, fromLocationId: from._id, toLocationId: to._id, items: body.items.map((item) => ({ sku: find(item.skuCode), qty: item.qty })), by: req.user.name, note: body.note, session });
    });
    await audit({ req, action: "stock.transfer", meta: { from: body.from, to: body.to } });
    res.json({ ok: true });
  }));

  // ---- Orders ------------------------------------------------------------------------------------
  // Filters: status (one, or "open" / "to_ship" / "done"), channel, conversationId, q (order number,
  // phone or name).
  const STATUS_GROUPS = {
    open: ["draft", "awaiting_payment", "awaiting_confirmation"],
    to_ship: ["confirmed", "packed"],
    done: ["shipped", "delivered", "rto", "returned", "cancelled"],
  };
  router.get("/api/orders", requireAuth(), requirePermission("orders:read"), route(async (req, res) => {
    const filter = { tenantId };
    const status = String(req.query.status || "");
    if (ORDER_STATUSES.includes(status)) filter.status = status;
    else if (STATUS_GROUPS[status]) filter.status = mongoose.trusted({ $in: STATUS_GROUPS[status] });
    if (["whatsapp", "website", "store", "phone", "marketplace"].includes(req.query.channel)) filter.channel = req.query.channel;
    if (mongoose.isValidObjectId(req.query.conversationId)) filter.conversationId = req.query.conversationId;
    const q = String(req.query.q || "").trim().slice(0, 60);
    if (q) {
      const number = Number(q.replace(/^[A-Za-z]+-?/, ""));
      const digits = q.replace(/\D/g, "");
      const escaped = q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const or = [{ "customer.name": mongoose.trusted({ $regex: escaped, $options: "i" }) }, { "shipTo.name": mongoose.trusted({ $regex: escaped, $options: "i" }) }];
      if (Number.isInteger(number) && number > 0) or.push({ number });
      if (digits.length >= 4) or.push({ "customer.phone": mongoose.trusted({ $regex: `${digits}$` }) });
      filter.$or = mongoose.trusted(or);
    }
    const settings = await getSettings(tenantId);
    res.json({ prefix: settings.orderPrefix, orders: await Order.find(filter).sort({ createdAt: -1 }).limit(200).select("-history").lean() });
  }));

  // The day at a glance: what needs doing, and today's sales (invoices less credit notes, India time).
  router.get("/api/summary", requireAuth(), requirePermission("orders:read"), route(async (req, res) => {
    const istMidnight = new Date(Math.floor((Date.now() + 330 * 60_000) / 86_400_000) * 86_400_000 - 330 * 60_000);
    const counts = await Order.aggregate([{ $match: { tenantId } }, { $group: { _id: "$status", n: { $sum: 1 } } }]);
    const byStatus = Object.fromEntries(counts.map((row) => [row._id, row.n]));
    const sales = await Invoice.aggregate([
      { $match: { tenantId, date: mongoose.trusted({ $gte: istMidnight }) } },
      { $lookup: { from: "orders", localField: "orderId", foreignField: "_id", as: "order" } },
      { $group: { _id: { kind: "$kind", channel: { $first: "$order.channel" } }, totalPaise: { $sum: "$totals.totalPaise" }, n: { $sum: 1 } } },
    ]);
    const today = { storePaise: 0, onlinePaise: 0, returnsPaise: 0, invoices: 0 };
    for (const row of sales) {
      if (row._id.kind === "credit_note") today.returnsPaise += row.totalPaise;
      else {
        today.invoices += row.n;
        if (row._id.channel === "store") today.storePaise += row.totalPaise;
        else today.onlinePaise += row.totalPaise;
      }
    }
    const lowStock = await StockLevel.countDocuments({ tenantId, onHand: mongoose.trusted({ $gt: 0 }), available: mongoose.trusted({ $lte: 1 }) });
    const needsState = await Order.countDocuments({ tenantId, status: "confirmed", invoiceId: null });
    res.json({ byStatus, today, lowStock, needsState, prefix: (await getSettings(tenantId)).orderPrefix });
  }));

  router.get("/api/orders/:id", requireAuth(), requirePermission("orders:read"), route(async (req, res) => {
    const order = await Order.findOne({ _id: req.params.id, tenantId }).lean();
    if (!order) throw httpError(404, "Order not found");
    const invoices = await Invoice.find({ orderId: order._id }).lean();
    res.json({ order, invoices, courierReady: Boolean(courier) });
  }));

  // A sale at the store counter (the POS screen calls this).
  router.post("/api/store-sales", requireAuth(), requirePermission("orders:write"), route(async (req, res) => {
    const body = parseBody(z.object({ location: z.string(), items, method: z.enum(["store_cash", "store_upi", "store_card"]), customer: z.object({ name: z.string().max(80).optional(), phone: z.string().max(15).optional() }).default({}) }), req);
    const order = await withTransaction(async (session) => {
      const location = await locationByCode(body.location, session);
      return orders.storeSale({ tenantId, locationId: location._id, items: body.items, method: body.method, customer: body.customer, by: req.user, session });
    });
    await audit({ req, action: "order.store_sale", meta: { orderId: order._id } });
    res.status(201).json({ order, invoice: await Invoice.findById(order.invoiceId).lean() });
  }));

  // Staff actions on an order. Each runs in one transaction with everything it changes.
  const actions = {
    confirm: { permission: "orders:write", schema: z.object({}), run: (order, body, req, session) => orders.confirmOrder({ tenantId, order, by: req.user, session }) },
    cancel: { permission: "orders:write", schema: z.object({ reason: z.string().min(2).max(200) }), run: (order, body, req, session) => orders.cancelOrder({ tenantId, order, by: req.user, reason: body.reason, session }) },
    "payment-choice": { permission: "orders:write", schema: z.object({ method: z.enum(["prepaid", "cod"]) }), run: (order, body, req, session) => orders.choosePayment({ tenantId, order, method: body.method, razorpayReady, by: req.user, session }) },
    state: {
      permission: "orders:write",
      schema: z.object({ stateCode: z.string().refine((code) => Boolean(GST_STATES[code]), "unknown GST state code") }),
      run: (order, body, req, session) => orders.setDeliveryState({ tenantId, order, stateCode: body.stateCode, state: GST_STATES[body.stateCode], by: req.user, session }),
    },
    pack: { permission: "orders:fulfil", schema: z.object({}), run: (order, body, req, session) => orders.markPacked({ tenantId, order, by: req.user, session }) },
    ship: { permission: "orders:fulfil", schema: z.object({ courier: z.string().min(2).max(40), awb: z.string().min(4).max(40) }), run: (order, body, req, session) => orders.markShipped({ tenantId, order, courier: body.courier, awb: body.awb, by: req.user, session }) },
    deliver: { permission: "orders:fulfil", schema: z.object({}), run: (order, body, req, session) => orders.markDelivered({ tenantId, order, by: req.user, session }) },
    rto: { permission: "orders:fulfil", schema: z.object({ note: z.string().max(200).default("") }), run: (order, body, req, session) => orders.markRto({ tenantId, order, by: req.user, note: body.note, session }) },
    return: { permission: "orders:write", schema: z.object({ reason: z.string().min(2).max(200) }), run: (order, body, req, session) => orders.markReturned({ tenantId, order, by: req.user, reason: body.reason, session }) },
  };

  router.post("/api/orders/:id/:action", requireAuth(), route(async (req, res, next) => {
    const action = actions[req.params.action];
    if (!action) return next();
    return requirePermission(action.permission)(req, res, async (error) => {
      if (error) return next(error);
      try {
        const body = parseBody(action.schema, req);
        const order = await withTransaction(async (session) => {
          const found = await Order.findOne({ _id: req.params.id, tenantId }).session(session);
          if (!found) throw httpError(404, "Order not found");
          return action.run(found, body, req, session);
        });
        await audit({ req, action: `order.${req.params.action}`, meta: { orderId: order._id } });
        res.json({ order });
      } catch (failure) {
        next(failure);
      }
    });
  }));

  // ---- Courier booking ---------------------------------------------------------------------------
  const weight = z.coerce.number().int().min(50).max(30000).optional();
  router.get("/api/orders/:id/courier-rates", requireAuth(), requirePermission("orders:fulfil"), route(async (req, res) => {
    const order = await Order.findOne({ _id: req.params.id, tenantId });
    if (!order) throw httpError(404, "Order not found");
    const query = parseBody(z.object({ weight }), { body: req.query });
    res.json(await courierRates({ tenantId, order, courier, weightGrams: query.weight }));
  }));

  router.post("/api/orders/:id/book-courier", requireAuth(), requirePermission("orders:fulfil"), route(async (req, res) => {
    const body = parseBody(z.object({ courierId: z.number().int().positive(), weightGrams: weight }), req);
    const order = await bookCourier({ tenantId, orderId: req.params.id, courierId: body.courierId, weightGrams: body.weightGrams, courier, by: req.user });
    await audit({ req, action: "order.book_courier", meta: { orderId: order._id, awb: order.shipment.awb } });
    res.json({ order });
  }));

  router.post("/api/orders/:id/courier-label", requireAuth(), requirePermission("orders:fulfil"), route(async (req, res) => {
    res.json({ order: await refreshLabel({ tenantId, orderId: req.params.id, courier }) });
  }));

  router.post("/api/orders/:id/cancel-courier", requireAuth(), requirePermission("orders:fulfil"), route(async (req, res) => {
    const order = await cancelBooking({ tenantId, orderId: req.params.id, courier, by: req.user });
    await audit({ req, action: "order.cancel_courier", meta: { orderId: order._id } });
    res.json({ order });
  }));

  // The pickup addresses saved in the Shiprocket account (for the Settings page).
  router.get("/api/shipping/pickup-locations", requireAuth(), requirePermission("settings:read"), route(async (req, res) => {
    res.json({ ready: Boolean(courier), locations: courier ? await courier.pickupLocations() : [] });
  }));

  router.get("/api/invoices/:id", requireAuth(), requirePermission("orders:read"), route(async (req, res) => {
    const invoice = await Invoice.findOne({ _id: req.params.id, tenantId }).lean();
    if (!invoice) throw httpError(404, "Invoice not found");
    res.json({ invoice });
  }));

  // ---- Settings ----------------------------------------------------------------------------------
  router.get("/api/settings", requireAuth(), requirePermission("settings:read"), route(async (req, res) => {
    res.json({ settings: await getSettings(tenantId), paymentsReady: razorpayReady, courierReady: Boolean(courier) });
  }));

  router.patch("/api/settings", requireAuth(), requirePermission("settings:write"), route(async (req, res) => {
    const body = parseBody(
      z.object({
        brandName: z.string().min(2).max(80).optional(),
        legalName: z.string().max(120).optional(),
        gstin: z.string().regex(/^\d{2}[A-Z]{5}\d{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/).optional(),
        registeredAddress: z.string().max(300).optional(),
        stateCode: z.string().refine((code) => Boolean(GST_STATES[code])).optional(),
        orderPrefix: z.string().regex(/^[A-Z]{2,5}$/).optional(),
        onlineLocationCode: z.string().max(6).optional(),
        defaultHsn: z.string().regex(/^\d{4,8}$/).optional(),
        paymentHoldMinutes: z.number().int().min(5).max(1440).optional(),
        cod: z.object({ enabled: z.boolean().optional(), maxOrderPaise: z.number().int().min(0).optional(), lowBelow: z.number().min(0).max(1).optional(), highFrom: z.number().min(0).max(1).optional(), confirmHours: z.number().int().min(1).max(72).optional() }).optional(),
        shipping: z.object({ pickupLocation: z.string().trim().max(60).optional(), weightGrams: z.number().int().min(50).max(30000).optional(), lengthCm: z.number().int().min(1).max(200).optional(), breadthCm: z.number().int().min(1).max(200).optional(), heightCm: z.number().int().min(1).max(200).optional() }).optional(),
        templates: z.object({ orderUpdate: z.object({ name: z.string().max(512), language: z.string().max(10).default("en") }).optional() }).optional(),
      }),
      req,
    );
    const set = {};
    for (const [key, value] of Object.entries(body)) {
      if (value && typeof value === "object" && !Array.isArray(value)) {
        for (const [inner, innerValue] of Object.entries(value)) set[`${key}.${inner}`] = innerValue;
      } else set[key] = value;
    }
    if (body.gstin && body.stateCode === undefined) set.stateCode = body.gstin.slice(0, 2);
    await getSettings(tenantId);
    const settings = await Settings.findOneAndUpdate({ tenantId }, { $set: set }, { new: true, runValidators: true });
    await audit({ req, action: "settings.update", meta: { fields: Object.keys(set) } });
    res.json({ settings });
  }));

  return router;
}
