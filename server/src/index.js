import { loadConfig } from "./config.js";
import { createLogger } from "./logger.js";
import { connectDb, disconnectDb } from "./db.js";
import { createApp } from "./app.js";
import "./models/index.js";

// The web process: receives Meta's webhooks and serves the staff app's API. It never does slow work
// itself; that is the worker's job (src/worker.js). Run two or more of these behind nginx (pm2
// cluster) so a restart or a crash of one never takes the service down.
const config = loadConfig();
const logger = createLogger({ level: config.LOG_LEVEL, name: "hanger-api" });

await connectDb(config.MONGODB_URI, { logger });
const app = createApp({ config, logger });
const server = app.listen(config.PORT, () => logger.info({ port: config.PORT }, "api listening"));
server.keepAliveTimeout = 65_000;
server.headersTimeout = 66_000;

let shuttingDown = false;
async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info({ signal }, "shutting down: finishing open requests");
  const force = setTimeout(() => process.exit(1), 20_000);
  force.unref();
  // Live-update connections stay open forever; end them so the server can close.
  app.locals.realtime?.close();
  server.close(async () => {
    await disconnectDb().catch(() => undefined);
    process.exit(0);
  });
}
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("unhandledRejection", (reason) => logger.error({ err: { message: String(reason?.message || reason) } }, "unhandled rejection"));
