"use client";

// The browser's calls to /api/shop (forwarded to the platform). Changes carry the app header the API
// asks for; errors come back as the API's own message in plain words.
export class ShopError extends Error {
  status: number;
  code: string;
  constructor(message: string, status: number, code = "") {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export async function shop<T>(path: string, { method = "GET", body }: { method?: string; body?: unknown } = {}): Promise<T> {
  const headers: Record<string, string> = { "x-hanger-app": "1" };
  if (body !== undefined) headers["content-type"] = "application/json";
  let response: Response;
  try {
    response = await fetch(`/api/shop${path}`, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined, credentials: "same-origin", cache: "no-store" });
  } catch {
    throw new ShopError("We could not reach the shop. Check your connection and try again.", 0);
  }
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new ShopError(data?.message || "Something went wrong. Please try again.", response.status, data?.error || "");
  return data as T;
}

export const errorText = (error: unknown) => (error instanceof Error ? error.message : "Something went wrong. Please try again.");
