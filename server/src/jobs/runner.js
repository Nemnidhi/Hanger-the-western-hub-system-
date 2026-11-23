import os from "node:os";
import { randomUUID } from "node:crypto";
import { claim, complete, fail, heartbeat, LEASE_MS } from "./queue.js";

const IDLE_WAIT_MS = 500;

/**
 * Runs jobs with `handlers` ({ name: async (payload, { job }) => {} }), `concurrency` at a time.
 * stop() stops taking new jobs and waits for the running ones to finish, so a deploy or restart
 * never cuts a job in half on purpose (and if a process is killed, the lease brings the job back).
 */
export function createRunner({ handlers, concurrency = 4, logger, workerId = `${os.hostname()}-${process.pid}-${randomUUID().slice(0, 8)}` }) {
  let stopping = false;
  const loops = [];

  async function runOne(job) {
    const handler = handlers[job.name];
    const log = logger?.child({ jobId: String(job._id), job: job.name, attempt: job.attempts });
    if (!handler) {
      await fail(job, workerId, new Error(`No handler for job "${job.name}"`));
      log?.error("job has no handler");
      return;
    }
    const beat = setInterval(() => heartbeat(job, workerId).catch(() => undefined), LEASE_MS / 3);
    try {
      await handler(job.payload, { job, logger: log });
      await complete(job, workerId);
    } catch (error) {
      const outcome = await fail(job, workerId, error);
      log?.[outcome === "dead" ? "error" : "warn"]({ err: { message: error?.message, name: error?.name }, outcome }, "job failed");
    } finally {
      clearInterval(beat);
    }
  }

  async function loop() {
    while (!stopping) {
      let job = null;
      try {
        job = await claim(workerId, { names: Object.keys(handlers) });
      } catch (error) {
        logger?.error({ err: { message: error?.message } }, "could not claim a job; retrying");
      }
      if (!job) {
        await new Promise((resolve) => setTimeout(resolve, IDLE_WAIT_MS));
        continue;
      }
      await runOne(job);
    }
  }

  return {
    workerId,
    start() {
      for (let i = 0; i < concurrency; i += 1) loops.push(loop());
      logger?.info({ workerId, concurrency }, "worker started");
    },
    async stop() {
      stopping = true;
      await Promise.all(loops);
      logger?.info({ workerId }, "worker stopped");
    },
  };
}

/**
 * Test helper: runs every due job until none is left (or `maxJobs`), in this process, one at a time.
 * `now` lets a test step past backoff delays without waiting.
 */
export async function drain(handlers, { now = () => new Date(), maxJobs = 500, workerId = "drain" } = {}) {
  let ran = 0;
  for (; ran < maxJobs; ran += 1) {
    const job = await claim(workerId, { now: now(), names: Object.keys(handlers) });
    if (!job) break;
    const handler = handlers[job.name];
    try {
      await handler(job.payload, { job });
      await complete(job, workerId, { now: now() });
    } catch (error) {
      await fail(job, workerId, error, { now: now() });
    }
  }
  return ran;
}
