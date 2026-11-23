import { createHmac, timingSafeEqual } from "node:crypto";

// Razorpay payment links on the brand's own Razorpay account. The link's description names only
// the order number.

export function razorpayFromConfig(config, fetchImpl = fetch) {
  if (!config.RAZORPAY_KEY_ID || !config.RAZORPAY_KEY_SECRET) return null;
  const auth = `Basic ${Buffer.from(`${config.RAZORPAY_KEY_ID}:${config.RAZORPAY_KEY_SECRET}`).toString("base64")}`;
  const base = config.RAZORPAY_API_BASE.replace(/\/$/, "");
  return {
    async createPaymentLink({ amountPaise, referenceId, description, customerName, phone, expiresAt }) {
      let response;
      try {
        response = await fetchImpl(`${base}/v1/payment_links`, {
          method: "POST",
          headers: { Authorization: auth, "Content-Type": "application/json" },
          body: JSON.stringify({
            amount: amountPaise,
            currency: "INR",
            accept_partial: false,
            reference_id: referenceId,
            description,
            customer: { name: customerName || undefined, contact: phone ? `+${phone}` : undefined },
            notify: { sms: false, email: false },
            reminder_enable: false,
            expire_by: Math.floor(expiresAt.getTime() / 1000),
            notes: { reference: referenceId },
          }),
          signal: AbortSignal.timeout(15_000),
        });
      } catch (error) {
        throw Object.assign(new Error(`Could not reach Razorpay: ${error?.message}`), { retryable: true });
      }
      const data = await response.json().catch(() => ({}));
      if (!response.ok || !data?.id) {
        throw Object.assign(new Error(`Razorpay refused the payment link (HTTP ${response.status}): ${data?.error?.description || "no details"}`), {
          retryable: response.status === 429 || response.status >= 500,
        });
      }
      return { id: data.id, url: data.short_url };
    },
  };
}

/** True only for Razorpay's HMAC-SHA256 of the exact raw body with the webhook secret. */
export function isValidRazorpaySignature(rawBody, signature, secret) {
  if (!secret || !Buffer.isBuffer(rawBody) || typeof signature !== "string" || !/^[0-9a-f]{64}$/i.test(signature)) return false;
  const expected = createHmac("sha256", secret).update(rawBody).digest();
  const received = Buffer.from(signature, "hex");
  return received.length === expected.length && timingSafeEqual(received, expected);
}
