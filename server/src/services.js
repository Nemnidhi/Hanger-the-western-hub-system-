import { clientFromConfig } from "./whatsapp/client.js";
import { razorpayFromConfig } from "./payments/razorpay.js";
import { smsFromConfig } from "./sms/msg91.js";
import { shiprocketFromConfig } from "./shipping/shiprocket.js";

/** The outside services, built once per process from the settings. Tests pass a stand-in fetch. */
export function createServices(config, { fetchImpl } = {}) {
  return {
    fetchImpl: fetchImpl || fetch,
    client: clientFromConfig(config, fetchImpl),
    razorpay: razorpayFromConfig(config, fetchImpl),
    sms: smsFromConfig(config, fetchImpl),
    courier: shiprocketFromConfig(config, fetchImpl),
  };
}
