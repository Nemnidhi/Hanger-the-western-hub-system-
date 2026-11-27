"use client";

import Link from "next/link";
import { useEffect, useRef, useState, type CSSProperties } from "react";
import { useBag } from "@/lib/bag";
import { errorText, shop } from "@/lib/client";
import { backdrop, rupees } from "@/lib/format";
import type { Account, Quote } from "@/lib/types";

export default function BagPage() {
  const { lines, ready, setQty, remove } = useBag();
  const [quote, setQuote] = useState<Quote | null>(null);
  const [error, setError] = useState("");
  const [account, setAccount] = useState<Account | null>(null);
  const told = useRef(false);
  const key = lines.map((line) => `${line.skuCode}x${line.qty}`).join(",");

  useEffect(() => {
    shop<{ account: Account | null }>("/me").then((result) => setAccount(result.account)).catch(() => setAccount(null));
  }, []);

  useEffect(() => {
    if (!ready || !lines.length) return setQuote(null);
    let live = true;
    shop<Quote>("/quote", { method: "POST", body: { items: lines.map((line) => ({ skuCode: line.skuCode, qty: line.qty })) } })
      .then((result) => live && (setQuote(result), setError("")))
      .catch((failure) => live && (setQuote(null), setError(errorText(failure))));
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, ready]);

  // Signed in with pieces in the bag: the shop may follow up with picks on WhatsApp (if she agreed).
  useEffect(() => {
    if (!account || !lines.length || told.current) return;
    told.current = true;
    shop("/bag-left", { method: "POST", body: { pieces: lines.map((line) => line.skuCode) } }).catch(() => undefined);
  }, [account, lines]);

  if (!ready) return <div className="wrap empty">Loading your bag…</div>;
  if (!lines.length)
    return (
      <div className="wrap empty">
        <h1 className="serif" style={{ fontSize: 44 }}>
          Your bag is <em>empty</em>
        </h1>
        <p>Find something for wherever you are going next.</p>
        <Link className="btn dark" href="/shop?sort=new">
          Shop new in
        </Link>
      </div>
    );

  return (
    <div className="wrap">
      <div className="two-col">
        <section className="panel">
          <h2>Your bag</h2>
          <div>
            {lines.map((line) => (
              <div key={line.skuCode} className="line-item">
                <Link href={`/p/${line.slug}?size=${encodeURIComponent(line.size)}`} style={{ "--bg": backdrop(line.skuCode) } as CSSProperties}>
                  {line.image ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img className="mini" src={line.image} alt="" style={{ width: 64, height: 84 }} />
                  ) : (
                    <span className="mini" style={{ display: "block", width: 64, height: 84 }} />
                  )}
                </Link>
                <div style={{ minWidth: 0 }}>
                  <div className="serif" style={{ fontSize: 18 }}>
                    {line.name}
                  </div>
                  <div className="small muted">
                    Size {line.size}
                    {line.colour ? ` · ${line.colour}` : ""}
                  </div>
                  <div style={{ display: "flex", gap: 12, alignItems: "center", marginTop: 8 }}>
                    <span className="qty">
                      <button aria-label="One fewer" onClick={() => (line.qty > 1 ? setQty(line.skuCode, line.qty - 1) : remove(line.skuCode))}>
                        −
                      </button>
                      <span>{line.qty}</span>
                      <button aria-label="One more" onClick={() => setQty(line.skuCode, line.qty + 1)}>
                        +
                      </button>
                    </span>
                    <button className="link small" onClick={() => remove(line.skuCode)}>
                      Remove
                    </button>
                  </div>
                </div>
                <b>{rupees(line.pricePaise * line.qty)}</b>
              </div>
            ))}
          </div>
        </section>
        <aside className="panel">
          <h2>Summary</h2>
          {error && <div className="notice">{error} Remove that piece to carry on.</div>}
          {quote && (
            <div className="sum">
              <div>
                <span>Pieces</span>
                <span>{rupees(quote.listPaise)}</span>
              </div>
              {quote.memberSavingPaise > 0 && (
                <div className="off">
                  <span>Members&apos; prices</span>
                  <span>−{rupees(quote.memberSavingPaise)}</span>
                </div>
              )}
              <div>
                <span>Delivery</span>
                <span>Free</span>
              </div>
              <div className="total">
                <span>Total</span>
                <span>{rupees(quote.totalPaise)}</span>
              </div>
              <div className="small muted">Prices include GST. Codes and points at the next step.</div>
            </div>
          )}
          {!account && <p className="small muted" style={{ margin: 0 }}>Members see their prices and points once signed in, at checkout.</p>}
          <Link className={`btn wine block${error ? " disabled" : ""}`} href={error ? "#" : "/checkout"} aria-disabled={Boolean(error)}>
            Checkout
          </Link>
          <Link className="btn ghost block" href="/shop">
            Keep shopping
          </Link>
        </aside>
      </div>
    </div>
  );
}
