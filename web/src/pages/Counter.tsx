import { useEffect, useMemo, useRef, useState } from "react";
import { FindBillDialog, REFUND_LABEL, type ReturnDone } from "./Returns";
import { codeHas, sameCode } from "../codes";
import { api } from "../api";
import { rupees } from "../format";
import { Notice, useLoad, useRun } from "../ui";
import type { Invoice, Location, Order, Style } from "../types";

// Billing at the store counter: scan the barcode (or type the size code or a name), adjust
// quantities, take the payment, and the GST invoice is ready to print.

interface Quote {
  member: { _id: string; name: string; points: number; tier: { name: string; perk: string; next: { name: string; needPaise: number } | null }; usualSize: string; offers: boolean } | null;
  quote: { code: { kind: string; code: string; pct: number; label: string; paise: number } | null; points: { used: number; paise: number; available: number; max: number }; memberSavingPaise?: number; totalPaise: number };
}

interface CartLine {
  code: string;
  name: string;
  size: string;
  pricePaise: number;
  qty: number;
  available: number;
}

export function Counter() {
  const styles = useLoad<{ styles: Style[] }>("/api/styles?status=live");
  const locations = useLoad<{ locations: Location[] }>("/api/locations");
  const stores = useMemo(() => (locations.data?.locations || []).filter((location) => location.kind === "store" && location.active), [locations.data]);
  const [locationId, setLocationId] = useState(() => {
    try {
      return localStorage.getItem("counter-location") || "";
    } catch {
      return "";
    }
  });
  const location = stores.find((store) => store._id === locationId) || stores[0];
  const [scan, setScan] = useState("");
  const [cart, setCart] = useState<CartLine[]>([]);
  const [customer, setCustomer] = useState({ name: "", phone: "" });
  const [done, setDone] = useState<{ order: Order; invoice: Invoice; creditPaise?: number } | null>(null);
  const [message, setMessage] = useState("");
  // A return at the counter: an exchange credit goes into the next bill; a refund is just shown.
  const [returning, setReturning] = useState(false);
  const [credit, setCredit] = useState<{ returnId: string; number: number; amountPaise: number } | null>(null);
  const [returned, setReturned] = useState<ReturnDone | null>(null);
  // The members' circle: her tier and points from the phone number, a creator's or friend's code, points to use.
  const [code, setCode] = useState("");
  const [redeem, setRedeem] = useState(0);
  const [quote, setQuote] = useState<Quote | null>(null);
  const [quoteError, setQuoteError] = useState("");
  const { busy, error, run, setError } = useRun();
  const scanRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!location) return;
    try {
      localStorage.setItem("counter-location", location._id);
    } catch {
      /* private window */
    }
  }, [location]);

  // Every size of every live style, with its stock at this counter.
  const sizes = useMemo(() => {
    const rows: (CartLine & { barcode: string; styleCode: string; image: string })[] = [];
    for (const style of styles.data?.styles || []) {
      for (const size of style.sizes) {
        const level = size.stock.find((row) => row.locationId === location?._id);
        rows.push({ code: size.code, barcode: size.barcode, styleCode: style.code, name: style.name, size: size.size, pricePaise: size.pricePaise, qty: 1, available: level?.available || 0, image: style.images[0] || "" });
      }
    }
    return rows;
  }, [styles.data, location]);

  const term = scan.trim().toUpperCase();
  const matches = term.length >= 2 ? sizes.filter((row) => codeHas(row.code, term) || sameCode(term, row.code, row.barcode) || row.name.toUpperCase().includes(term)).slice(0, 12) : [];

  function add(code: string) {
    const row = sizes.find((item) => item.code === code);
    if (!row) return;
    setDone(null);
    setError("");
    setCart((lines) => {
      const existing = lines.find((line) => line.code === code);
      const qty = (existing?.qty || 0) + 1;
      if (qty > row.available) {
        setMessage(`Only ${row.available} of ${row.name} (${row.size}) in this store.`);
        return lines;
      }
      setMessage("");
      return existing ? lines.map((line) => (line.code === code ? { ...line, qty } : line)) : [...lines, { ...row, qty: 1 }];
    });
    setScan("");
    scanRef.current?.focus();
  }

  function onScanKey(event: React.KeyboardEvent<HTMLInputElement>) {
    if (event.key !== "Enter") return;
    event.preventDefault();
    // A scanner types the barcode and presses Enter: an exact barcode or size code is added at once.
    const exact = sizes.find((row) => sameCode(term, row.code, row.barcode));
    if (exact) add(exact.code);
    else if (matches.length === 1) add(matches[0].code);
    else if (!matches.length) setMessage(`Nothing matches "${scan.trim()}".`);
  }

  const setQty = (code: string, qty: number) => setCart((lines) => lines.flatMap((line) => (line.code !== code ? [line] : qty <= 0 ? [] : [{ ...line, qty: Math.min(qty, line.available) }])));
  const gross = cart.reduce((sum, line) => sum + line.pricePaise * line.qty, 0);
  const pieces = cart.reduce((sum, line) => sum + line.qty, 0);
  const digits = customer.phone.replace(/\D/g, "");
  const total = gross - (quote?.quote.totalPaise || 0);

  useEffect(() => {
    if (digits.length < 10 && !code.trim()) {
      setQuote(null);
      setQuoteError("");
      return;
    }
    let live = true;
    const timer = setTimeout(() => {
      api<Quote>("/api/counter/quote", { method: "POST", body: { phone: digits, code: code.trim(), redeem, grossPaise: gross, items: cart.map((line) => ({ skuCode: line.code, qty: line.qty })) } })
        .then((result) => {
          if (!live) return;
          setQuote(result);
          setQuoteError("");
          if (!customer.name && result.member?.name) setCustomer((current) => (current.name ? current : { ...current, name: result.member?.name || "" }));
        })
        .catch((failure) => {
          if (!live) return;
          setQuoteError(failure.message);
          // A bad code or too many points: the bill is shown without them until fixed.
          setQuote((current) => (current ? { ...current, quote: { code: null, points: { ...current.quote.points, used: 0, paise: 0 }, totalPaise: 0 } } : null));
        });
    }, 300);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [digits, code, redeem, gross]); // eslint-disable-line react-hooks/exhaustive-deps

  const sell = (method: "store_cash" | "store_upi" | "store_card") =>
    run(async () => {
      if (!location) return;
      const result = await api<{ order: Order; invoice: Invoice }>("/api/store-sales", {
        method: "POST",
        body: { location: location.code, items: cart.map((line) => ({ skuCode: line.code, qty: line.qty })), method, customer: { name: customer.name.trim() || undefined, phone: digits || undefined }, exchangeReturnId: credit?.returnId, code: code.trim(), redeem },
      });
      setDone({ ...result, creditPaise: credit?.amountPaise || 0 });
      setCredit(null);
      setReturned(null);
      setCart([]);
      setCustomer({ name: "", phone: "" });
      setCode("");
      setRedeem(0);
      setQuote(null);
      styles.reload();
      scanRef.current?.focus();
    });

  if (locations.data && !stores.length) {
    return (
      <div className="page">
        <h1>Counter</h1>
        <Notice tone="warn">
          No store is set up yet. Add one in <a href="#settings">Settings</a> (kind: store).
        </Notice>
      </div>
    );
  }

  return (
    <div className="page counter">
      <div className="detail-head">
        <h1>Counter</h1>
        {stores.length > 1 && (
          <select className="input auto" value={location?._id || ""} onChange={(event) => setLocationId(event.target.value)} aria-label="Store">
            {stores.map((store) => (
              <option key={store._id} value={store._id}>
                {store.name}
              </option>
            ))}
          </select>
        )}
        {stores.length === 1 && <span className="muted">{location?.name}</span>}
        <span className="spacer" />
        <button className="btn" onClick={() => setReturning(true)} disabled={!location}>
          Return or exchange
        </button>
      </div>
      {returning && location && (
        <FindBillDialog
          location={location.code}
          onClose={() => setReturning(false)}
          onDone={(result) => {
            setReturning(false);
            setReturned(result);
            if (result.return.refund.method === "exchange") setCredit({ returnId: result.return._id, number: result.return.number, amountPaise: result.return.refund.amountPaise });
            styles.reload();
            scanRef.current?.focus();
          }}
        />
      )}
      {returned && (
        <Notice tone="ok">
          Return {returned.return.number}: {rupees(returned.return.refund.amountPaise)} back{returned.return.refund.method === "exchange" ? " as credit for the new bill; scan the new pieces." : ` by ${REFUND_LABEL[returned.return.refund.method].toLowerCase()}.`}{" "}
          {returned.creditNote && (
            <a href={`#invoice/${returned.creditNote._id}`} target="_blank" rel="noreferrer">
              Credit note {returned.creditNote.number}
            </a>
          )}
        </Notice>
      )}
      <Notice>{styles.error || locations.error}</Notice>

      <div className="counter-grid">
        <div>
          <div className="scan">
            <input ref={scanRef} className="input big" autoFocus placeholder="Scan barcode, or type size code / name" value={scan} onChange={(event) => setScan(event.target.value)} onKeyDown={onScanKey} aria-label="Scan or search" />
          </div>
          <Notice tone="warn">{message}</Notice>
          {matches.length > 0 && (
            <div className="matches">
              {matches.map((row) => (
                <button key={row.code} className="match" onClick={() => add(row.code)} disabled={row.available <= 0}>
                  {row.image ? <img src={row.image} alt="" /> : <span className="thumb" />}
                  <span>
                    <strong>{row.name}</strong>
                    <span className="muted small-text">
                      {row.code} · size {row.size} · {row.available} in store
                    </span>
                  </span>
                  <span>{rupees(row.pricePaise)}</span>
                </button>
              ))}
            </div>
          )}
          {done && (
            <div className="notice ok">
              Sold: invoice {done.invoice.number}, {rupees(done.invoice.totals.totalPaise)}.
              {done.creditPaise ? ` Less the exchange credit ${rupees(done.creditPaise)}: ${done.invoice.totals.totalPaise >= done.creditPaise ? `collected ${rupees(done.invoice.totals.totalPaise - done.creditPaise)}` : `${rupees(done.creditPaise - done.invoice.totals.totalPaise)} to give back`}.` : ""}{" "}
              <a href={`#invoice/${done.invoice._id}`} target="_blank" rel="noreferrer">
                Print invoice
              </a>
            </div>
          )}
        </div>

        <aside className="bill card" aria-label="Bill">
          <h3>Bill</h3>
          {!cart.length && <p className="muted">Scan a piece to start.</p>}
          {cart.map((line) => (
            <div key={line.code} className="bill-line">
              <div>
                {line.name}
                <div className="muted small-text">
                  {line.code} · {rupees(line.pricePaise)}
                </div>
              </div>
              <div className="qty">
                <button className="btn small" onClick={() => setQty(line.code, line.qty - 1)} aria-label={`One less ${line.code}`}>
                  −
                </button>
                <span>{line.qty}</span>
                <button className="btn small" onClick={() => setQty(line.code, line.qty + 1)} disabled={line.qty >= line.available} aria-label={`One more ${line.code}`}>
                  +
                </button>
              </div>
              <div className="num">{rupees(line.pricePaise * line.qty)}</div>
            </div>
          ))}
          {quote?.quote.memberSavingPaise ? (
            <div className="bill-line credit-line">
              <span>
                Members' price <span className="muted small-text">quiet markdown</span>
              </span>
              <span className="num">− {rupees(quote.quote.memberSavingPaise)}</span>
            </div>
          ) : null}
          {quote?.quote.code && (
            <div className="bill-line credit-line">
              <span>
                {quote.quote.code.label} <span className="muted small-text">{quote.quote.code.code}, {quote.quote.code.pct}% off</span>
              </span>
              <span className="num">− {rupees(quote.quote.code.paise)}</span>
            </div>
          )}
          {quote?.quote.points.used ? (
            <div className="bill-line credit-line">
              <span>
                Points <span className="muted small-text">{quote.quote.points.used} used</span>
              </span>
              <span className="num">− {rupees(quote.quote.points.paise)}</span>
              <button className="btn small" onClick={() => setRedeem(0)} aria-label="Do not use points">
                ×
              </button>
            </div>
          ) : null}
          <div className="bill-total">
            <span>
              {quote?.quote.totalPaise ? "To pay" : "Total"} <span className="muted small-text">{pieces} pc, incl. GST</span>
            </span>
            <strong>{rupees(total)}</strong>
          </div>
          {credit && (
            <>
              <div className="bill-line credit-line">
                <span>
                  Exchange credit <span className="muted small-text">return {credit.number}</span>
                </span>
                <span className="num">− {rupees(credit.amountPaise)}</span>
                <button className="btn small" onClick={() => setCredit(null)} aria-label="Remove the exchange credit">
                  ×
                </button>
              </div>
              {cart.length === 0 && <p className="muted small-text">Scan the new pieces; the credit comes off this bill.</p>}
              {cart.length > 0 && <div className="bill-total">
                <span>{total >= credit.amountPaise ? "To collect" : "To give back"}</span>
                <strong>{rupees(Math.abs(total - credit.amountPaise))}</strong>
              </div>}
              {cart.length > 0 && total < credit.amountPaise && <p className="muted small-text">The new pieces cost less than the credit: give the difference back in cash or UPI.</p>}
            </>
          )}
          <div className="field-row">
            <input className="input" placeholder="Customer name (optional)" value={customer.name} onChange={(event) => setCustomer({ ...customer, name: event.target.value })} aria-label="Customer name" />
            <input className="input" placeholder="Mobile (optional)" inputMode="tel" value={customer.phone} onChange={(event) => setCustomer({ ...customer, phone: event.target.value })} aria-label="Customer mobile" />
          </div>
          {quote?.member && (
            <div className="member-line">
              <span>
                <strong>{quote.member.name || "Member"}</strong> · <span className="badge accent">{quote.member.tier.name}</span> · {quote.member.points} points
                {quote.member.usualSize ? ` · size ${quote.member.usualSize}` : ""}
              </span>
              {!quote.quote.points.used && quote.quote.points.max > 0 && cart.length > 0 && (
                <button className="btn small" onClick={() => setRedeem(quote.quote.points.max)}>
                  Use {quote.quote.points.max} points
                </button>
              )}
            </div>
          )}
          {digits.length >= 10 && quote && !quote.member && <p className="muted small-text">New customer: she joins the circle with this bill.</p>}
          <input className="input" placeholder="Creator or friend's code (optional)" value={code} onChange={(event) => setCode(event.target.value.toUpperCase())} aria-label="Discount code" />
          <Notice tone="warn">{quoteError}</Notice>
          <Notice>{error}</Notice>
          <div className="pay-buttons">
            <button className="btn primary" disabled={busy || !cart.length} onClick={() => sell("store_upi")}>
              UPI
            </button>
            <button className="btn primary" disabled={busy || !cart.length} onClick={() => sell("store_cash")}>
              Cash
            </button>
            <button className="btn primary" disabled={busy || !cart.length} onClick={() => sell("store_card")}>
              Card
            </button>
          </div>
          {cart.length > 0 && (
            <button className="btn link" onClick={() => (setCart([]), setRedeem(0))}>
              Clear bill
            </button>
          )}
        </aside>
      </div>
    </div>
  );
}
