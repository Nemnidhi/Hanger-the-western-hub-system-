// Fills a DEVELOPMENT database with a demo boutique: two locations, suppliers, eight live styles with
// stock (plain colour swatches as photos), staff logins and orders in every state. It wipes the
// database first, so it refuses to run in production or on a database whose name lacks "dev"/"demo".
//   node src/scripts/seedDemo.js
import path from "node:path";
import { mkdir, writeFile } from "node:fs/promises";
import { deflateSync, crc32 } from "node:zlib";
import mongoose from "mongoose";
import { loadConfig } from "../config.js";
import { connectDb, withTransaction } from "../db.js";
import { Contact, Location, Order, Settings, Supplier, User } from "../models/index.js";
import { createStyle } from "../commerce/catalog.js";
import { receiveStock } from "../commerce/stock.js";
import { choosePayment, markPacked, markShipped, placeOnlineOrder, setAddress, storeSale } from "../commerce/orders.js";
import { hashPassword } from "../security/password.js";
import { encryptField } from "../security/fieldEncryption.js";
import { generateTotpSecret } from "../security/totp.js";

const config = loadConfig();
const dbName = new URL(config.MONGODB_URI.replace(/^mongodb(\+srv)?:/, "http:")).pathname.slice(1);
if (config.NODE_ENV === "production" || !/dev|demo/i.test(dbName)) {
  console.error(`Refusing to wipe "${dbName}": the demo seed only runs on a database named *dev* or *demo*, never in production.`);
  process.exit(1);
}
await connectDb(config.MONGODB_URI, { buildIndexes: false });
await mongoose.connection.db.dropDatabase();
await Promise.all(Object.values(mongoose.models).map((model) => model.createIndexes()));
const tenantId = config.TENANT_ID;

/** A plain 300x400 PNG in one colour with a soft vertical fade: a stand-in product photo. */
function swatch([r, g, b]) {
  const width = 300;
  const height = 400;
  const raw = Buffer.alloc((width * 3 + 1) * height);
  for (let y = 0; y < height; y += 1) {
    const shade = 1 - (y / height) * 0.25;
    const row = y * (width * 3 + 1);
    for (let x = 0; x < width; x += 1) raw.set([Math.round(r * shade), Math.round(g * shade), Math.round(b * shade)], row + 1 + x * 3);
  }
  const chunk = (type, data) => {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, "latin1"), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body));
    return Buffer.concat([length, body, crc]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header.set([8, 2, 0, 0, 0], 8);
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", header), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}

const uploadDir = path.resolve(config.UPLOAD_DIR);
await mkdir(uploadDir, { recursive: true });
const base = (config.PUBLIC_BASE_URL || `http://localhost:${config.PORT}`).replace(/\/$/, "");
async function photo(name, colour) {
  await writeFile(path.join(uploadDir, `demo-${name}.png`), swatch(colour));
  return `${base}/media/demo-${name}.png`;
}

await Settings.create({ tenantId, brandName: "The Hanger", legalName: "The Hanger Western Hub (demo)", gstin: "23ABCDE1234F1Z5", registeredAddress: "MG Road, New Palasia, Indore 452001", stateCode: "23", onlineLocationCode: "ONL", shipping: { pickupLocation: "Hanger online stock room" } });
const [store, online] = await Location.create([
  { tenantId, code: "ST1", name: "MG Road store", kind: "store", address: "MG Road, New Palasia, Indore", pincode: "452001", invoicePrefix: "ST1" },
  { tenantId, code: "ONL", name: "Online stock room", kind: "warehouse", address: "New Palasia, Indore", pincode: "452001", invoicePrefix: "IN1" },
]);
const [surat, jaipur] = await Supplier.create([
  { tenantId, name: "Surat Textiles (demo)", city: "Surat", notes: "Rayon and georgette; 10-day delivery" },
  { tenantId, name: "Jaipur Prints (demo)", city: "Jaipur", notes: "Block-print cotton" },
]);

const STYLES = [
  { code: "DRS-001", name: "Linen midi dress", category: "dresses", price: 1999, colour: "sage", rgb: [156, 175, 136], supplier: surat, sizes: ["XS", "S", "M", "L", "XL"] },
  { code: "DRS-002", name: "Satin slip dress", category: "dresses", price: 2499, colour: "wine", rgb: [122, 46, 79], supplier: surat, sizes: ["S", "M", "L"] },
  { code: "TOP-014", name: "Satin wrap top", category: "tops", price: 1299, colour: "champagne", rgb: [222, 198, 160], supplier: surat, sizes: ["XS", "S", "M", "L"] },
  { code: "TOP-021", name: "Block-print cotton top", category: "tops", price: 899, colour: "indigo", rgb: [60, 72, 130], supplier: jaipur, sizes: ["S", "M", "L", "XL"] },
  { code: "COR-005", name: "Linen co-ord set", category: "co-ords", price: 3299, colour: "sand", rgb: [205, 186, 150], supplier: surat, sizes: ["S", "M", "L"] },
  { code: "JNS-030", name: "Wide-leg jeans", category: "jeans", price: 1799, colour: "mid blue", rgb: [92, 124, 168], supplier: surat, sizes: ["26", "28", "30", "32"] },
  { code: "SKT-008", name: "Pleated midi skirt", category: "skirts", price: 1499, colour: "black", rgb: [40, 40, 44], supplier: surat, sizes: ["S", "M", "L"] },
  { code: "JKT-002", name: "Cropped denim jacket", category: "jackets", price: 2799, colour: "light wash", rgb: [150, 176, 204], supplier: surat, sizes: ["S", "M", "L"] },
];

for (const item of STYLES) {
  await withTransaction(async (session) => {
    const { style, skus } = await createStyle({
      tenantId,
      data: { code: item.code, name: item.name, category: item.category, pricePaise: item.price * 100, costPaise: Math.round(item.price * 45), supplierId: item.supplier._id, attributes: { colour: item.colour }, images: [await photo(item.code.toLowerCase(), item.rgb)], description: `${item.name} in ${item.colour}.` },
      sizes: item.sizes,
      session,
    });
    style.status = "live";
    style.liveAt = new Date();
    await style.save({ session });
    // A realistic spread: more of the middle sizes, one size down to its last piece.
    const qty = (size, index) => (["M", "28", "30"].includes(size) ? 4 : index === 0 ? 1 : 2);
    await receiveStock({ tenantId, locationId: store._id, items: skus.map((sku, index) => ({ sku, qty: qty(sku.size, index) })), supplierId: item.supplier._id, by: "Demo", note: "opening stock", session });
    await receiveStock({ tenantId, locationId: online._id, items: skus.map((sku) => ({ sku, qty: 3 })), supplierId: item.supplier._id, by: "Demo", note: "opening stock", session });
  });
}

// Staff logins. The owner's two-step login is switched on with a known secret (shown below) so the
// demo can be signed in to; set up a real one in production.
const password = "Demo-hanger-2026";
const secret = generateTotpSecret();
await User.create([
  { tenantId, name: "Owner (demo)", email: "owner@hanger.local", role: "owner", status: "active", passwordHash: await hashPassword(password), mustChangePassword: false, twoFactor: { enabled: true, secretEnc: encryptField(secret, config.DATA_ENCRYPTION_KEY) } },
  { tenantId, name: "Riya (store)", email: "staff@hanger.local", role: "staff", status: "active", passwordHash: await hashPassword(password), mustChangePassword: false },
  { tenantId, name: "Aman (packing)", email: "packer@hanger.local", role: "packer", status: "active", passwordHash: await hashPassword(password), mustChangePassword: false },
]);

// Orders in every state.
const at = (minutesAgo) => new Date(Date.now() - minutesAgo * 60_000);
async function onlineOrder({ waId, name, items, address, pay, minutesAgo }) {
  return withTransaction(async (session) => {
    const [contact] = await Contact.create([{ tenantId, waId, profileName: name, name }], { session });
    let order = await placeOnlineOrder({ tenantId, channel: "whatsapp", contact, conversationId: null, items, session, now: at(minutesAgo) });
    if (address) order = await setAddress({ tenantId, order, address, razorpayReady: false, session, now: at(minutesAgo - 2) });
    if (pay) order = await choosePayment({ tenantId, order, method: pay, razorpayReady: false, session, now: at(minutesAgo - 3) });
    return order;
  });
}
const shipped = await onlineOrder({ waId: "919800000101", name: "Neha Sharma", items: [{ skuCode: "DRS-001-M", qty: 1 }], address: "Neha Sharma, 14 Saket Nagar, near Saket club, Indore 452018", pay: "cod", minutesAgo: 60 * 26 });
await withTransaction(async (session) => {
  const order = await Order.findById(shipped._id).session(session);
  await markPacked({ tenantId, order, by: "Aman (packing)", session, now: at(60 * 25) });
  await markShipped({ tenantId, order, courier: "Delhivery", awb: "1490112233445", by: "Aman (packing)", session, now: at(60 * 24) });
});
await onlineOrder({ waId: "919800000102", name: "Pooja Verma", items: [{ skuCode: "TOP-014-S", qty: 1 }, { skuCode: "SKT-008-S", qty: 1 }], address: "Pooja Verma, Flat 302, Silver Oak apartment, Vijay Nagar main road, Indore 452010", pay: "cod", minutesAgo: 90 });
await onlineOrder({ waId: "919800000103", name: "Kritika Jain", items: [{ skuCode: "COR-005-M", qty: 1 }, { skuCode: "DRS-002-M", qty: 1 }], address: "Kritika Jain, 22 Shivaji Nagar, Bhopal 462016", pay: "cod", minutesAgo: 45 });
await onlineOrder({ waId: "919800000104", name: "Simran Kaur", items: [{ skuCode: "JKT-002-M", qty: 1 }], address: "Simran Kaur, B-12 Model Town, near the gurudwara, Ludhiana 141002", pay: "cod", minutesAgo: 30 });
await onlineOrder({ waId: "919800000105", name: "Ananya", items: [{ skuCode: "JNS-030-28", qty: 1 }], minutesAgo: 10 });
await withTransaction((session) => storeSale({ tenantId, locationId: store._id, items: [{ skuCode: "TOP-021-M", qty: 2 }], method: "store_upi", customer: { name: "Walk-in" }, by: "Riya (store)", session, now: at(120) }));
await withTransaction((session) => storeSale({ tenantId, locationId: store._id, items: [{ skuCode: "DRS-001-S", qty: 1 }, { skuCode: "SKT-008-M", qty: 1 }], method: "store_cash", by: "Riya (store)", session, now: at(40) }));

console.log(`Demo boutique ready in "${dbName}".`);
console.log(`Sign in: owner@hanger.local / ${password}  (two-step code: node src/scripts/demoCode.js)`);
console.log(`Also: staff@hanger.local and packer@hanger.local, same password, no two-step code.`);
await writeFile(path.join(uploadDir, ".demo-totp"), secret);
await mongoose.disconnect();
