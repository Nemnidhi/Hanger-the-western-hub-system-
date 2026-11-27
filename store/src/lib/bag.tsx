"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import type { BagLine } from "./types";

// The bag lives in the browser until checkout (the API prices it again, with stock, at every step).
const KEY = "hanger-bag-v1";

interface BagValue {
  lines: BagLine[];
  ready: boolean;
  count: number;
  add: (line: Omit<BagLine, "qty">, qty?: number) => void;
  setQty: (skuCode: string, qty: number) => void;
  remove: (skuCode: string) => void;
  clear: () => void;
  lastAdded: BagLine | null;
  dismissAdded: () => void;
}

const BagContext = createContext<BagValue | null>(null);

function read(): BagLine[] {
  try {
    const parsed = JSON.parse(window.localStorage.getItem(KEY) || "[]");
    return Array.isArray(parsed) ? parsed.filter((line) => line && typeof line.skuCode === "string" && Number.isInteger(line.qty) && line.qty > 0) : [];
  } catch {
    return [];
  }
}

export function BagProvider({ children }: { children: ReactNode }) {
  const [lines, setLines] = useState<BagLine[]>([]);
  const [ready, setReady] = useState(false);
  const [lastAdded, setLastAdded] = useState<BagLine | null>(null);

  useEffect(() => {
    setLines(read());
    setReady(true);
    const onStorage = (event: StorageEvent) => event.key === KEY && setLines(read());
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);

  useEffect(() => {
    if (!ready) return;
    try {
      window.localStorage.setItem(KEY, JSON.stringify(lines));
    } catch {
      // Private mode: the bag lasts for this visit only.
    }
  }, [lines, ready]);

  const add = useCallback((line: Omit<BagLine, "qty">, qty = 1) => {
    setLines((current) => {
      const found = current.find((row) => row.skuCode === line.skuCode);
      const next = found ? current.map((row) => (row.skuCode === line.skuCode ? { ...row, ...line, qty: Math.min(20, row.qty + qty) } : row)) : [...current, { ...line, qty }];
      setLastAdded(next.find((row) => row.skuCode === line.skuCode) || null);
      return next;
    });
  }, []);
  const setQty = useCallback((skuCode: string, qty: number) => setLines((current) => current.map((row) => (row.skuCode === skuCode ? { ...row, qty: Math.max(1, Math.min(20, qty)) } : row))), []);
  const remove = useCallback((skuCode: string) => setLines((current) => current.filter((row) => row.skuCode !== skuCode)), []);
  const clear = useCallback(() => setLines([]), []);
  const dismissAdded = useCallback(() => setLastAdded(null), []);

  const value = useMemo(() => ({ lines, ready, count: lines.reduce((sum, line) => sum + line.qty, 0), add, setQty, remove, clear, lastAdded, dismissAdded }), [lines, ready, add, setQty, remove, clear, lastAdded, dismissAdded]);
  return <BagContext.Provider value={value}>{children}</BagContext.Provider>;
}

export function useBag() {
  const value = useContext(BagContext);
  if (!value) throw new Error("useBag outside BagProvider");
  return value;
}
