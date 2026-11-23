import mongoose from "mongoose";

// A durable job: anything that must happen even if a process dies halfway (processing a WhatsApp
// event, sending a message, a reminder). Kept in MongoDB, not Redis, so a job is created in the same
// transaction as the record it belongs to - there is no moment where one exists without the other.
const jobSchema = new mongoose.Schema(
  {
    name: { type: String, required: true },
    payload: { type: mongoose.Schema.Types.Mixed, default: {} },
    status: { type: String, enum: ["queued", "running", "done", "dead"], default: "queued" },
    runAt: { type: Date, default: () => new Date() },
    attempts: { type: Number, default: 0 },
    maxAttempts: { type: Number, default: 8 },
    // Optional: a second enqueue with the same key returns the first job instead of a duplicate.
    dedupeKey: { type: String },
    lockedBy: { type: String, default: "" },
    lockedUntil: { type: Date, default: null },
    lastError: { type: String, default: "" },
    finishedAt: { type: Date, default: null },
  },
  { timestamps: true },
);

jobSchema.index({ status: 1, runAt: 1 });
jobSchema.index({ status: 1, lockedUntil: 1 });
jobSchema.index({ dedupeKey: 1 }, { unique: true, partialFilterExpression: { dedupeKey: { $type: "string" } } });
// Finished jobs are kept 30 days for tracing, then removed. Dead jobs stay until someone looks at them.
jobSchema.index({ finishedAt: 1 }, { expireAfterSeconds: 30 * 24 * 3600, partialFilterExpression: { status: "done" } });

export const Job = mongoose.models.Job || mongoose.model("Job", jobSchema);
