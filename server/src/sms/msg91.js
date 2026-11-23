const SEND_TIMEOUT_MS = 15_000;

/** A failed SMS. `retryable`: the provider was busy or unreachable, trying later can work. */
export class SmsError extends Error {
  constructor(message, { retryable = false } = {}) {
    super(message);
    this.name = "SmsError";
    this.retryable = retryable;
  }
}

/** The SMS kinds and their DLT template's blanks, in order. Neither ever names a medicine. */
export const SMS_KINDS = {
  // "Your order {#var#} from The Hanger is {#var#}. Details on WhatsApp."
  order_update: 2,
  // "Your order {#var#} is on its way. Delivery code {#var#}: share it only when you receive it."
  delivery_code: 2,
};

/** Indian mobile numbers only (DLT); WhatsApp ids are the number with country code. */
export function indianMobile(waId) {
  const digits = String(waId || "").replace(/\D/g, "");
  return /^91[6-9]\d{9}$/.test(digits) ? digits : null;
}

/**
 * MSG91's Flow API: one DLT-registered template per kind, blanks var1, var2 ... Returns null when SMS
 * is not set up, so callers can record "not possible" instead of failing.
 */
export function smsFromConfig(config, fetchImpl = fetch) {
  if (config.SMS_PROVIDER !== "msg91") return null;
  const templates = { order_update: config.MSG91_TEMPLATE_ORDER_UPDATE, delivery_code: config.MSG91_TEMPLATE_DELIVERY_CODE };
  const url = `${config.MSG91_API_BASE.replace(/\/$/, "")}/api/v5/flow/`;
  return {
    async send(kind, mobile, vars = []) {
      if (!templates[kind]) throw new SmsError(`No SMS template for ${kind}`);
      const recipient = { mobiles: mobile };
      vars.forEach((value, index) => (recipient[`var${index + 1}`] = String(value).slice(0, 30)));
      let response;
      try {
        response = await fetchImpl(url, {
          method: "POST",
          headers: { authkey: config.MSG91_AUTH_KEY, "content-type": "application/json", accept: "application/json" },
          body: JSON.stringify({ template_id: templates[kind], short_url: "0", recipients: [recipient] }),
          signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
        });
      } catch (error) {
        throw new SmsError(`Could not reach MSG91: ${error?.message || error}`, { retryable: true });
      }
      const data = await response.json().catch(() => ({}));
      if (response.ok && data?.type === "success") return { requestId: String(data.message || "") };
      throw new SmsError(`MSG91 refused the SMS (HTTP ${response.status}): ${String(data?.message || "no details").slice(0, 200)}`, { retryable: response.status >= 500 || response.status === 429 });
    },
  };
}
