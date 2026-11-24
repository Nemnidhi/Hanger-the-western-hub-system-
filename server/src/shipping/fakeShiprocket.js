import http from "node:http";
import { randomBytes } from "node:crypto";

// A stand-in for Shiprocket's API, for the tests and the demo only (never used in production).
// It answers the calls the booking code makes, keeps its shipments in memory, and can push a tracking
// update to our webhook the way Shiprocket does (POST /_demo/push { awb, status }).

const COURIERS = [
  { id: 43, name: "Delhivery Surface", base: 62, days: 4, rating: 4.1, surface: true },
  { id: 51, name: "Xpressbees Surface", base: 58, days: 5, rating: 3.8, surface: true },
  { id: 24, name: "Blue Dart Air", base: 118, days: 2, rating: 4.5, surface: false },
];

const STATUS_IDS = { "PICKED UP": 42, "IN TRANSIT": 18, "OUT FOR DELIVERY": 17, DELIVERED: 7, UNDELIVERED: 21, "RTO INITIATED": 9, "RTO DELIVERED": 10, CANCELED: 8, "AWB ASSIGNED": 1 };

const CITIES = { 452: ["Indore", "Madhya Pradesh"], 462: ["Bhopal", "Madhya Pradesh"], 141: ["Ludhiana", "Punjab"], 110: ["New Delhi", "Delhi"], 400: ["Mumbai", "Maharashtra"], 560: ["Bengaluru", "Karnataka"] };

/** A one-page PDF with a few lines of text: the demo's shipping label. */
function labelPdf(lines) {
  const text = lines.map((line, index) => `BT /F1 ${index === 0 ? 18 : 12} Tf 40 ${380 - index * 26} Td (${line.replace(/[()\\]/g, "")}) Tj ET`).join("\n");
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 288 432] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
    `<< /Length ${Buffer.byteLength(text)} >>\nstream\n${text}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  let body = "%PDF-1.4\n";
  const offsets = [];
  objects.forEach((object, index) => {
    offsets.push(Buffer.byteLength(body));
    body += `${index + 1} 0 obj\n${object}\nendobj\n`;
  });
  const xref = Buffer.byteLength(body);
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`).join("")}`;
  body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(body, "latin1");
}

export function createFakeShiprocket({ email = "api@hanger.test", password = "fake-courier-pass", webhookUrl: hookUrl = "", webhookToken: hookToken = "", pickupName = "Hanger online stock room" } = {}) {
  let webhookUrl = hookUrl;
  let webhookToken = hookToken;
  const token = randomBytes(16).toString("hex");
  const orders = new Map(); // shiprocket order id -> order
  const calls = [];
  let nextOrder = 7001;
  let nextShipment = 9001;
  let base = "";
  const state = { failAssign: false };

  const json = (res, status, data) => {
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(JSON.stringify(data));
  };
  const byShipment = (id) => [...orders.values()].find((order) => String(order.shipmentId) === String(id));
  const byAwb = (awb) => [...orders.values()].find((order) => order.awb === awb);

  function scan(order, status, activity) {
    const now = new Date(Date.now() + 5.5 * 3600_000).toISOString().slice(0, 19).replace("T", " ");
    order.scans.unshift({ date: now, status: status.replace(/\s/g, "-"), activity, location: "Indore_Hub (Madhya Pradesh)", "sr-status": String(STATUS_IDS[status] || ""), "sr-status-label": status });
    order.status = status;
  }

  async function push(order) {
    if (!webhookUrl) return { pushed: false };
    const [date, time] = order.scans[0].date.split(" ");
    const [y, m, d] = date.split("-");
    const body = {
      awb: order.awb, courier_name: order.courierName, current_status: order.status, current_status_id: STATUS_IDS[order.status] || 0,
      shipment_status: order.status, shipment_status_id: STATUS_IDS[order.status] || 0, current_timestamp: `${d} ${m} ${y} ${time}`,
      order_id: order.reference, sr_order_id: order.id, scans: [...order.scans].reverse(),
    };
    const response = await fetch(webhookUrl, { method: "POST", headers: { "Content-Type": "application/json", "x-api-key": webhookToken }, body: JSON.stringify(body) });
    return { pushed: true, status: response.status };
  }

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, "http://fake");
    let raw = "";
    for await (const chunk of req) raw += chunk;
    let body = {};
    try {
      body = raw ? JSON.parse(raw) : {};
    } catch {
      return json(res, 400, { message: "bad json" });
    }
    const path = url.pathname.replace(/\/+$/, "");
    calls.push({ method: req.method, path, query: Object.fromEntries(url.searchParams), body });

    if (path.startsWith("/labels/")) {
      const order = byShipment(path.split("/")[2].replace(".pdf", ""));
      if (!order) return json(res, 404, { message: "no label" });
      res.writeHead(200, { "Content-Type": "application/pdf" });
      return res.end(labelPdf([order.courierName, `AWB ${order.awb}`, `Order ${order.reference}`, order.payload.billing_customer_name, `${order.payload.billing_city} ${order.payload.billing_pincode}`, order.payload.payment_method === "COD" ? `COD Rs ${order.payload.sub_total}` : "PREPAID", "DEMO LABEL - NOT A REAL SHIPMENT"]));
    }
    if (req.method === "POST" && path === "/_demo/push") {
      const order = byAwb(body.awb);
      if (!order) return json(res, 404, { message: "unknown awb" });
      scan(order, String(body.status || "IN TRANSIT").toUpperCase(), body.activity || String(body.status || "In transit"));
      return json(res, 200, await push(order));
    }
    if (req.method === "POST" && path === "/auth/login") {
      if (body.email !== email || body.password !== password) return json(res, 400, { message: "Invalid email and password combination" });
      return json(res, 200, { token, email });
    }
    if (req.headers.authorization !== `Bearer ${token}`) return json(res, 401, { message: "Token has expired" });

    if (req.method === "GET" && path === "/courier/serviceability") {
      const kg = Number(url.searchParams.get("weight")) || 0.5;
      const slabs = Math.max(1, Math.ceil(kg / 0.5));
      const cod = url.searchParams.get("cod") === "1";
      return json(res, 200, {
        status: 200,
        data: {
          available_courier_companies: COURIERS.map((courier) => ({
            courier_company_id: courier.id, courier_name: courier.name, rate: courier.base * slabs + (cod ? 35 : 0), freight_charge: courier.base * slabs, cod_charges: cod ? 35 : 0,
            estimated_delivery_days: String(courier.days), etd: "", rating: courier.rating, is_surface: courier.surface, cod: 1, blocked: 0,
          })),
          recommended_courier_company_id: 43,
        },
      });
    }
    if (req.method === "POST" && path === "/orders/create/adhoc") {
      const missing = ["order_id", "pickup_location", "billing_customer_name", "billing_address", "billing_city", "billing_pincode", "billing_state", "billing_phone", "payment_method", "sub_total", "weight"].filter((key) => body[key] === undefined || body[key] === "");
      if (missing.length) return json(res, 422, { message: "Oops! Invalid Data.", errors: Object.fromEntries(missing.map((key) => [key, [`The ${key} field is required.`]])) });
      if (body.pickup_location !== pickupName) return json(res, 422, { message: `Wrong Pickup location entered. Your pickup location is ${pickupName}` });
      if ([...orders.values()].some((order) => order.reference === body.order_id && order.status !== "CANCELED")) return json(res, 422, { message: "Order Id already exists" });
      const order = { id: nextOrder++, shipmentId: nextShipment++, reference: body.order_id, payload: body, awb: "", courierName: "", status: "NEW", scans: [] };
      orders.set(order.id, order);
      return json(res, 200, { order_id: order.id, shipment_id: order.shipmentId, status: "NEW", status_code: 1, awb_code: null });
    }
    if (req.method === "POST" && path === "/courier/assign/awb") {
      const order = byShipment(body.shipment_id);
      const courier = COURIERS.find((row) => row.id === Number(body.courier_id));
      if (!order || !courier) return json(res, 422, { message: "Invalid shipment or courier" });
      if (state.failAssign) return json(res, 200, { awb_assign_status: 0, response: { data: { awb_assign_error: "Courier not serviceable right now" } } });
      order.awb = `${courier.id}${String(order.shipmentId).padStart(6, "0")}${String(Date.now()).slice(-5)}`;
      order.courierName = courier.name;
      scan(order, "AWB ASSIGNED", "AWB assigned");
      return json(res, 200, { awb_assign_status: 1, response: { data: { courier_company_id: courier.id, awb_code: order.awb, courier_name: courier.name, shipment_id: order.shipmentId, order_id: order.id } } });
    }
    if (req.method === "POST" && path === "/courier/generate/pickup") {
      const order = byShipment(body.shipment_id?.[0]);
      if (!order?.awb) return json(res, 422, { message: "AWB not assigned" });
      const tomorrow = new Date(Date.now() + 5.5 * 3600_000 + 24 * 3600_000).toISOString().slice(0, 10);
      return json(res, 200, { pickup_status: 1, response: { pickup_scheduled_date: `${tomorrow} 11:00:00`, data: `Pickup is confirmed by ${order.courierName} For AWB :- ${order.awb}` } });
    }
    if (req.method === "POST" && path === "/courier/generate/label") {
      const order = byShipment(body.shipment_id?.[0]);
      if (!order?.awb) return json(res, 422, { message: "AWB not assigned" });
      return json(res, 200, { label_created: 1, label_url: `${base}/labels/${order.shipmentId}.pdf`, not_created: [] });
    }
    if (req.method === "POST" && path === "/orders/cancel") {
      for (const id of body.ids || []) {
        const order = orders.get(Number(id));
        if (order) scan(order, "CANCELED", "Cancelled by seller");
      }
      return json(res, 200, { status: 200, message: "Order cancelled successfully." });
    }
    if (req.method === "GET" && path.startsWith("/courier/track/awb/")) {
      const order = byAwb(decodeURIComponent(path.split("/").pop()));
      if (!order) return json(res, 200, { tracking_data: { track_status: 0, error: "Aahh! There is no activities found in our DB." } });
      return json(res, 200, { tracking_data: { track_status: 1, shipment_status: STATUS_IDS[order.status] || 0, shipment_track: [{ awb_code: order.awb, current_status: order.status, courier_name: order.courierName }], shipment_track_activities: order.scans } });
    }
    if (req.method === "GET" && path === "/settings/company/pickup") {
      return json(res, 200, { data: { shipping_address: [{ id: 1, pickup_location: pickupName, city: "Indore", state: "Madhya Pradesh", pin_code: "452001", is_primary_location: 1 }] } });
    }
    if (req.method === "GET" && path === "/open/postcode/details") {
      const pin = url.searchParams.get("postcode") || "";
      const [city, stateName] = CITIES[pin.slice(0, 3)] || ["Unknown city", ""];
      return json(res, 200, { success: true, postcode_details: { postcode: pin, city, state: stateName } });
    }
    return json(res, 404, { message: "not in the fake" });
  });

  return {
    server,
    calls,
    orders,
    state,
    credentials: { email, password },
    async listen(port = 0) {
      await new Promise((resolve) => server.listen(port, "127.0.0.1", resolve));
      base = `http://127.0.0.1:${server.address().port}`;
      return base;
    },
    get base() {
      return base;
    },
    /** Where tracking updates are pushed (our webhook) and the token sent with them. */
    setWebhook(url, tokenValue) {
      webhookUrl = url;
      webhookToken = tokenValue;
    },
    /** Moves a shipment on (as the courier would) and pushes the webhook unless `push` is false. */
    async advance(awb, status, { activity, push: send = true } = {}) {
      const order = byAwb(awb);
      if (!order) throw new Error(`fake: unknown awb ${awb}`);
      scan(order, status, activity || status);
      return send ? push(order) : { pushed: false };
    },
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}
