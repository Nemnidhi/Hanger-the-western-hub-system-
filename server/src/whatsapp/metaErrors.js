// Why Meta refused a WhatsApp message, in plain words for the pharmacy's staff. Taken from the
// Nemnidhi Dashboard (server/services/metaErrors.js), where these reasons were collected from real
// delivery failures.
const REASONS = {
  130429: { label: "Meta refused it - too many messages from this number in a short time", action: "Wait a few minutes; the system retries on its own." },
  131048: { label: "Meta limited this number because earlier messages were blocked or reported as spam", action: "Stop sending offers; message only people who expect it." },
  131056: { label: "Too many messages to the same person in a short time", action: "Wait a while before messaging this person again." },
  131049: { label: "Meta held this back - the person already got enough promotional messages recently", action: "Nothing to fix. Try again after a few days." },
  131026: { label: "Could not be delivered - the number is not on WhatsApp, or cannot receive this message", action: "Call the customer instead." },
  131021: { label: "The number is the same as the sending number", action: "Check the customer's number." },
  131042: { label: "Payment problem on the WhatsApp account at Meta", action: "Add or fix the payment method in WhatsApp Manager." },
  131031: { label: "Meta has locked this WhatsApp account", action: "Open WhatsApp Manager to see why and to appeal." },
  131045: { label: "The number is not registered with Meta properly", action: "Check the number's registration in WhatsApp Manager." },
  131047: { label: "More than 24 hours since the customer's last message", action: "Send an approved template instead." },
  131050: { label: "The customer has stopped promotional messages from this business", action: "Do not send them offers." },
  131051: { label: "Meta does not support this kind of message", action: "Send a different kind of message." },
  131052: { label: "Meta could not download the attached file", action: "Attach the file again." },
  131053: { label: "The attached file could not be sent", action: "Check the file's type and size." },
  131057: { label: "The WhatsApp account is under maintenance at Meta", action: "Nothing to do; the system retries on its own." },
  132000: { label: "The template's blanks were not all filled in", action: "Check the template's variables." },
  132001: { label: "The template does not exist in this language", action: "Check the template name and language." },
  132007: { label: "The template breaks Meta's rules", action: "Edit the template and send it for approval again." },
  132012: { label: "The template's blanks were filled in the wrong format", action: "Check the template's variables." },
  132015: { label: "Meta paused this template because people marked it as unwanted", action: "Use another template." },
  132016: { label: "Meta switched this template off for good", action: "Create a new template." },
  133010: { label: "The number is not registered with Meta", action: "Check the number in WhatsApp Manager." },
  368: { label: "Meta blocked this account for breaking its rules", action: "Open WhatsApp Manager to see why and to appeal." },
  190: { label: "The connection to Meta has expired", action: "Replace the access token (system user) in the server settings." },
};

// Temporary on Meta's side: worth trying again later. Everything else is permanent for that message.
const RETRYABLE_CODES = new Set([1, 2, 4, 17, 341, 80007, 130429, 131000, 131016, 131057, 133004]);

export function describeMetaError(code, fallback = "") {
  const number = Number(code) || 0;
  const known = REASONS[number];
  if (known) return { code: number, ...known };
  return { code: number, label: String(fallback || "").trim() || "Meta rejected this message", action: "" };
}

export function isRetryableMetaCode(code) {
  return RETRYABLE_CODES.has(Number(code));
}
