import mongoose from "mongoose";

// Query filters from requests are never trusted as operators ({"$gt": ""} etc.); code that needs an
// operator wraps it in mongoose.trusted().
mongoose.set("sanitizeFilter", true);
mongoose.set("strictQuery", true);

/**
 * Connects and refuses to run on a standalone MongoDB: an order, its records and its follow-up jobs
 * are written in one transaction, which needs a replica set.
 */
export async function connectDb(uri, { logger, buildIndexes = true } = {}) {
  await mongoose.connect(uri, {
    serverSelectionTimeoutMS: 10_000,
    retryWrites: true,
    retryReads: true,
    writeConcern: { w: "majority" },
  });
  const hello = await mongoose.connection.db.admin().command({ hello: 1 });
  if (!hello.setName) {
    await mongoose.disconnect();
    throw new Error("MongoDB must run as a replica set: transactions are required. See README (development replica set).");
  }
  // Build every model's indexes before serving: unique indexes are what make webhook handling idempotent.
  if (buildIndexes) await migrateIndexes(logger);
  if (buildIndexes) await Promise.all(Object.values(mongoose.models).map((model) => model.init()));
  logger?.info({ replicaSet: hello.setName }, "database connected");
  return mongoose.connection;
}

/** Indexes replaced by newer ones: dropped once, before the new ones are built. */
async function migrateIndexes(logger) {
  const old = [["invoices", "orderId_1_kind_1"]]; // one credit note per order -> one per return (27 Nov 2026)
  for (const [collection, name] of old) {
    try {
      await mongoose.connection.db.collection(collection).dropIndex(name);
      logger?.info({ collection, index: name }, "old index dropped");
    } catch (error) {
      if (![26, 27].includes(error?.code)) throw error; // 26: no collection, 27: no such index
    }
  }
}

export async function disconnectDb() {
  await mongoose.disconnect();
}

/** Runs fn(session) in a transaction, retrying on transient errors; returns fn's result. */
export async function withTransaction(fn) {
  const session = await mongoose.startSession();
  try {
    let result;
    await session.withTransaction(async () => {
      result = await fn(session);
    });
    return result;
  } finally {
    await session.endSession();
  }
}

export function isDuplicateKeyError(error) {
  return error?.code === 11000 || error?.cause?.code === 11000;
}
