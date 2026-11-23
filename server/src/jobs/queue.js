import mongoose from "mongoose";
import { Job } from "../models/index.js";
import { isDuplicateKeyError } from "../db.js";

// A job is claimed for LEASE_MS; a worker that dies mid-job simply lets the lease run out, and the
// job is picked up again. Handlers must therefore be idempotent (safe to run twice) - every handler
// in this app checks what it already did before acting.
export const LEASE_MS = 60_000;
const BACKOFF_BASE_MS = 5_000;
const BACKOFF_CAP_MS = 60 * 60_000;

/** A failure worth retrying later (network, Meta busy, record not there yet). */
export class RetryableError extends Error {
  constructor(message, { delayMs } = {}) {
    super(message);
    this.name = "RetryableError";
    this.delayMs = delayMs;
  }
}

/**
 * Adds a job. Pass `session` to create it inside the caller's transaction, so it exists only if the
 * record it belongs to was saved. With `dedupeKey`, a second call returns the existing job.
 */
export async function enqueue(name, payload = {}, { runAt, dedupeKey, maxAttempts, session } = {}) {
  const doc = { name, payload, runAt: runAt || new Date() };
  if (dedupeKey) doc.dedupeKey = dedupeKey;
  if (maxAttempts) doc.maxAttempts = maxAttempts;
  try {
    const [job] = await Job.create([doc], session ? { session } : {});
    return job;
  } catch (error) {
    // Inside a transaction a duplicate aborts the transaction, so the caller must not swallow it there.
    if (dedupeKey && !session && isDuplicateKeyError(error)) return Job.findOne({ dedupeKey });
    throw error;
  }
}

/** Takes the next due job (or one whose worker died), for `workerId`, or null when there is none. */
export async function claim(workerId, { now = new Date(), names } = {}) {
  // Operators are marked trusted one by one: the global sanitizeFilter strips untrusted ones.
  const due = {
    $or: [
      { status: "queued", runAt: mongoose.trusted({ $lte: now }) },
      { status: "running", lockedUntil: mongoose.trusted({ $lt: now }) },
    ],
  };
  if (names?.length) due.name = mongoose.trusted({ $in: names });
  return Job.findOneAndUpdate(
    mongoose.trusted(due),
    { $set: { status: "running", lockedBy: workerId, lockedUntil: new Date(now.getTime() + LEASE_MS) }, $inc: { attempts: 1 } },
    { sort: { runAt: 1 }, new: true },
  );
}

/** Extends the lease of a long-running job. */
export async function heartbeat(job, workerId, { now = new Date() } = {}) {
  await Job.updateOne({ _id: job._id, lockedBy: workerId, status: "running" }, { $set: { lockedUntil: new Date(now.getTime() + LEASE_MS) } });
}

export async function complete(job, workerId, { now = new Date() } = {}) {
  await Job.updateOne({ _id: job._id, lockedBy: workerId }, { $set: { status: "done", finishedAt: now, lockedUntil: null, lastError: "" } });
}

/** Exponential backoff with jitter: about 5s, 10s, 20s ... capped at an hour. */
export function backoffMs(attempts) {
  const exponential = Math.min(BACKOFF_CAP_MS, BACKOFF_BASE_MS * 2 ** Math.max(0, attempts - 1));
  return Math.round(exponential * (0.8 + Math.random() * 0.4));
}

/**
 * Records a failure. Retryable failures go back in the queue with backoff until maxAttempts; anything
 * else, or the last attempt, makes the job "dead" - kept for a person to look at, never silently dropped.
 */
export async function fail(job, workerId, error, { now = new Date() } = {}) {
  const retryable = error instanceof RetryableError;
  const message = String(error?.message || error).slice(0, 1000);
  if (retryable && job.attempts < job.maxAttempts) {
    const delay = error.delayMs ?? backoffMs(job.attempts);
    await Job.updateOne(
      { _id: job._id, lockedBy: workerId },
      { $set: { status: "queued", runAt: new Date(now.getTime() + delay), lockedUntil: null, lockedBy: "", lastError: message } },
    );
    return "retry";
  }
  await Job.updateOne({ _id: job._id, lockedBy: workerId }, { $set: { status: "dead", finishedAt: now, lockedUntil: null, lastError: message } });
  return "dead";
}

/** Numbers for the readiness check and the owner's dashboard. */
export async function queueStats({ now = new Date() } = {}) {
  const [queued, running, dead, oldestDue] = await Promise.all([
    Job.countDocuments({ status: "queued" }),
    Job.countDocuments({ status: "running" }),
    Job.countDocuments({ status: "dead" }),
    Job.findOne({ status: "queued", runAt: mongoose.trusted({ $lte: now }) }).sort({ runAt: 1 }).select("runAt").lean(),
  ]);
  const overdueSeconds = oldestDue ? Math.max(0, Math.round((now - oldestDue.runAt) / 1000)) : 0;
  return { queued, running, dead, overdueSeconds };
}
