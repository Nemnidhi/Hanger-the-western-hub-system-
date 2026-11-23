// A demo order, start to finish, on a throwaway database: a WhatsApp cart, the address, cash on
// delivery, the GST invoice. Prints what the customer reads and the invoice. Nothing leaves this machine:
// Meta is a local stand-in.
//   node src/scripts/demo.js   (needs the development replica set from the README)
import http from "node:http";
import mongoose from "mongoose";
import { createApp } from "../app.js";
import { createHandlers } from "../handlers.js";
import { drain } from "../jobs/runner.js";
import { withTransaction } from "../db.js";
import { createStyle } from "../commerce/catalog.js";
import { receiveStock } from "../commerce/stock.js";
import { rupees } from "../commerce/gst.js";
import { Invoice, Location, Order, Settings } from "../models/index.js";
import { connectTestDb, inboundButtonPayload, inboundCartPayload, inboundTextPayload, listen, sign, startFakeMeta, testConfig } from "../../test/helpers.js";

process.env.TEST_MONGODB_URI ||= "mongodb://127.0.0.1:27027/hanger_demo?replicaSet=rs0";
await connectTestDb();
const meta = await startFakeMeta();
const config = testConfig({ META_GRAPH_BASE: meta.baseUrl, MONGODB_URI: process.env.TEST_MONGODB_URI });
const handlers = createHandlers({ config });
const server = http.createServer(createApp({ config }));
const baseUrl = await listen(server);
const tenantId = config.TENANT_ID;
const from = "919800000001";
let seen = 0;
let n = 0;

async function send(payload, shown) {
  console.log(`\nCUSTOMER: ${shown}`);
  const raw = Buffer.from(JSON.stringify(payload));
  await fetch(`${baseUrl}/webhooks/whatsapp`, { method: "POST", headers: { "content-type": "application/json", "x-hub-signature-256": sign(raw, config.WHATSAPP_APP_SECRET) }, body: raw });
  await drain(handlers);
  for (const request of meta.requests.slice(seen)) {
    const body = request.body;
    const text = body?.text?.body || body?.interactive?.body?.text;
    if (!text) continue;
    console.log(`THE HANGER: ${text.replace(/\n/g, "\n            ")}`);
    for (const button of body?.interactive?.action?.buttons || []) console.log(`            [ ${button.reply.title} ]`);
  }
  seen = meta.requests.length;
}

await Settings.create({ tenantId, brandName: "The Hanger", legalName: "The Hanger Western Hub", gstin: "23ABCDE1234F1Z5", stateCode: "23", onlineLocationCode: "ONL" });
const online = await Location.create({ tenantId, code: "ONL", name: "Online stock room", kind: "warehouse", address: "Indore", pincode: "452001", invoicePrefix: "IN1" });
await withTransaction(async (session) => {
  const { style, skus } = await createStyle({ tenantId, data: { code: "DRS-001", name: "Linen midi dress", category: "dresses", pricePaise: 199900, images: ["https://img.example/1.jpg"] }, sizes: ["S", "M", "L"], session });
  style.status = "live";
  await style.save({ session });
  await receiveStock({ tenantId, locationId: online._id, items: skus.map((sku) => ({ sku, qty: 3 })), by: "demo", session });
});

await send(inboundCartPayload({ from, id: `demo.${(n += 1)}`, items: [{ skuCode: "DRS-001-M", qty: 1 }] }), "(sends a cart from the WhatsApp catalogue: Linen midi dress, M)");
await send(inboundTextPayload({ from, id: `demo.${(n += 1)}`, text: "Asha Jain, Flat 12, Shanti Apartment, Vijay Nagar main road, near C21 mall, Indore 452010" }), "Asha Jain, Flat 12, Shanti Apartment, Vijay Nagar main road, near C21 mall, Indore 452010");
await send(inboundButtonPayload({ from, id: `demo.${(n += 1)}`, buttonId: "pay_cod", title: "Cash on delivery" }), "[ Cash on delivery ]");

const order = await Order.findOne();
const invoice = await Invoice.findOne({ orderId: order._id });
console.log(`\nORDER HWH-${order.number}: ${order.status}; COD risk ${order.cod.score} (${order.cod.band}): ${order.cod.reasons.join("; ")}`);
if (invoice) {
  console.log(`INVOICE ${invoice.number} | place of supply ${invoice.placeOfSupply.state} | ${invoice.interState ? "IGST" : "CGST + SGST"}`);
  for (const line of invoice.lines) console.log(`  ${line.description} | HSN ${line.hsn} | ${line.qty} x ${rupees(line.unitPaise)} | GST ${line.rate}% | taxable ${rupees(line.taxablePaise)} | CGST ${rupees(line.cgstPaise)} | SGST ${rupees(line.sgstPaise)} | IGST ${rupees(line.igstPaise)}`);
  console.log(`  Total ${rupees(invoice.totals.totalPaise)}`);
}

server.close();
await meta.close();
await mongoose.connection.db.dropDatabase();
await mongoose.disconnect();
