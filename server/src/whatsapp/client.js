import { describeMetaError, isRetryableMetaCode } from "./metaErrors.js";

const SEND_TIMEOUT_MS = 15_000;

/**
 * A failed send. `retryable` says whether trying again later can work; `ambiguous` means the request
 * may have reached Meta (a timeout after sending), so a retry could deliver the message twice - for
 * order updates a rare duplicate is better than a lost message, and the caller decides.
 */
export class WhatsAppSendError extends Error {
  constructor({ message, code = 0, httpStatus = 0, retryable, ambiguous = false, label = "", action = "" }) {
    super(message);
    this.name = "WhatsAppSendError";
    Object.assign(this, { code, httpStatus, retryable, ambiguous, label, action });
  }
}

/** The client for the number in this deployment's settings. */
export function clientFromConfig(config, fetchImpl) {
  return createWhatsAppClient({
    accessToken: config.WHATSAPP_ACCESS_TOKEN,
    phoneNumberId: config.WHATSAPP_PHONE_NUMBER_ID,
    graphBase: config.META_GRAPH_BASE,
    graphVersion: config.META_GRAPH_VERSION,
    fetchImpl,
  });
}

/** Talks to the WhatsApp Cloud API for one number. `fetchImpl` is replaceable in tests. */
export function createWhatsAppClient({ accessToken, phoneNumberId, graphBase = "https://graph.facebook.com", graphVersion = "v24.0", fetchImpl = fetch }) {
  const messagesUrl = `${graphBase.replace(/\/$/, "")}/${graphVersion}/${phoneNumberId}/messages`;

  async function send(body) {
    let response;
    try {
      response = await fetchImpl(messagesUrl, {
        method: "POST",
        headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
        body: JSON.stringify({ messaging_product: "whatsapp", recipient_type: "individual", ...body }),
        signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
      });
    } catch (error) {
      const timedOut = error?.name === "TimeoutError" || error?.name === "AbortError";
      throw new WhatsAppSendError({
        message: timedOut ? "Meta did not answer in time" : `Could not reach Meta: ${error?.message || error}`,
        retryable: true,
        ambiguous: timedOut,
        label: "Could not reach WhatsApp just now",
        action: "The system retries on its own.",
      });
    }

    const data = await response.json().catch(() => ({}));
    if (response.ok && data?.messages?.[0]?.id) return { waMessageId: data.messages[0].id };

    const metaError = data?.error || {};
    const code = Number(metaError.code) || 0;
    const described = describeMetaError(code, metaError.error_data?.details || metaError.message);
    throw new WhatsAppSendError({
      message: `Meta refused the message (HTTP ${response.status}, code ${code}): ${metaError.message || "no details"}`,
      code,
      httpStatus: response.status,
      retryable: response.status === 429 || response.status >= 500 || isRetryableMetaCode(code),
      label: described.label,
      action: described.action,
    });
  }

  const root = `${graphBase.replace(/\/$/, "")}/${graphVersion}`;
  const authHeaders = { Authorization: `Bearer ${accessToken}` };

  async function getJson(url) {
    const response = await fetchImpl(url, { headers: authHeaders, signal: AbortSignal.timeout(SEND_TIMEOUT_MS) });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      const code = Number(data?.error?.code) || 0;
      throw new WhatsAppSendError({ message: `Meta request failed (HTTP ${response.status}, code ${code})`, code, httpStatus: response.status, retryable: response.status === 429 || response.status >= 500 });
    }
    return data;
  }

  return {
    /** Every template on the WhatsApp Business Account, following Meta's paging. */
    async listTemplates(businessAccountId) {
      const templates = [];
      let url = `${root}/${businessAccountId}/message_templates?limit=100&fields=name,language,status,category,components,rejected_reason`;
      for (let page = 0; url && page < 50; page += 1) {
        const data = await getJson(url);
        templates.push(...(Array.isArray(data.data) ? data.data : []));
        url = data.paging?.next || "";
      }
      return templates;
    },
    /** A customer's photo, document or voice note: Meta gives a short-lived link, fetched with our token. */
    async downloadMedia(mediaId) {
      const info = await getJson(`${root}/${encodeURIComponent(mediaId)}`);
      if (!info?.url) throw new WhatsAppSendError({ message: "Meta returned no media link", retryable: false });
      const response = await fetchImpl(info.url, { headers: authHeaders, signal: AbortSignal.timeout(30_000) });
      if (!response.ok) throw new WhatsAppSendError({ message: `Media download failed (HTTP ${response.status})`, httpStatus: response.status, retryable: response.status >= 500 });
      return { response, mimeType: info.mime_type || response.headers.get("content-type") || "application/octet-stream", size: Number(info.file_size) || 0 };
    },
    sendText: (to, text) => send({ to, type: "text", text: { body: text, preview_url: false } }),
    /** Up to 3 tap-to-answer buttons ({ id, title }); the tap comes back as an inbound "interactive" reply. */
    sendButtons: (to, { body, buttons }) =>
      send({
        to,
        type: "interactive",
        interactive: { type: "button", body: { text: body }, action: { buttons: buttons.slice(0, 3).map((button) => ({ type: "reply", reply: { id: button.id, title: button.title.slice(0, 20) } })) } },
      }),
    sendTemplate: (to, { name, language, components = [] }) => send({ to, type: "template", template: { name, language: { code: language }, components } }),
    markRead: (waMessageId) => send({ status: "read", message_id: waMessageId }).catch(() => undefined),
  };
}
