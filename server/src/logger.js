import pino from "pino";

// Structured JSON logs. Secrets and message content never reach the log: customer names, addresses and
// phone numbers are personal data (DPDP Act), so only ids and outcomes are logged.
export function createLogger({ level = "info", name = "hanger" } = {}) {
  return pino({
    name,
    level,
    redact: {
      paths: ["req.headers.authorization", "req.headers.cookie", "*.accessToken", "*.token", "*.text", "*.body", "*.caption"],
      censor: "[redacted]",
    },
    base: { service: name },
    timestamp: pino.stdTimeFunctions.isoTime,
  });
}
