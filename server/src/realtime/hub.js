import mongoose from "mongoose";

const RESTART_MS = 2000;
const HEARTBEAT_MS = 25_000;

/**
 * Live updates for the staff app. Messages are saved by the worker (another process), so this hub
 * watches the database itself (MongoDB change stream) and tells each open browser what changed. Only
 * ids are sent; the browser then loads what it is allowed to see through the normal API. If the stream
 * breaks it restarts from where it stopped (resume token), so no update is skipped.
 */
export function createRealtimeHub({ tenantId, logger }) {
  const clients = new Set();
  let stream = null;
  let resumeToken = null;
  let restartTimer = null;
  let heartbeat = null;

  function broadcast(event) {
    const frame = `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
    for (const res of clients) res.write(frame);
  }

  function start() {
    if (stream || !clients.size) return;
    const pipeline = [{ $match: { "ns.coll": { $in: ["messages", "conversations", "orders", "invoices"] }, operationType: { $in: ["insert", "update", "replace"] } } }];
    try {
      stream = mongoose.connection.db.watch(pipeline, { fullDocument: "updateLookup", ...(resumeToken ? { resumeAfter: resumeToken } : {}) });
    } catch (error) {
      logger?.error({ err: { message: error?.message } }, "live updates could not start; retrying");
      restartTimer = setTimeout(start, RESTART_MS);
      return;
    }
    stream.on("change", (change) => {
      resumeToken = change._id;
      const doc = change.fullDocument;
      if (!doc || doc.tenantId !== tenantId) return;
      if (change.ns.coll === "messages") broadcast({ type: "message", conversationId: String(doc.conversationId), messageId: String(doc._id) });
      else if (change.ns.coll === "orders") broadcast({ type: "order", orderId: String(doc._id), conversationId: String(doc.conversationId) });
      else if (change.ns.coll === "invoices") broadcast({ type: "order", orderId: String(doc.orderId) });
      else broadcast({ type: "conversation", conversationId: String(doc._id) });
    });
    stream.on("error", (error) => {
      logger?.warn({ err: { message: error?.message } }, "live updates stream broke; restarting");
      stream?.close().catch(() => undefined);
      stream = null;
      clearTimeout(restartTimer);
      restartTimer = setTimeout(start, RESTART_MS);
    });
  }

  function stop() {
    clearTimeout(restartTimer);
    stream?.close().catch(() => undefined);
    stream = null;
  }

  return {
    /** Express handler for GET /api/events (server-sent events). */
    connect(req, res) {
      res.set({ "Content-Type": "text/event-stream", "Cache-Control": "no-store", Connection: "keep-alive", "X-Accel-Buffering": "no" });
      res.flushHeaders();
      res.write(": connected\n\n");
      clients.add(res);
      if (!heartbeat) heartbeat = setInterval(() => clients.forEach((client) => client.write(": ping\n\n")), HEARTBEAT_MS);
      start();
      req.on("close", () => {
        clients.delete(res);
        if (!clients.size) {
          clearInterval(heartbeat);
          heartbeat = null;
          stop();
        }
      });
    },
    get clientCount() {
      return clients.size;
    },
    close() {
      clearInterval(heartbeat);
      heartbeat = null;
      for (const res of clients) res.end();
      clients.clear();
      stop();
    },
  };
}
