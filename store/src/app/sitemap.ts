import type { MetadataRoute } from "next";
import { getCatalog, siteUrl } from "@/lib/server";

export const revalidate = 3600;

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const base = siteUrl();
  const catalog = await getCatalog();
  const styles = catalog?.styles || [];
  const categories = catalog?.facets.categories || [];
  return [
    { url: `${base}/`, changeFrequency: "daily", priority: 1 },
    { url: `${base}/shop`, changeFrequency: "daily", priority: 0.9 },
    { url: `${base}/size-guide`, changeFrequency: "monthly", priority: 0.3 },
    ...categories.map((category) => ({ url: `${base}/shop?category=${encodeURIComponent(category)}`, changeFrequency: "daily" as const, priority: 0.7 })),
    ...styles.map((style) => ({ url: `${base}/p/${style.slug}`, lastModified: style.liveAt ? new Date(style.liveAt) : undefined, changeFrequency: "weekly" as const, priority: style.inStock ? 0.8 : 0.3, images: style.images.slice(0, 1) })),
  ];
}
