import { Sku, Style } from "../models/index.js";
import { isDuplicateKeyError } from "../db.js";

const httpError = (status, message, code) => Object.assign(new Error(message), { status, code });

export const SIZE_ORDER = ["XXS", "XS", "S", "M", "L", "XL", "XXL", "3XL", "4XL", "5XL", "FREE"];

/** Sizes in the usual order (XS before S before M...), then numeric sizes, then anything else. */
export function sortSizes(sizes) {
  const rank = (size) => {
    const index = SIZE_ORDER.indexOf(size);
    if (index >= 0) return [0, index];
    if (/^\d+$/.test(size)) return [1, Number(size)];
    return [2, size];
  };
  return [...sizes].sort((a, b) => {
    const [ga, va] = rank(a);
    const [gb, vb] = rank(b);
    return ga - gb || (va < vb ? -1 : va > vb ? 1 : 0);
  });
}

/** A new style with one SKU per size (code = STYLE-SIZE). Starts as a draft, not shown anywhere. */
export async function createStyle({ tenantId, data, sizes, session }) {
  const cleanSizes = sortSizes([...new Set(sizes.map((size) => String(size).trim().toUpperCase()).filter(Boolean))]);
  if (!cleanSizes.length) throw httpError(400, "Give at least one size", "NO_SIZES");
  try {
    const [style] = await Style.create([{ tenantId, ...data, status: "draft" }], { session });
    const skus = await Sku.create(
      cleanSizes.map((size) => ({ tenantId, styleId: style._id, styleCode: style.code, code: `${style.code}-${size}`, size, pricePaise: style.pricePaise })),
      { session, ordered: true },
    );
    return { style, skus };
  } catch (error) {
    if (isDuplicateKeyError(error)) throw httpError(409, `Style code ${data.code} is already used`, "DUPLICATE_CODE");
    throw error;
  }
}

/** Adds sizes to an existing style. */
export async function addSizes({ tenantId, style, sizes, session }) {
  const existing = new Set((await Sku.find({ styleId: style._id }).session(session)).map((sku) => sku.size));
  const fresh = sortSizes([...new Set(sizes.map((size) => String(size).trim().toUpperCase()).filter((size) => size && !existing.has(size)))]);
  if (!fresh.length) return [];
  return Sku.create(fresh.map((size) => ({ tenantId, styleId: style._id, styleCode: style.code, code: `${style.code}-${size}`, size, pricePaise: style.pricePaise })), { session, ordered: true });
}

/** Changes a style. A new price goes to every size; any change is sent to Meta's catalogue. */
export async function updateStyle({ style, changes, session }) {
  const { status, ...rest } = changes;
  Object.assign(style, rest);
  if (status && status !== style.status) {
    style.status = status;
    if (status === "live" && !style.liveAt) style.liveAt = new Date();
  }
  if (style.status === "live" && !style.images.length) throw httpError(409, "Add at least one photo before putting a style live.", "NO_IMAGES");
  await style.save({ session });
  const set = { metaDirty: true };
  if (changes.pricePaise) set.pricePaise = changes.pricePaise;
  await Sku.updateMany({ styleId: style._id }, { $set: set }, { session });
  return style;
}
