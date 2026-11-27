import { useEffect, useMemo, useRef, useState } from "react";
import { codeHas, sameCode } from "../codes";
import { api } from "../api";
import { rupees } from "../format";
import { Notice, useLoad, useRun } from "../ui";
import type { Invoice, Location, Order, Style } from "../types";

// Billing at the store counter: scan the barcode (or type the size code or a name), adjust
// quantities, take the payment, and the GST invoice is ready to print.

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
  const [done, setDone] = useState<{ order: Order; invoice: Invoice } | null>(null);
  const [message, setMessage] = useState("");
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
  const total = cart.reduce((sum, line) => sum + line.pricePaise * line.qty, 0);
  const pieces = cart.reduce((sum, line) => sum + line.qty, 0);

  const sell = (method: "store_cash" | "store_upi" | "store_card") =>
    run(async () => {
      if (!location) return;
      const result = await api<{ order: Order; invoice: Invoice }>("/api/store-sales", {
        method: "POST",
        body: { location: location.code, items: cart.map((line) => ({ skuCode: line.code, qty: line.qty })), method, customer: { name: customer.name.trim() || undefined, phone: customer.phone.replace(/\D/g, "") || undefined } },
      });
      setDone(result);
      setCart([]);
      setCustomer({ name: "", phone: "" });
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
      </div>
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
              Sold: invoice {done.invoice.number}, {rupees(done.invoice.totals.totalPaise)}.{" "}
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
          <div className="bill-total">
            <span>
              Total <span className="muted small-text">{pieces} pc, incl. GST</span>
            </span>
            <strong>{rupees(total)}</strong>
          </div>
          <div className="field-row">
            <input className="input" placeholder="Customer name (optional)" value={customer.name} onChange={(event) => setCustomer({ ...customer, name: event.target.value })} aria-label="Customer name" />
            <input className="input" placeholder="Mobile (optional)" inputMode="tel" value={customer.phone} onChange={(event) => setCustomer({ ...customer, phone: event.target.value })} aria-label="Customer mobile" />
          </div>
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
            <button className="btn link" onClick={() => setCart([])}>
              Clear bill
            </button>
          )}
        </aside>
      </div>
    </div>
  );
}
