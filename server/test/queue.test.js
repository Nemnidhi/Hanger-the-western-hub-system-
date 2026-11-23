import test from "node:test";
import assert from "node:assert/strict";
import mongoose from "mongoose";
import { Job } from "../src/models/index.js";
import { enqueue, claim, complete, fail, RetryableError, LEASE_MS } from "../src/jobs/queue.js";
import { withTransaction } from "../src/db.js";
import { connectTestDb, clearCollections } from "./helpers.js";

test.before(connectTestDb);
test.beforeEach(clearCollections);
test.after(() => mongoose.disconnect());

test("enqueue with a dedupe key returns the first job instead of a second", async () => {
  const a = await enqueue("x", { n: 1 }, { dedupeKey: "same" });
  const b = await enqueue("x", { n: 2 }, { dedupeKey: "same" });
  assert.equal(String(a._id), String(b._id));
  assert.equal(await Job.countDocuments(), 1);
});

test("a job created in a transaction that rolls back does not exist", async () => {
  await assert.rejects(
    withTransaction(async (session) => {
      await enqueue("x", {}, { session });
      throw new Error("the record failed to save");
    }),
  );
  assert.equal(await Job.countDocuments(), 0);
});

test("two workers never get the same job", async () => {
  await enqueue("x", {});
  const [first, second] = await Promise.all([claim("w1"), claim("w2")]);
  assert.equal([first, second].filter(Boolean).length, 1);
});

test("a job is not taken before its time", async () => {
  await enqueue("x", {}, { runAt: new Date(Date.now() + 60_000) });
  assert.equal(await claim("w1"), null);
  assert.ok(await claim("w1", { now: new Date(Date.now() + 61_000) }));
});

test("retryable failures come back later; the last attempt makes the job dead, never lost", async () => {
  await enqueue("x", {}, { maxAttempts: 2 });
  let now = new Date();
  const job = await claim("w1", { now });
  assert.equal(await fail(job, "w1", new RetryableError("busy"), { now }), "retry");
  assert.equal(await claim("w1", { now }), null, "not before the backoff");
  now = new Date(now.getTime() + 2 * 60 * 60_000);
  const again = await claim("w1", { now });
  assert.equal(again.attempts, 2);
  assert.equal(await fail(again, "w1", new RetryableError("still busy"), { now }), "dead");
  const stored = await Job.findById(job._id);
  assert.equal(stored.status, "dead");
  assert.equal(stored.lastError, "still busy");
});

test("a non-retryable error makes the job dead at once", async () => {
  await enqueue("x", {});
  const job = await claim("w1");
  assert.equal(await fail(job, "w1", new Error("bad data")), "dead");
});

test("a job whose worker died is picked up again when its lease runs out", async () => {
  await enqueue("x", {});
  const job = await claim("dead-worker");
  assert.equal(await claim("w2"), null, "still leased");
  const later = new Date(Date.now() + LEASE_MS + 1000);
  const taken = await claim("w2", { now: later });
  assert.equal(String(taken._id), String(job._id));
  assert.equal(taken.attempts, 2);
  // The dead worker can no longer complete it.
  await complete(job, "dead-worker");
  assert.equal((await Job.findById(job._id)).status, "running");
  await complete(taken, "w2");
  assert.equal((await Job.findById(job._id)).status, "done");
});
