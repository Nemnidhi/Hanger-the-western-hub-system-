import mongoose from "mongoose";

// Gap-free running numbers (order numbers), safe under concurrent use.
const counterSchema = new mongoose.Schema({ _id: { type: String, required: true }, seq: { type: Number, default: 0 } }, { versionKey: false });

export const Counter = mongoose.models.Counter || mongoose.model("Counter", counterSchema);

export async function nextNumber(name, session) {
  const counter = await Counter.findOneAndUpdate({ _id: name }, { $inc: { seq: 1 } }, { upsert: true, new: true, session });
  return counter.seq;
}
