import { useCallback, useEffect, useState, type ReactNode } from "react";
import { api } from "./api";

/** Runs an action with a busy flag and a readable error. */
export function useRun() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const run = useCallback(async <T,>(action: () => Promise<T>): Promise<T | undefined> => {
    setBusy(true);
    setError("");
    try {
      return await action();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
      return undefined;
    } finally {
      setBusy(false);
    }
  }, []);
  return { busy, error, setError, run };
}

/** Loads a GET endpoint; `reload` fetches it again. */
export function useLoad<T>(path: string | null) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState("");
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (!path) return;
    let live = true;
    api<T>(path)
      .then((result) => {
        if (live) {
          setData(result);
          setError("");
        }
      })
      .catch((failure) => live && setError(failure.message));
    return () => {
      live = false;
    };
  }, [path, tick]);
  const reload = useCallback(() => setTick((value) => value + 1), []);
  return { data, error, reload, setData };
}

export function Notice({ tone = "error", children }: { tone?: "error" | "warn" | "ok" | ""; children: ReactNode }) {
  if (!children) return null;
  return (
    <div className={`notice ${tone}`} role={tone === "error" ? "alert" : "status"}>
      {children}
    </div>
  );
}

export function Dialog({ title, onClose, children, wide = false }: { title: string; onClose: () => void; children: ReactNode; wide?: boolean }) {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => event.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  return (
    <div className="dialog-backdrop" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <div className={`dialog${wide ? " wide" : ""}`} role="dialog" aria-modal="true" aria-label={title}>
        <h2>{title}</h2>
        {children}
      </div>
    </div>
  );
}

/** Rupees typed by staff ("1,999" or "1999.50") to paise; NaN when it is not a number. */
export function toPaise(text: string): number {
  const value = Number(String(text).replace(/[, ]/g, ""));
  return Number.isFinite(value) ? Math.round(value * 100) : NaN;
}
