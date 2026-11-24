import { loadConfig } from "./config.js";
import { createLogger } from "./logger.js";
import { connectDb, disconnectDb } from "./db.js";
import { createRunner } from "./jobs/runner.js";
import { enqueue } from "./jobs/queue.js";
import { createHandlers } from "./handlers.js";
import "./models/index.js";

// The worker process: runs the durable jobs (WhatsApp events and sends, chat ordering, payment links,
// hold expiry, the Meta catalogue sync). Several workers can run at once; each job is claimed by one.
const config = loadConfig();
const logger = createLogger({ level: config.LOG_LEVEL, name: "hanger-worker" });

await connectDb(config.MONGODB_URI, { logger });
const runner = createRunner({ handlers: createHandlers({ config }), concurrency: config.WORKER_CONCURRENCY, logger });
runner.start();

// Stock and price changes reach WhatsApp / Instagram within ~5 minutes. The dedupe key (the 5-minute
// slot) means one sync per slot however many workers there are.
const SYNC_MS = 5 * 60 * 1000;
function scheduleCatalogSync() {
  if (!config.META_CATALOG_ID) return;
  const slot = Math.floor(Date.now() / SYNC_MS);
  enqueue("catalog.syncMeta", {}, { dedupeKey: `metasync:${slot}` }).catch((error) => logger.warn({ err: { message: error?.message } }, "could not schedule catalogue sync"));
}
// Booked parcels are checked with the courier every hour, in case a tracking webhook was missed.
const POLL_MS = 60 * 60 * 1000;
function scheduleTrackingPoll() {
  if (config.SHIPPING_PROVIDER === "none") return;
  const slot = Math.floor(Date.now() / POLL_MS);
  enqueue("shipping.poll", {}, { dedupeKey: `shippoll:${slot}` }).catch((error) => logger.warn({ err: { message: error?.message } }, "could not schedule tracking check"));
}
function scheduleAll() {
  scheduleCatalogSync();
  scheduleTrackingPoll();
}
scheduleAll();
const timer = setInterval(scheduleAll, 60 * 1000);
timer.unref();

let shuttingDown = false;
async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info({ signal }, "shutting down: finishing running jobs");
  clearInterval(timer);
  const force = setTimeout(() => process.exit(1), 60_000);
  force.unref();
  await runner.stop();
  await disconnectDb().catch(() => undefined);
  process.exit(0);
}
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("unhandledRejection", (reason) => logger.error({ err: { message: String(reason?.message || reason) } }, "unhandled rejection"));
