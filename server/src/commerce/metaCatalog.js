import mongoose from "mongoose";
import { Sku, StockLevel, Style } from "../models/index.js";
import { RetryableError } from "../jobs/queue.js";

// Keeps Meta's commerce catalogue (shown in WhatsApp and Instagram) in step with our own: every size
// is one catalogue item whose retailer id is our SKU code, grouped by style, with price and stock.
// Our catalogue is the record; Meta's is a copy. Stock and price changes mark a SKU "dirty"; this job
// sends the dirty ones in batches through the Graph API's items_batch endpoint and clears the mark.

const BATCH = 500;

export function metaItem({ sku, style, available, storeUrl }) {
  const item = {
    id: sku.code,
    item_group_id: style.code,
    title: `${style.name} - ${sku.size}`.slice(0, 150),
    description: (style.description || style.name).slice(0, 5000),
    availability: style.status === "live" && available > 0 ? "in stock" : "out of stock",
    inventory: style.status === "live" ? Math.max(0, available) : 0,
    condition: "new",
    price: `${(sku.pricePaise / 100).toFixed(2)} INR`,
    brand: "The Hanger",
    size: sku.size,
  };
  if (style.attributes?.colour) item.color = style.attributes.colour;
  if (style.attributes?.fabric) item.material = style.attributes.fabric;
  if (style.images?.[0]) item.image_link = style.images[0];
  if (style.images?.length > 1) item.additional_image_link = style.images.slice(1, 10).join(",");
  if (storeUrl) item.link = `${storeUrl.replace(/\/$/, "")}/p/${encodeURIComponent(style.code.toLowerCase())}?size=${encodeURIComponent(sku.size)}`;
  return item;
}

export function createMetaCatalogHandlers({ config, fetchImpl = fetch, now = () => new Date() }) {
  const tenantId = config.TENANT_ID;
  return {
    async "catalog.syncMeta"() {
      if (!config.META_CATALOG_ID) return;
      const url = `${config.META_GRAPH_BASE.replace(/\/$/, "")}/${config.META_GRAPH_VERSION}/${config.META_CATALOG_ID}/items_batch`;
      for (let round = 0; round < 50; round += 1) {
        const skus = await Sku.find({ tenantId, metaDirty: true }).sort({ updatedAt: 1 }).limit(BATCH);
        if (!skus.length) return;
        const styles = await Style.find({ _id: mongoose.trusted({ $in: skus.map((sku) => sku.styleId) }) });
        const styleById = new Map(styles.map((style) => [String(style._id), style]));
        const levels = await StockLevel.aggregate([
          { $match: { skuId: mongoose.trusted({ $in: skus.map((sku) => sku._id) }) } },
          { $group: { _id: "$skuId", available: { $sum: "$available" } } },
        ]);
        const availableBySku = new Map(levels.map((row) => [String(row._id), row.available]));
        // A draft style never goes to Meta; one that was live and is now archived goes as out of stock.
        const requests = skus
          .filter((sku) => styleById.get(String(sku.styleId))?.status !== "draft")
          .map((sku) => ({ method: "UPDATE", data: metaItem({ sku, style: styleById.get(String(sku.styleId)), available: availableBySku.get(String(sku._id)) || 0, storeUrl: config.PUBLIC_STORE_URL }) }));
        const startedAt = now();
        if (requests.length) {
          let response;
          try {
            response = await fetchImpl(url, {
              method: "POST",
              headers: { Authorization: `Bearer ${config.WHATSAPP_ACCESS_TOKEN}`, "Content-Type": "application/json" },
              body: JSON.stringify({ item_type: "PRODUCT_ITEM", allow_upsert: true, requests }),
              signal: AbortSignal.timeout(30_000),
            });
          } catch (error) {
            throw new RetryableError(`Could not reach Meta: ${error?.message}`);
          }
          const data = await response.json().catch(() => ({}));
          if (!response.ok) {
            const message = `Meta refused the catalogue update (HTTP ${response.status}): ${data?.error?.message || "no details"}`;
            if (response.status === 429 || response.status >= 500) throw new RetryableError(message);
            throw new Error(message);
          }
        }
        // Cleared only if not changed again while sending (updatedAt still what was sent).
        for (const sku of skus) {
          await Sku.updateOne({ _id: sku._id, updatedAt: sku.updatedAt }, { $set: { metaDirty: false, metaSyncedAt: startedAt } }, { timestamps: false });
        }
      }
    },
  };
}
