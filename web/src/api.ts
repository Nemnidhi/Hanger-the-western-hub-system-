// Every call to the server goes through here: same-origin cookie, the app header the server requires
// on changes (cross-site protection), and errors turned into readable messages.
export class ApiError extends Error {
  constructor(public status: number, public code: string, message: string, public blockers?: string[]) {
    super(message);
  }
}

export async function api<T = unknown>(path: string, options: { method?: string; body?: unknown } = {}): Promise<T> {
  let response: Response;
  try {
    response = await fetch(path, {
      method: options.method || "GET",
      credentials: "same-origin",
      headers: { "x-hanger-app": "1", ...(options.body !== undefined ? { "content-type": "application/json" } : {}) },
      body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
    });
  } catch {
    throw new ApiError(0, "OFFLINE", "Cannot reach the server. Check the internet connection.");
  }
  const data = await response.json().catch(() => null);
  // Signed out elsewhere (owner disabled the account, password changed): back to the sign-in screen.
  if (response.status === 401 && !path.startsWith("/api/auth/")) window.dispatchEvent(new Event("session-expired"));
  if (!response.ok) {
    throw new ApiError(response.status, data?.error || "ERROR", data?.message || `Request failed (${response.status}).`, Array.isArray(data?.blockers) ? data.blockers : undefined);
  }
  return data as T;
}

export type NextStep = "two_factor" | "change_password" | "two_factor_setup" | null;
export type Role = "owner" | "manager" | "staff" | "packer";

export interface User {
  id: string;
  name: string;
  email: string;
  phone: string;
  role: Role;
  status: "active" | "disabled";
  mustChangePassword: boolean;
  twoFactorEnabled: boolean;
  lastLoginAt: string | null;
}

export interface Me {
  user: User;
  next: NextStep;
  permissions: string[];
}

export interface Conversation {
  id: string;
  contact: { id: string; name: string; waId: string } | null;
  status: "open" | "waiting" | "closed";
  assignedTo: string;
  unread: number;
  lastMessageAt: string | null;
  window: { open: boolean; closesAt: string | null };
  lastMessage: { direction: "in" | "out"; type: string; text: string; status: string } | null;
}

export interface Message {
  id: string;
  direction: "in" | "out";
  type: string;
  text: string;
  template: { name: string } | null;
  media: { mimeType: string; caption: string; filename: string } | null;
  location: { latitude: number; longitude: number; name: string; address: string } | null;
  status: string;
  error: { code: number; text: string; action: string } | null;
  at: string;
  sentAt: string | null;
  transcript: "done" | "too_long" | "failed" | null;
}

export interface Template {
  name: string;
  language: string;
  category: string;
  status: string;
  bodyText: string;
  paramCount: number;
  rejectedReason: string;
}

export interface TeamMember {
  id: string;
  name: string;
  role: Role;
}

export const can = (me: Me | null, permission: string) => Boolean(me && (me.permissions.includes("*") || me.permissions.includes(permission)));
