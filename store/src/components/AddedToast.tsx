"use client";

import Link from "next/link";
import { useEffect } from "react";
import { useBag } from "@/lib/bag";
import { rupees } from "@/lib/format";

/** "Added to your bag": shown for a few seconds after a piece goes in. */
export function AddedToast() {
  const { lastAdded, dismissAdded, count } = useBag();
  useEffect(() => {
    if (!lastAdded) return;
    const timer = window.setTimeout(dismissAdded, 6000);
    return () => window.clearTimeout(timer);
  }, [lastAdded, dismissAdded]);
  if (!lastAdded) return null;
  return (
    <div className="added" role="status">
      <div className="row">
        {lastAdded.image ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={lastAdded.image} alt="" />
        ) : (
          <span className="mini" />
        )}
        <div style={{ minWidth: 0 }}>
          <div className="small muted">Added to your bag</div>
          <div className="serif" style={{ fontSize: 18 }}>
            {lastAdded.name}
          </div>
          <div className="small muted">
            Size {lastAdded.size} · {rupees(lastAdded.pricePaise)}
          </div>
        </div>
      </div>
      <div style={{ display: "flex", gap: 8 }}>
        <Link className="btn dark small" href="/bag" onClick={dismissAdded} style={{ flex: 1 }}>
          View bag ({count})
        </Link>
        <button className="btn ghost small" onClick={dismissAdded}>
          Keep looking
        </button>
      </div>
    </div>
  );
}
