const timeFormat = new Intl.DateTimeFormat("en-IN", { hour: "numeric", minute: "2-digit" });
const dayFormat = new Intl.DateTimeFormat("en-IN", { day: "numeric", month: "short" });

/** "4:05 pm" today, "Yesterday", or "3 Nov". */
export function shortTime(value: string | null | undefined): string {
  if (!value) return "";
  const date = new Date(value);
  const now = new Date();
  if (date.toDateString() === now.toDateString()) return timeFormat.format(date);
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (date.toDateString() === yesterday.toDateString()) return "Yesterday";
  return dayFormat.format(date);
}

export function clockTime(value: string | null | undefined): string {
  return value ? timeFormat.format(new Date(value)) : "";
}

/** "+91 98000 00001" from "919800000001". */
export function phone(waId: string | undefined): string {
  if (!waId) return "";
  if (waId.startsWith("91") && waId.length === 12) return `+91 ${waId.slice(2, 7)} ${waId.slice(7)}`;
  return `+${waId}`;
}

/** How long a free reply is still allowed: "5 h 20 min left". */
export function timeLeft(until: string | null): string {
  if (!until) return "";
  const minutes = Math.max(0, Math.round((new Date(until).getTime() - Date.now()) / 60000));
  if (minutes >= 60) return `${Math.floor(minutes / 60)} h ${minutes % 60} min left`;
  return `${minutes} min left`;
}

export const roleLabel: Record<string, string> = { owner: "Owner", manager: "Manager", staff: "Store staff", packer: "Packer" };

/** "Rs 1,999" or "Rs 1,903.81" from paise. */
export function rupees(paise: number | null | undefined): string {
  const value = (paise || 0) / 100;
  return `Rs ${value.toLocaleString("en-IN", { minimumFractionDigits: value % 1 ? 2 : 0, maximumFractionDigits: 2 })}`;
}

const dateTime = new Intl.DateTimeFormat("en-IN", { day: "numeric", month: "short", hour: "numeric", minute: "2-digit" });
export const when = (value: string | null | undefined) => (value ? dateTime.format(new Date(value)) : "");
export const dateOnly = (value: string | null | undefined) => (value ? new Intl.DateTimeFormat("en-IN", { day: "numeric", month: "short", year: "numeric" }).format(new Date(value)) : "");
