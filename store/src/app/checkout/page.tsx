"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { useBag } from "@/lib/bag";
import { errorText, shop } from "@/lib/client";
import { rupees } from "@/lib/format";
import type { Account, CustomerOrder, Quote } from "@/lib/types";
import { SignIn } from "@/components/SignIn";
import { readAttribution } from "@/components/Attribution";

// Checkout in one page: sign in with WhatsApp, the delivery address, a code or points, how to pay.
export default function Checkout() {
  const { lines, ready, clear } = useBag();
  const router = useRouter();
  const [account, setAccount] = useState<Account | null | undefined>(undefined);
  const [address, setAddress] = useState({ name: "", address: "", pincode: "" });
  const [code, setCode] = useState("");
  const [appliedCode, setAppliedCode] = useState("");
  const [redeem, setRedeem] = useState(0);
  const [method, setMethod] = useState<"cod" | "prepaid" | "">("");
  const [quote, setQuote] = useState<Quote | null>(null);
  const [quoteError, setQuoteError] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [placedId, setPlacedId] = useState("");
  const items = lines.map((line) => ({ skuCode: line.skuCode, qty: line.qty }));
  const key = `${lines.map((line) => `${line.skuCode}x${line.qty}`).join(",")}|${appliedCode}|${redeem}|${account?.phone || ""}`;

  useEffect(() => {
    shop<{ account: Account | null }>("/me").then((result) => setAccount(result.account)).catch(() => setAccount(null));
  }, []);
  useEffect(() => {
    if (account?.lastAddress) setAddress((current) => (current.address ? current : { ...account.lastAddress! }));
    else if (account?.name) setAddress((current) => (current.name ? current : { ...current, name: account.name }));
  }, [account]);

  useEffect(() => {
    if (!ready || !items.length) return;
    let live = true;
    shop<Quote>("/quote", { method: "POST", body: { items, code: appliedCode, redeem } })
      .then((result) => {
        if (!live) return;
        setQuote(result);
        setQuoteError("");
        setMethod((current) => current || (result.prepaidAllowed ? "prepaid" : result.codAllowed ? "cod" : ""));
      })
      .catch((failure) => {
        if (!live) return;
        setQuoteError(errorText(failure));
        // A code or points that do not apply: drop them, keep the bag.
        if (appliedCode || redeem) {
          setAppliedCode("");
          setRedeem(0);
        }
      });
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, ready]);

  const place = async () => {
    setBusy(true);
    setError("");
    try {
      const result = await shop<{ order: CustomerOrder }>("/orders", { method: "POST", body: { items, address, method, code: appliedCode, redeem, attribution: readAttribution() || undefined } });
      setPlacedId(result.order._id);
      clear();
      router.push(`/account/orders/${result.order._id}?placed=1`);
    } catch (failure) {
      setError(errorText(failure));
      setBusy(false);
    }
  };

  if (placedId) return <div className="wrap empty">Order placed. Taking you to it…</div>;
  if (!ready || account === undefined) return <div className="wrap empty">Loading…</div>;
  if (!lines.length)
    return (
      <div className="wrap empty">
        <p>Your bag is empty.</p>
        <Link className="btn dark" href="/shop">
          Shop the collection
        </Link>
      </div>
    );

  const pointsMax = quote?.quote.points.max || 0;
  const addressOk = address.name.trim().length >= 2 && address.address.trim().length >= 10 && /^[1-9]\d{5}$/.test(address.pincode.trim());

  return (
    <div className="wrap">
      <div className="two-col">
        <div style={{ display: "grid", gap: 20, minWidth: 0 }}>
          <div className="steps" aria-label="Steps">
            <span className={!account ? "on" : ""}>1 · Sign in</span>
            <span className={account && !addressOk ? "on" : ""}>2 · Address</span>
            <span className={account && addressOk ? "on" : ""}>3 · Pay</span>
          </div>
          {!account ? (
            <SignIn onSignedIn={setAccount} title="First, your WhatsApp number" />
          ) : (
            <>
              <section className="panel">
                <h2>Delivery address</h2>
                <p className="small muted" style={{ margin: 0 }}>
                  Signed in as +{account.phone}. Order updates come on WhatsApp.
                </p>
                <div className="field">
                  <label htmlFor="ship-name">Name for delivery</label>
                  <input id="ship-name" className="input" autoComplete="name" value={address.name} onChange={(event) => setAddress({ ...address, name: event.target.value })} />
                </div>
                <div className="field">
                  <label htmlFor="ship-address">House, street, area, city</label>
                  <textarea id="ship-address" className="input" autoComplete="street-address" value={address.address} onChange={(event) => setAddress({ ...address, address: event.target.value })} placeholder="Flat 12, Shanti Apartment, Vijay Nagar, near C21 mall, Indore" />
                </div>
                <div className="field" style={{ maxWidth: 220 }}>
                  <label htmlFor="ship-pin">Pincode</label>
                  <input id="ship-pin" className="input" inputMode="numeric" autoComplete="postal-code" maxLength={6} value={address.pincode} onChange={(event) => setAddress({ ...address, pincode: event.target.value.replace(/\D/g, "") })} />
                </div>
              </section>

              <section className="panel">
                <h2>How would you like to pay?</h2>
                <div className="pay-choice">
                  {quote?.prepaidAllowed && (
                    <label className={method === "prepaid" ? "on" : ""}>
                      <input type="radio" name="pay" checked={method === "prepaid"} onChange={() => setMethod("prepaid")} />
                      <span>
                        <b>Pay online</b>
                        <br />
                        <span className="small muted">UPI, cards or net banking on Razorpay&apos;s secure page. Ships first.</span>
                      </span>
                    </label>
                  )}
                  {quote?.codAllowed && (
                    <label className={method === "cod" ? "on" : ""}>
                      <input type="radio" name="pay" checked={method === "cod"} onChange={() => setMethod("cod")} />
                      <span>
                        <b>Cash on delivery</b>
                        <br />
                        <span className="small muted">Pay the courier in cash or UPI. Some orders are asked to confirm first.</span>
                      </span>
                    </label>
                  )}
                  {quote && !quote.prepaidAllowed && !quote.codAllowed && <div className="notice warn">Neither online payment nor cash on delivery is available for this order. Message us on WhatsApp and we will help.</div>}
                </div>
              </section>
            </>
          )}
        </div>

        <aside className="panel">
          <h2>Your order</h2>
          {lines.map((line) => (
            <div key={line.skuCode} className="sum">
              <div>
                <span>
                  {line.name} · {line.size} × {line.qty}
                </span>
                <span>{rupees(line.pricePaise * line.qty)}</span>
              </div>
            </div>
          ))}
          <form className="inline" onSubmit={(event) => (event.preventDefault(), setAppliedCode(code.trim().toUpperCase()))}>
            <label className="visually-hidden" htmlFor="code">
              Code
            </label>
            <input id="code" className="input" value={code} onChange={(event) => setCode(event.target.value)} placeholder="Creator or friend's code" />
            <button className="btn ghost small">Apply</button>
          </form>
          {account && (quote?.quote.points.available || 0) > 0 && (
            <div className="field">
              <label htmlFor="points">
                Use points ({quote!.quote.points.available} available, up to {pointsMax} on this order)
              </label>
              <input id="points" className="input" type="number" min={0} max={pointsMax} value={redeem || ""} onChange={(event) => setRedeem(Math.max(0, Math.min(pointsMax, Math.floor(Number(event.target.value) || 0))))} placeholder="0" />
            </div>
          )}
          {quoteError && <div className="notice">{quoteError}</div>}
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
              {quote.quote.code && (
                <div className="off">
                  <span>
                    {quote.quote.code.label} ({quote.quote.code.pct}%)
                  </span>
                  <span>−{rupees(quote.quote.code.paise)}</span>
                </div>
              )}
              {quote.quote.points.used > 0 && (
                <div className="off">
                  <span>{quote.quote.points.used} points</span>
                  <span>−{rupees(quote.quote.points.paise)}</span>
                </div>
              )}
              <div>
                <span>Delivery</span>
                <span>Free</span>
              </div>
              <div className="total">
                <span>To pay</span>
                <span>{rupees(quote.totalPaise)}</span>
              </div>
              <div className="small muted">Prices include GST. A GST invoice comes with your order.</div>
            </div>
          )}
          {error && <div className="notice">{error}</div>}
          <button className="btn wine block" disabled={!account || !addressOk || !method || !quote || busy} onClick={place}>
            {busy ? "Placing your order…" : method === "prepaid" ? "Place order and pay" : "Place order"}
          </button>
          {account && !addressOk && <p className="small muted" style={{ margin: 0 }}>Add your name, full address and pincode to carry on.</p>}
        </aside>
      </div>
    </div>
  );
}
