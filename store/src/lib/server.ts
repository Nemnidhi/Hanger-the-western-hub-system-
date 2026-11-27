import type { Facets, ShopInfo, SizeChart, Style } from "./types";

// Reads from the platform's API on the server. The collection is cached for a minute, so stock and
// prices on the site are at most a minute behind the shop (the bag re-prices from the API anyway).
const API = (process.env.HANGER_API_URL || "http://localhost:4200").replace(/\/$/, "");

async function get<T>(path: string, revalidate = 60): Promise<T | null> {
  try {
    const response = await fetch(`${API}${path}`, { next: { revalidate } });
    if (response.status === 404) return null;
    if (!response.ok) throw new Error(`API ${response.status} for ${path}`);
    return (await response.json()) as T;
  } catch (error) {
    console.error("storefront API", path, error);
    return null;
  }
}

export const getInfo = () => get<ShopInfo>("/api/shop/info", 300);

export function getCatalog(params: Record<string, string | undefined> = {}) {
  const query = new URLSearchParams(Object.entries(params).filter((entry): entry is [string, string] => Boolean(entry[1])));
  const text = query.toString();
  return get<{ styles: Style[]; facets: Facets }>(`/api/shop/catalog${text ? `?${text}` : ""}`);
}

export const getStyle = (slug: string) => get<{ style: Style; pairs: Style[]; sizeChart: SizeChart | null }>(`/api/shop/styles/${encodeURIComponent(slug)}`);

export const search = (q: string) => get<{ styles: Style[] }>(`/api/shop/search?q=${encodeURIComponent(q)}`, 30);

export const siteUrl = () => (process.env.SITE_URL || "http://localhost:4300").replace(/\/$/, "");
