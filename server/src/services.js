import { clientFromConfig } from "./whatsapp/client.js";
import { razorpayFromConfig } from "./payments/razorpay.js";
import { smsFromConfig } from "./sms/msg91.js";
import { shiprocketFromConfig } from "./shipping/shiprocket.js";
import { copywriterFromConfig } from "./studio/copywriter.js";
import { photoroomFromConfig } from "./studio/photoroom.js";
import { createStandInCopywriter, createStandInImages } from "./studio/standIn.js";

/** The outside services, built once per process from the settings. Tests pass a stand-in fetch. */
export function createServices(config, { fetchImpl } = {}) {
  return {
    fetchImpl: fetchImpl || fetch,
    client: clientFromConfig(config, fetchImpl),
    razorpay: razorpayFromConfig(config, fetchImpl),
    sms: smsFromConfig(config, fetchImpl),
    courier: shiprocketFromConfig(config, fetchImpl),
    // Photo studio: Photoroom for photos, Claude for write-ups; the stand-in only in development.
    studioImages: photoroomFromConfig(config, fetchImpl) || (config.STUDIO_STAND_IN ? createStandInImages() : null),
    copywriter: copywriterFromConfig(config) || (config.STUDIO_STAND_IN ? createStandInCopywriter() : null),
  };
}
