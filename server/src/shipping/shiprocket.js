import { createHash, timingSafeEqual } from "node:crypto";

// Shiprocket on the brand's own account: courier rates, booking (order -> AWB -> pickup -> label),
// cancelling, tracking and the pickup addresses. Only what a booking needs is sent: the delivery
// name, address, phone and the items on the order.

const TOKEN_TTL_MS = 9 * 24 * 60 * 60 * 1000; // Shiprocket's token lasts 10 days; renew a day early.

export class ShippingError extends Error {
  constructor(message, { status = 422, retryable = false } = {}) {
    // 4xx so the staff app shows the courier's reason (5xx answers are hidden as "something went wrong").
    super(message);
    this.name = "ShippingError";
    this.status = status;
    this.code = "COURIER_ERROR";
    this.retryable = retryable;
  }
}

/** Shiprocket's reason for a refusal, from the several shapes its errors come in. */
function reason(data) {
  if (!data || typeof data !== "object") return "";
  if (typeof data.message === "string" && data.message) return data.message;
  if (data.errors && typeof data.errors === "object") return Object.values(data.errors).flat().join("; ");
  const awbError = data.response?.data?.awb_assign_error;
  return typeof awbError === "string" ? awbError : "";
}

const rupeesToPaise = (value) => {
  const number = Number(value);
  return Number.isFinite(number) ? Math.round(number * 100) : null;
};

export function shiprocketFromConfig(config, fetchImpl = fetch) {
  if (config.SHIPPING_PROVIDER !== "shiprocket") return null;
  return createShiprocketClient({ base: config.SHIPROCKET_API_BASE, email: config.SHIPROCKET_EMAIL, password: config.SHIPROCKET_PASSWORD, fetchImpl });
}

export function createShiprocketClient({ base, email, password, fetchImpl = fetch, now = () => Date.now() }) {
  const root = base.replace(/\/$/, "");
  let token = null;
  let tokenUntil = 0;

  async function login() {
    let response;
    try {
      response = await fetchImpl(`${root}/auth/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, password }),
        signal: AbortSignal.timeout(15_000),
      });
    } catch (error) {
      throw new ShippingError(`Could not reach Shiprocket: ${error?.message}`, { status: 424, retryable: true });
    }
    const data = await response.json().catch(() => ({}));
    if (!response.ok || !data?.token) throw new ShippingError(`Shiprocket did not accept the API login (HTTP ${response.status}). Check the API user's email and password.`, { status: response.status >= 500 ? 424 : 422, retryable: response.status >= 500 });
    token = data.token;
    tokenUntil = now() + TOKEN_TTL_MS;
    return token;
  }

  async function call(method, path, { query, body } = {}, retried = false) {
    if (!token || now() > tokenUntil) await login();
    const url = new URL(`${root}/${path}`);
    for (const [key, value] of Object.entries(query || {})) if (value !== undefined && value !== null && value !== "") url.searchParams.set(key, String(value));
    let response;
    try {
      response = await fetchImpl(url, {
        method,
        headers: { Authorization: `Bearer ${token}`, ...(body ? { "Content-Type": "application/json" } : {}) },
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(20_000),
      });
    } catch (error) {
      throw new ShippingError(`Could not reach Shiprocket: ${error?.message}`, { status: 424, retryable: true });
    }
    if (response.status === 401 && !retried) {
      token = null;
      return call(method, path, { query, body }, true);
    }
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new ShippingError(`Shiprocket refused (HTTP ${response.status})${reason(data) ? `: ${reason(data)}` : ""}`, { status: response.status >= 500 ? 424 : 422, retryable: response.status === 429 || response.status >= 500 });
    }
    return data;
  }

  return {
    name: "shiprocket",

    /** Couriers that serve the route, cheapest first, with Shiprocket's recommendation marked. */
    async rates({ pickupPincode, deliveryPincode, cod, weightKg, declaredRupees, lengthCm, breadthCm, heightCm }) {
      const data = await call("GET", "courier/serviceability/", {
        query: { pickup_postcode: pickupPincode, delivery_postcode: deliveryPincode, cod: cod ? 1 : 0, weight: weightKg, declared_value: declaredRupees, length: lengthCm, breadth: breadthCm, height: heightCm },
      });
      const list = Array.isArray(data?.data?.available_courier_companies) ? data.data.available_courier_companies : [];
      const recommended = Number(data?.data?.recommended_courier_company_id) || null;
      return list
        .filter((row) => row && !row.blocked && Number.isFinite(Number(row.courier_company_id)))
        .map((row) => ({
          courierId: Number(row.courier_company_id),
          name: String(row.courier_name || "Courier"),
          ratePaise: rupeesToPaise(row.rate ?? row.freight_charge),
          codChargePaise: rupeesToPaise(row.cod_charges) || 0,
          days: row.estimated_delivery_days ? String(row.estimated_delivery_days) : "",
          etd: row.etd ? String(row.etd) : "",
          rating: Number.isFinite(Number(row.rating)) ? Number(row.rating) : null,
          surface: Boolean(row.is_surface),
          cod: Number(row.cod) === 1,
          recommended: Number(row.courier_company_id) === recommended,
        }))
        .filter((row) => !cod || row.cod)
        .sort((a, b) => (a.ratePaise ?? Infinity) - (b.ratePaise ?? Infinity));
    },

    /** Creates the order at Shiprocket. `reference` is our order label; Shiprocket answers with its own ids. */
    async createOrder(payload) {
      const data = await call("POST", "orders/create/adhoc", { body: payload });
      if (!data?.order_id || !data?.shipment_id) throw new ShippingError(`Shiprocket did not create the order${reason(data) ? `: ${reason(data)}` : ""}`, { status: 422 });
      return { providerOrderId: String(data.order_id), shipmentId: String(data.shipment_id) };
    },

    /** Gives the shipment to the chosen courier and returns its tracking number (AWB). */
    async assignAwb({ shipmentId, courierId }) {
      const data = await call("POST", "courier/assign/awb", { body: { shipment_id: shipmentId, courier_id: courierId } });
      const row = data?.response?.data;
      if (Number(data?.awb_assign_status) !== 1 || !row?.awb_code) throw new ShippingError(`The courier did not accept the shipment${reason(data) ? `: ${reason(data)}` : ""}`, { status: 422 });
      return { awb: String(row.awb_code), courierName: String(row.courier_name || ""), courierId: Number(row.courier_company_id) || courierId };
    },

    /** Asks the courier to come and collect. */
    async requestPickup({ shipmentId }) {
      const data = await call("POST", "courier/generate/pickup", { body: { shipment_id: [Number(shipmentId) || shipmentId] } });
      const scheduled = data?.response?.pickup_scheduled_date || "";
      return { ok: Number(data?.pickup_status) === 1, note: scheduled ? `pickup ${scheduled}` : String(data?.response?.data || reason(data) || "") };
    },

    /** The shipping label as a PDF link, to print and stick on the parcel. */
    async label({ shipmentId }) {
      const data = await call("POST", "courier/generate/label", { body: { shipment_id: [Number(shipmentId) || shipmentId] } });
      if (!data?.label_url) throw new ShippingError(`No label yet${reason(data) ? `: ${reason(data)}` : ""}`, { status: 422 });
      return { url: String(data.label_url) };
    },

    /** Cancels orders at Shiprocket (their ids); their AWBs are cancelled with them. */
    async cancelOrders({ providerOrderIds }) {
      await call("POST", "orders/cancel", { body: { ids: providerOrderIds.map((value) => Number(value) || value) } });
      return { ok: true };
    },

    /** The shipment's latest status and scans. */
    async track({ awb }) {
      const data = await call("GET", `courier/track/awb/${encodeURIComponent(awb)}`);
      const tracking = data?.tracking_data || {};
      const latest = Array.isArray(tracking.shipment_track) ? tracking.shipment_track[0] : null;
      return {
        statusId: Number(tracking.shipment_status) || null,
        status: String(latest?.current_status || ""),
        scans: Array.isArray(tracking.shipment_track_activities) ? tracking.shipment_track_activities : [],
        error: typeof tracking.error === "string" ? tracking.error : "",
      };
    },

    /** The pickup addresses saved in the Shiprocket account, by name. */
    async pickupLocations() {
      const data = await call("GET", "settings/company/pickup");
      const rows = Array.isArray(data?.data?.shipping_address) ? data.data.shipping_address : [];
      return rows.map((row) => ({ name: String(row.pickup_location || ""), pincode: String(row.pin_code || ""), city: String(row.city || ""), primary: Number(row.is_primary_location) === 1 })).filter((row) => row.name);
    },

    /** City and state for a pincode. */
    async postcode({ pincode }) {
      const data = await call("GET", "open/postcode/details", { query: { postcode: pincode } });
      const details = data?.postcode_details;
      return details ? { city: String(details.city || ""), state: String(details.state || "") } : null;
    },
  };
}

/** True only when the webhook's x-api-key matches our token (constant time). */
export function isValidWebhookToken(received, expected) {
  if (!expected || typeof received !== "string" || !received) return false;
  const a = createHash("sha256").update(received).digest();
  const b = createHash("sha256").update(expected).digest();
  return timingSafeEqual(a, b);
}

/** The public tracking page for an AWB booked through Shiprocket. */
export const trackingUrl = (awb) => `https://shiprocket.co/tracking/${encodeURIComponent(awb)}`;
