import { useMemo, useRef, useState } from "react";
import { codeHas, sameCode } from "../codes";
import { api, can, type Me } from "../api";
import { when } from "../format";
import { Notice, useLoad, useRun } from "../ui";
import type { Location, Style, Supplier } from "../types";
import { TagDialog } from "./Tags";

// Stock in and around the boutique: receive a supplier's delivery, count a size, move pieces
// between locations, and the record of every change.

type Tab = "receive" | "count" | "transfer" | "moves";

interface Move {
  _id: string;
  kind: string;
  skuCode: string;
  qty: number;
  locationId: string;
  by: string;
  note: string;
  at: string;
}

const KIND_LABEL: Record<string, string> = { receive: "Received", sale: "Sold", return: "Came back", cancel: "Cancelled", adjust: "Count", transfer_out: "Moved out", transfer_in: "Moved in" };

export function Stock({ me }: { me: Me }) {
  const [tab, setTab] = useState<Tab>(can(me, "stock:write") ? "receive" : "moves");
  const styles = useLoad<{ styles: Style[] }>("/api/styles");
  const locations = useLoad<{ locations: Location[] }>("/api/locations");
  const suppliers = useLoad<{ suppliers: Supplier[] }>("/api/suppliers");
  const locs = (locations.data?.locations || []).filter((location) => location.active);
  const sizes = useMemo(
    () => (styles.data?.styles || []).flatMap((style) => style.sizes.map((size) => ({ code: size.code, barcode: size.barcode, name: style.name, size: size.size, pricePaise: size.pricePaise, stock: size.stock }))),
    [styles.data],
  );
  const tabs: { id: Tab; label: string; show: boolean }[] = [
    { id: "receive", label: "Receive", show: can(me, "stock:write") },
    { id: "count", label: "Count", show: can(me, "stock:write") },
    { id: "transfer", label: "Move", show: can(me, "stock:write") && locs.length > 1 },
    { id: "moves", label: "History", show: true },
  ];

  return (
    <div className="page">
      <h1>Stock</h1>
      <div className="chips" role="tablist">
        {tabs
          .filter((item) => item.show)
          .map((item) => (
            <button key={item.id} role="tab" aria-selected={tab === item.id} className={`chip${tab === item.id ? " on" : ""}`} onClick={() => setTab(item.id)}>
              {item.label}
            </button>
          ))}
      </div>
      <Notice>{styles.error || locations.error}</Notice>
      {!locs.length && locations.data && (
        <Notice tone="warn">
          Add a location first in <a href="#settings">Settings</a>.
        </Notice>
      )}
      {locs.length > 0 && tab === "receive" && <ItemsForm mode="receive" sizes={sizes} locs={locs} suppliers={suppliers.data?.suppliers || []} onDone={styles.reload} />}
      {locs.length > 0 && tab === "transfer" && <ItemsForm mode="transfer" sizes={sizes} locs={locs} suppliers={[]} onDone={styles.reload} />}
      {locs.length > 0 && tab === "count" && <CountForm sizes={sizes} locs={locs} onDone={styles.reload} />}
      {tab === "moves" && <Moves locs={locs} />}
    </div>
  );
}

type SizeOption = { code: string; barcode: string; name: string; size: string; pricePaise: number; stock: { locationId: string; onHand: number; available: number }[] };

/** A box that takes a scanned barcode, a size code, or a few letters of the name. */
function SizePicker({ sizes, onPick, autoFocus = false }: { sizes: SizeOption[]; onPick: (code: string) => void; autoFocus?: boolean }) {
  const [text, setText] = useState("");
  const term = text.trim().toUpperCase();
  const matches = term.length >= 2 ? sizes.filter((row) => codeHas(row.code, term) || sameCode(term, row.code, row.barcode) || row.name.toUpperCase().includes(term)).slice(0, 8) : [];
  const pick = (code: string) => {
    onPick(code);
    setText("");
  };
  return (
    <div className="picker">
      <input
        className="input"
        autoFocus={autoFocus}
        value={text}
        placeholder="Scan barcode, or type size code / name"
        aria-label="Find a size"
        onChange={(event) => setText(event.target.value)}
        onKeyDown={(event) => {
          if (event.key !== "Enter") return;
          event.preventDefault();
          const exact = sizes.find((row) => sameCode(term, row.code, row.barcode));
          if (exact) pick(exact.code);
          else if (matches.length === 1) pick(matches[0].code);
        }}
      />
      {matches.length > 0 && (
        <div className="picker-list">
          {matches.map((row) => (
            <button type="button" key={row.code} onClick={() => pick(row.code)}>
              <strong>{row.code}</strong> {row.name} · {row.size}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function ItemsForm({ mode, sizes, locs, suppliers, onDone }: { mode: "receive" | "transfer"; sizes: SizeOption[]; locs: Location[]; suppliers: Supplier[]; onDone: () => void }) {
  const { busy, error, run } = useRun();
  const [lines, setLines] = useState<{ code: string; qty: number }[]>([]);
  const [to, setTo] = useState(locs[0]?.code || "");
  const [from, setFrom] = useState(locs[1]?.code || "");
  const [supplierId, setSupplierId] = useState("");
  const [note, setNote] = useState("");
  const [done, setDone] = useState("");
  // The delivery just received, for its price tags.
  const [received, setReceived] = useState<{ code: string; qty: number }[]>([]);
  const [tagging, setTagging] = useState(false);
  const add = (code: string) => setLines((current) => (current.some((line) => line.code === code) ? current.map((line) => (line.code === code ? { ...line, qty: line.qty + 1 } : line)) : [...current, { code, qty: 1 }]));
  const pieces = lines.reduce((sum, line) => sum + line.qty, 0);
  const fromLoc = locs.find((location) => location.code === from);

  const submit = () =>
    run(async () => {
      const items = lines.filter((line) => line.qty > 0).map((line) => ({ skuCode: line.code, qty: line.qty }));
      if (mode === "receive") await api("/api/stock/receive", { method: "POST", body: { location: to, items, note, ...(supplierId ? { supplierId } : {}) } });
      else await api("/api/stock/transfer", { method: "POST", body: { from, to, items, note } });
      setDone(`${mode === "receive" ? "Received" : "Moved"} ${pieces} piece${pieces > 1 ? "s" : ""}.`);
      if (mode === "receive") setReceived(items.map((item) => ({ code: item.skuCode, qty: item.qty })));
      setLines([]);
      setNote("");
      onDone();
    });

  return (
    <div className="card form-card">
      <div className="form-grid">
        {mode === "transfer" && (
          <div className="field">
            <label htmlFor="from">From</label>
            <select id="from" className="input" value={from} onChange={(event) => setFrom(event.target.value)}>
              {locs.map((location) => (
                <option key={location._id} value={location.code}>
                  {location.name}
                </option>
              ))}
            </select>
          </div>
        )}
        <div className="field">
          <label htmlFor="to">{mode === "receive" ? "Into" : "To"}</label>
          <select id="to" className="input" value={to} onChange={(event) => setTo(event.target.value)}>
            {locs.map((location) => (
              <option key={location._id} value={location.code}>
                {location.name}
              </option>
            ))}
          </select>
        </div>
        {mode === "receive" && (
          <div className="field">
            <label htmlFor="supplier">From supplier</label>
            <select id="supplier" className="input" value={supplierId} onChange={(event) => setSupplierId(event.target.value)}>
              <option value="">—</option>
              {suppliers.map((supplier) => (
                <option key={supplier._id} value={supplier._id}>
                  {supplier.name}
                </option>
              ))}
            </select>
          </div>
        )}
        <div className="field">
          <label htmlFor="note">Note</label>
          <input id="note" className="input" value={note} onChange={(event) => setNote(event.target.value)} placeholder={mode === "receive" ? "Bill no." : "Reason"} />
        </div>
      </div>
      <SizePicker sizes={sizes} onPick={add} autoFocus />
      {lines.length > 0 && (
        <table className="table plain">
          <tbody>
            {lines.map((line) => {
              const row = sizes.find((item) => item.code === line.code);
              const have = row?.stock.find((item) => item.locationId === fromLoc?._id)?.available ?? 0;
              return (
                <tr key={line.code}>
                  <td>
                    <strong>{line.code}</strong> <span className="muted">{row?.name}</span>
                    {mode === "transfer" && <div className="muted small-text">{have} free at {fromLoc?.code}</div>}
                  </td>
                  <td className="num">
                    <input className="input qty-input" type="number" min={0} max={500} value={line.qty} onChange={(event) => setLines(lines.map((item) => (item.code === line.code ? { ...item, qty: Math.max(0, Math.floor(Number(event.target.value) || 0)) } : item)))} aria-label={`Quantity of ${line.code}`} />
                  </td>
                  <td>
                    <button className="btn small" onClick={() => setLines(lines.filter((item) => item.code !== line.code))} aria-label={`Remove ${line.code}`}>
                      ×
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
      <Notice>{error}</Notice>
      <Notice tone="ok">{done}</Notice>
      {mode === "receive" && received.length > 0 && (
        <div className="row-actions">
          <button className="btn" onClick={() => setTagging(true)}>
            Print tags for these {received.reduce((sum, line) => sum + line.qty, 0)} pieces
          </button>
        </div>
      )}
      {tagging && (
        <TagDialog
          title="Price tags for this delivery"
          lines={received.flatMap((line) => {
            const row = sizes.find((item) => item.code === line.code);
            return row ? [{ item: { code: row.code, name: row.name, size: row.size, pricePaise: row.pricePaise }, qty: line.qty }] : [];
          })}
          onClose={() => setTagging(false)}
        />
      )}
      <div className="row-actions">
        <button className="btn primary" disabled={busy || !pieces || (mode === "transfer" && from === to)} onClick={submit}>
          {mode === "receive" ? `Receive ${pieces || ""} piece${pieces === 1 ? "" : "s"}` : `Move ${pieces || ""} piece${pieces === 1 ? "" : "s"}`}
        </button>
      </div>
    </div>
  );
}

function CountForm({ sizes, locs, onDone }: { sizes: SizeOption[]; locs: Location[]; onDone: () => void }) {
  const { busy, error, run } = useRun();
  const [location, setLocation] = useState(locs[0]?.code || "");
  const [code, setCode] = useState("");
  const [counted, setCounted] = useState("");
  const [note, setNote] = useState("");
  const [done, setDone] = useState("");
  const countRef = useRef<HTMLInputElement>(null);
  const row = sizes.find((item) => item.code === code);
  const loc = locs.find((item) => item.code === location);
  const level = row?.stock.find((item) => item.locationId === loc?._id);

  const submit = () =>
    run(async () => {
      const result = await api<{ change: number }>("/api/stock/count", { method: "POST", body: { location, skuCode: code, counted: Number(counted), note } });
      setDone(`${code}: ${result.change === 0 ? "matches the record" : `${result.change > 0 ? "+" : ""}${result.change} corrected`}.`);
      setCode("");
      setCounted("");
      onDone();
    });

  return (
    <div className="card form-card">
      <div className="form-grid">
        <div className="field">
          <label htmlFor="count-loc">Location</label>
          <select id="count-loc" className="input" value={location} onChange={(event) => setLocation(event.target.value)}>
            {locs.map((item) => (
              <option key={item._id} value={item.code}>
                {item.name}
              </option>
            ))}
          </select>
        </div>
      </div>
      {!code && (
        <SizePicker
          sizes={sizes}
          autoFocus
          onPick={(picked) => {
            setCode(picked);
            setTimeout(() => countRef.current?.focus(), 0);
          }}
        />
      )}
      {code && (
        <form className="form-grid" onSubmit={(event) => (event.preventDefault(), submit())}>
          <div className="field span-3">
            <strong>{code}</strong> {row?.name} · the record says {level?.onHand ?? 0} on the shelf{level && level.onHand !== level.available ? ` (${level.onHand - level.available} held in carts)` : ""}.{" "}
            <button type="button" className="btn link" onClick={() => setCode("")}>
              Change
            </button>
          </div>
          <div className="field">
            <label htmlFor="counted">Counted on the shelf</label>
            <input id="counted" ref={countRef} className="input" type="number" min={0} required value={counted} onChange={(event) => setCounted(event.target.value)} />
          </div>
          <div className="field span-2">
            <label htmlFor="count-note">Reason</label>
            <input id="count-note" className="input" required minLength={2} value={note} onChange={(event) => setNote(event.target.value)} placeholder="Monthly count / damaged / found" />
          </div>
          <div>
            <button className="btn primary" disabled={busy || counted === "" || note.trim().length < 2}>
              Save count
            </button>
          </div>
        </form>
      )}
      <Notice>{error}</Notice>
      <Notice tone="ok">{done}</Notice>
    </div>
  );
}

function Moves({ locs }: { locs: Location[] }) {
  const [sku, setSku] = useState("");
  const moves = useLoad<{ moves: Move[] }>(`/api/stock/moves${sku.trim().length >= 3 ? `?sku=${encodeURIComponent(sku.trim())}` : ""}`);
  return (
    <div>
      <div className="toolbar">
        <input className="input" placeholder="Size code, e.g. DRS-001-M" value={sku} onChange={(event) => setSku(event.target.value)} aria-label="Filter by size code" />
      </div>
      <Notice>{moves.error}</Notice>
      <table className="table">
        <thead>
          <tr>
            <th>When</th>
            <th>What</th>
            <th>Size</th>
            <th className="num">Pieces</th>
            <th>Where</th>
            <th>By</th>
            <th>Note</th>
          </tr>
        </thead>
        <tbody>
          {moves.data?.moves.map((move) => (
            <tr key={move._id}>
              <td>{when(move.at)}</td>
              <td>{KIND_LABEL[move.kind] || move.kind}</td>
              <td>{move.skuCode}</td>
              <td className={`num ${move.qty < 0 ? "neg" : ""}`}>{move.qty > 0 ? `+${move.qty}` : move.qty}</td>
              <td>{locs.find((location) => location._id === move.locationId)?.code || ""}</td>
              <td>{move.by}</td>
              <td>{move.note}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {moves.data && !moves.data.moves.length && <div className="empty">No stock changes yet.</div>}
    </div>
  );
}
