import { useMemo, useState } from "react";
import { api, can, type Me } from "../api";
import { dateOnly, rupees, when } from "../format";
import { Dialog, Notice, toPaise, useLoad, useRun } from "../ui";
import type { Location, Settings, Style, Supplier } from "../types";

// The buying desk: what to buy again and in which sizes, the shop's own size mix, how each supplier
// does, how test buys went, purchase orders, markdowns and the buying calendar. Every judgement is a
// score out of 100 with its reasons; the owner decides.

type Tab = "reorder" | "orders" | "suppliers" | "trials" | "sizes" | "markdowns" | "calendar";
interface SuggestSize { size: string; skuCode: string; share: number; onHand: number; onOrder: number; suggest: number }
interface ReorderRow {
  styleId: string;
  styleCode: string;
  name: string;
  category: string;
  image: string;
  supplierId: string | null;
  supplier: string;
  pricePaise: number;
  costPaise: number;
  marginPct: number | null;
  onHand: number;
  onOrder: number;
  sold30: number;
  pace: number;
  sellThrough: number;
  coverDays: number | null;
  leadDays: number;
  score: number;
  why: string[];
  suggest: { total: number; sizes: SuggestSize[]; horizonDays: number; costPaise: number };
}
interface PoLine { skuCode: string; styleCode: string; name: string; size: string; qty: number; costPaise: number; receivedQty: number }
interface Po { _id: string; number: number; supplierId: string; supplier?: string; status: "draft" | "sent" | "part_received" | "received" | "cancelled"; trial: boolean; lines: PoLine[]; note: string; expectedAt: string | null; sentAt: string | null; firstReceivedAt: string | null; createdAt: string; pieces?: number; received?: number; costPaise?: number }
interface Card { _id: string; name: string; city: string; waId: string; styles: number; received: number; sold: number; onHand: number; sellThrough: number; marginPct: number | null; returnRate: number; qualityRate: number; leadDays: number | null; onTime: number | null; fill: number | null; score: number | null; why: string[]; top: { styleCode: string; name: string; sold90: number }[] }
interface Trial { styleCode: string; name: string; category: string; image: string; supplier: string; poNumber: number; daysIn: number; bought: number; sold: number; onHand: number; sellThrough: number; score: number; step: string; why: string[] }
interface MixSize { size: string; kept: number; share: number; boughtShare: number; onHand: number; tooSmall: number; tooBig: number; notes: string[] }
interface PlanRow { styleCode: string; name: string; category: string; image: string; onHand: number; sizesLeft: string[]; pricePaise: number; costPaise: number; floorPaise: number; score: number; why: string[]; reach: number; suggest: { pct: number; kind: "public" | "quiet"; pricePaise: number; note: string } }
interface MarkdownRow { _id: string; styleCode: string; kind: "public" | "quiet"; listPaise: number; pricePaise: number; pct: number; status: "active" | "ended"; startedAt: string; until: string | null; piecesAtStart: number; onHandNow: number; cleared: number | null; daysRunning: number }
interface CalendarEvent { name: string; date: string; daysAway: number; orderBy: string; orderInDays: number; categories: string[]; note: string; inStock: number; styles: number }

const TABS: [Tab, string][] = [
  ["reorder", "Buy again"],
  ["orders", "Purchase orders"],
  ["suppliers", "Suppliers"],
  ["trials", "Test buys"],
  ["sizes", "Size mix"],
  ["markdowns", "Markdowns"],
  ["calendar", "Calendar"],
];
const PO_STATUS: Record<Po["status"], [string, string]> = { draft: ["Draft", ""], sent: ["With supplier", "accent"], part_received: ["Part received", "warn"], received: ["Received", ""], cancelled: ["Cancelled", "danger"] };
const pct = (value: number | null | undefined) => (value === null || value === undefined ? "–" : `${Math.round(value * 100)}%`);
const perWeek = (pace: number) => (pace >= 0.1 ? `${(pace * 7).toFixed(1)}/wk` : `${Math.round(pace * 30)}/mo`);

function Score({ value }: { value: number | null }) {
  if (value === null) return <span className="muted">–</span>;
  return (
    <span className="score" title={`${value} out of 100`}>
      <span className="score-bar" style={{ width: `${value}%` }} />
      <strong>{value}</strong>
    </span>
  );
}

export function Buying({ me }: { me: Me }) {
  const [tab, setTab] = useState<Tab>("reorder");
  const [newPo, setNewPo] = useState<{ supplierId?: string; trial?: boolean } | null>(null);
  const [openPo, setOpenPo] = useState<string | null>(null);
  const [poTick, setPoTick] = useState(0);
  const canOrder = can(me, "stock:write");
  const poDone = (id: string) => {
    setNewPo(null);
    setPoTick((value) => value + 1);
    setTab("orders");
    setOpenPo(id);
  };
  return (
    <div className="page">
      <div className="report-head">
        <h1>Buying desk</h1>
        {canOrder && (
          <div className="row-actions">
            <button className="btn" onClick={() => setNewPo({ trial: true })}>
              Test buy
            </button>
            <button className="btn primary" onClick={() => setNewPo({})}>
              New purchase order
            </button>
          </div>
        )}
      </div>
      <div className="chips" role="tablist">
        {TABS.map(([id, label]) => (
          <button key={id} role="tab" aria-selected={tab === id} className={`chip ${tab === id ? "on" : ""}`} onClick={() => setTab(id)}>
            {label}
          </button>
        ))}
      </div>
      {tab === "reorder" && <Reorder canOrder={canOrder} onDraft={poDone} />}
      {tab === "orders" && <Orders key={poTick} onOpen={setOpenPo} />}
      {tab === "suppliers" && <Suppliers canOrder={canOrder} onDraft={poDone} />}
      {tab === "trials" && <Trials />}
      {tab === "sizes" && <SizeMix />}
      {tab === "markdowns" && <Markdowns canMark={can(me, "catalog:write")} />}
      {tab === "calendar" && <Calendar />}
      {newPo && <NewPo initial={newPo} onClose={() => setNewPo(null)} onSaved={poDone} />}
      {openPo && (
        <PoView
          id={openPo}
          canOrder={canOrder}
          onClose={() => setOpenPo(null)}
          onChanged={() => setPoTick((value) => value + 1)}
        />
      )}
    </div>
  );
}

// ---- Buy again --------------------------------------------------------------------------------------

function Reorder({ canOrder, onDraft }: { canOrder: boolean; onDraft: (id: string) => void }) {
  const loaded = useLoad<{ coverDays: number; rows: ReorderRow[] }>("/api/buying/reorder");
  const [open, setOpen] = useState<string | null>(null);
  const { busy, error, run } = useRun();
  const rows = loaded.data?.rows || [];
  const bySupplier = useMemo(() => {
    const map = new Map<string, { name: string; pieces: number; costPaise: number }>();
    for (const row of rows) {
      if (!row.supplierId || !row.suggest.total) continue;
      const entry = map.get(row.supplierId) || { name: row.supplier, pieces: 0, costPaise: 0 };
      entry.pieces += row.suggest.total;
      entry.costPaise += row.suggest.costPaise;
      map.set(row.supplierId, entry);
    }
    return [...map.entries()];
  }, [rows]);
  const draft = (supplierId: string) =>
    run(async () => {
      const result = await api<{ order: Po }>("/api/purchase-orders/reorder-draft", { method: "POST", body: { supplierId } });
      onDraft(result.order._id);
    });

  return (
    <>
      <p className="muted small-text">
        Ranked by a reorder score: how fast it sells against everything else (35), how much of what came in has sold (25), how soon it runs out (20), margin (10) and pieces kept (10). Suggested pieces cover the supplier's lead time plus {loaded.data?.coverDays ?? 45} days of selling, less stock and what is on order, split by the sizes that sell.
      </p>
      <Notice>{loaded.error || error}</Notice>
      {bySupplier.length > 0 && canOrder && (
        <div className="chips">
          {bySupplier.map(([id, entry]) => (
            <button key={id} className="chip" disabled={busy} onClick={() => draft(id)}>
              Draft order to {entry.name}: {entry.pieces} pc, {rupees(entry.costPaise)} at cost
            </button>
          ))}
        </div>
      )}
      {rows.length ? (
        <div className="table-scroll">
          <table className="table">
            <thead>
              <tr>
                <th>Style</th>
                <th>Score</th>
                <th className="num">Sells</th>
                <th className="num">Sold through</th>
                <th className="num">Stock</th>
                <th className="num">Days left</th>
                <th>Buy</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.styleId} className="clickable" onClick={() => setOpen(open === row.styleId ? null : row.styleId)}>
                  <td>
                    <strong>{row.name}</strong>
                    <div className="muted small-text">
                      {row.styleCode} · {row.supplier || "no supplier"} · {row.marginPct === null ? "cost not entered" : `${pct(row.marginPct)} margin`}
                    </div>
                    {open === row.styleId && (
                      <ul className="why">
                        {row.why.map((line) => (
                          <li key={line}>{line}</li>
                        ))}
                        <li>
                          {row.leadDays} days lead time + cover = {row.suggest.horizonDays} days to buy for
                        </li>
                      </ul>
                    )}
                  </td>
                  <td>
                    <Score value={row.score} />
                  </td>
                  <td className="num">{perWeek(row.pace)}</td>
                  <td className="num">{pct(row.sellThrough)}</td>
                  <td className="num">
                    {row.onHand}
                    {row.onOrder ? <span className="muted small-text"> +{row.onOrder} coming</span> : null}
                  </td>
                  <td className="num">{row.coverDays === null ? "out" : Math.round(row.coverDays)}</td>
                  <td>
                    {row.suggest.total ? (
                      <span>
                        <strong>{row.suggest.total}</strong>{" "}
                        <span className="muted small-text">
                          {row.suggest.sizes
                            .filter((size) => size.suggest)
                            .map((size) => `${size.size} ${size.suggest}`)
                            .join(", ")}
                        </span>
                      </span>
                    ) : (
                      <span className="muted">enough</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        loaded.data && <p className="muted">Nothing has sold in the last 90 days yet.</p>
      )}
    </>
  );
}

// ---- Purchase orders --------------------------------------------------------------------------------

function Orders({ onOpen }: { onOpen: (id: string) => void }) {
  const [status, setStatus] = useState("");
  const loaded = useLoad<{ orders: Po[] }>(`/api/purchase-orders${status ? `?status=${status}` : ""}`);
  const orders = loaded.data?.orders || [];
  return (
    <>
      <div className="chips">
        {[["", "All"], ["draft", "Drafts"], ["sent", "With supplier"], ["part_received", "Part received"], ["received", "Received"]].map(([value, label]) => (
          <button key={value} className={`chip ${status === value ? "on" : ""}`} onClick={() => setStatus(value)}>
            {label}
          </button>
        ))}
      </div>
      <Notice>{loaded.error}</Notice>
      {orders.length ? (
        <div className="table-scroll">
          <table className="table">
            <thead>
              <tr>
                <th>Order</th>
                <th>Supplier</th>
                <th>Status</th>
                <th className="num">Pieces</th>
                <th className="num">At cost</th>
                <th>Needed by</th>
              </tr>
            </thead>
            <tbody>
              {orders.map((po) => (
                <tr key={po._id} className="clickable" onClick={() => onOpen(po._id)}>
                  <td>
                    PO #{po.number} {po.trial && <span className="badge accent">test buy</span>}
                    <div className="muted small-text">{dateOnly(po.createdAt)}</div>
                  </td>
                  <td>{po.supplier}</td>
                  <td>
                    <span className={`badge ${PO_STATUS[po.status][1]}`}>{PO_STATUS[po.status][0]}</span>
                  </td>
                  <td className="num">{po.status === "draft" ? po.pieces : `${po.received} of ${po.pieces}`}</td>
                  <td className="num">{rupees(po.costPaise || 0)}</td>
                  <td>{dateOnly(po.expectedAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        loaded.data && <p className="muted">No purchase orders yet.</p>
      )}
    </>
  );
}

function NewPo({ initial, onClose, onSaved }: { initial: { supplierId?: string; trial?: boolean }; onClose: () => void; onSaved: (id: string) => void }) {
  const suppliers = useLoad<{ suppliers: Supplier[] }>("/api/suppliers");
  const styles = useLoad<{ styles: Style[] }>("/api/styles");
  const locations = useLoad<{ locations: Location[] }>("/api/locations");
  const [supplierId, setSupplierId] = useState(initial.supplierId || "");
  const [location, setLocation] = useState("");
  const [trial, setTrial] = useState(Boolean(initial.trial));
  const [expected, setExpected] = useState("");
  const [note, setNote] = useState("");
  const [search, setSearch] = useState("");
  const [qty, setQty] = useState<Record<string, string>>({});
  const [cost, setCost] = useState<Record<string, string>>({});
  const { busy, error, run } = useRun();
  const all = (styles.data?.styles || []).filter((style) => style.status !== "archived");
  const picked = all.filter((style) => style.sizes.some((size) => Number(qty[size.code]) > 0));
  const term = search.trim().toUpperCase();
  const shown = term ? all.filter((style) => style.code.includes(term) || style.name.toUpperCase().includes(term)).slice(0, 8) : all.filter((style) => !supplierId || style.supplierId === supplierId).slice(0, 8);
  const list = [...picked, ...shown.filter((style) => !picked.includes(style))];
  const pieces = Object.values(qty).reduce((sum, value) => sum + (Number(value) || 0), 0);

  const save = () =>
    run(async () => {
      const items = all.flatMap((style) => style.sizes.filter((size) => Number(qty[size.code]) > 0).map((size) => ({ skuCode: size.code, qty: Number(qty[size.code]), ...(cost[style.code] ? { costPaise: toPaise(cost[style.code]) } : {}) })));
      const result = await api<{ order: Po }>("/api/purchase-orders", { method: "POST", body: { supplierId, location: location || undefined, trial, items, note, ...(expected ? { expectedAt: expected } : {}) } });
      onSaved(result.order._id);
    });

  return (
    <Dialog title={trial ? "Test buy" : "New purchase order"} onClose={onClose} wide>
      {trial && <p className="muted small-text">A small first order of a new style (add it as a draft in the catalogue first). The desk judges it against its category after the test days.</p>}
      <div className="form-grid">
        <div className="field">
          <label htmlFor="po-sup">Supplier</label>
          <select id="po-sup" className="input" value={supplierId} onChange={(event) => setSupplierId(event.target.value)}>
            <option value="">Choose…</option>
            {(suppliers.data?.suppliers || []).map((supplier) => (
              <option key={supplier._id} value={supplier._id}>
                {supplier.name}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label htmlFor="po-loc">Deliver to</label>
          <select id="po-loc" className="input" value={location} onChange={(event) => setLocation(event.target.value)}>
            <option value="">Main location</option>
            {(locations.data?.locations || []).filter((row) => row.active).map((row) => (
              <option key={row._id} value={row.code}>
                {row.name}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label htmlFor="po-exp">Needed by</label>
          <input id="po-exp" className="input" type="date" value={expected} onChange={(event) => setExpected(event.target.value)} />
        </div>
      </div>
      <label className="check">
        <input type="checkbox" checked={trial} onChange={(event) => setTrial(event.target.checked)} /> Test buy
      </label>
      <input className="input" placeholder="Find a style by code or name" value={search} onChange={(event) => setSearch(event.target.value)} aria-label="Find a style" />
      <div className="table-scroll">
        <table className="table plain">
          <tbody>
            {list.map((style) => (
              <tr key={style._id}>
                <td>
                  <strong>{style.name}</strong>
                  <div className="muted small-text">
                    {style.code} · {style.status}
                  </div>
                </td>
                <td>
                  <div className="size-inputs">
                    {style.sizes.map((size) => (
                      <label key={size.code}>
                        <span className="muted small-text">{size.size}</span>
                        <input className="input" inputMode="numeric" value={qty[size.code] || ""} onChange={(event) => setQty({ ...qty, [size.code]: event.target.value.replace(/\D/g, "") })} aria-label={`${style.code} size ${size.size}`} />
                      </label>
                    ))}
                  </div>
                </td>
                <td>
                  <input className="input" inputMode="decimal" placeholder={style.costPaise ? String(style.costPaise / 100) : "cost Rs"} value={cost[style.code] || ""} onChange={(event) => setCost({ ...cost, [style.code]: event.target.value })} aria-label={`${style.code} cost per piece`} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="field">
        <label htmlFor="po-note">Note to the supplier</label>
        <input id="po-note" className="input" value={note} onChange={(event) => setNote(event.target.value)} maxLength={500} />
      </div>
      <Notice>{error}</Notice>
      <div className="row-actions">
        <span className="muted">{pieces} pieces</span>
        <span className="spacer" />
        <button className="btn" onClick={onClose}>
          Cancel
        </button>
        <button className="btn primary" disabled={busy || !supplierId || !pieces} onClick={save}>
          Save draft
        </button>
      </div>
    </Dialog>
  );
}

function PoView({ id, canOrder, onClose, onChanged }: { id: string; canOrder: boolean; onClose: () => void; onChanged: () => void }) {
  const loaded = useLoad<{ order: Po; supplier: Supplier | null; text: string }>(`/api/purchase-orders/${id}`);
  const [came, setCame] = useState<Record<string, string>>({});
  const [copied, setCopied] = useState("");
  const { busy, error, run } = useRun();
  const po = loaded.data?.order;
  const act = (path: string, body: object = {}) =>
    run(async () => {
      await api(`/api/purchase-orders/${id}/${path}`, { method: "POST", body });
      setCame({});
      loaded.reload();
      onChanged();
    });
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(loaded.data?.text || "");
      setCopied("Copied.");
    } catch {
      setCopied("Select the text and copy it.");
    }
  };
  const waLink = loaded.data?.supplier?.waId ? `https://wa.me/${loaded.data.supplier.waId}?text=${encodeURIComponent(loaded.data.text)}` : "";

  return (
    <Dialog title={po ? `PO #${po.number}${po.trial ? " · test buy" : ""}` : "Purchase order"} onClose={onClose} wide>
      <Notice>{loaded.error || error}</Notice>
      {po && (
        <>
          <p className="muted small-text">
            {loaded.data?.supplier?.name} · <span className={`badge ${PO_STATUS[po.status][1]}`}>{PO_STATUS[po.status][0]}</span> · made {when(po.createdAt)}
            {po.sentAt ? ` · sent ${dateOnly(po.sentAt)}` : ""}
            {po.expectedAt ? ` · needed by ${dateOnly(po.expectedAt)}` : ""}
          </p>
          <div className="table-scroll">
            <table className="table plain">
              <thead>
                <tr>
                  <th>Piece</th>
                  <th className="num">Ordered</th>
                  <th className="num">Came</th>
                  <th className="num">Cost</th>
                  {["sent", "part_received"].includes(po.status) && canOrder && <th>Arrived now</th>}
                </tr>
              </thead>
              <tbody>
                {po.lines.map((line) => (
                  <tr key={line.skuCode}>
                    <td>
                      {line.name} <span className="muted small-text">{line.skuCode}</span>
                    </td>
                    <td className="num">{line.qty}</td>
                    <td className="num">{line.receivedQty}</td>
                    <td className="num">{rupees(line.costPaise)}</td>
                    {["sent", "part_received"].includes(po.status) && canOrder && (
                      <td>
                        <input className="input" inputMode="numeric" placeholder={String(Math.max(0, line.qty - line.receivedQty))} value={came[line.skuCode] || ""} onChange={(event) => setCame({ ...came, [line.skuCode]: event.target.value.replace(/\D/g, "") })} aria-label={`${line.skuCode} arrived`} />
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <h3>Message for the supplier</h3>
          <pre className="po-text">{loaded.data?.text}</pre>
          <div className="row-actions">
            <button className="btn" onClick={copy}>
              Copy message
            </button>
            {waLink && (
              <a className="btn" href={waLink} target="_blank" rel="noreferrer">
                Open in WhatsApp
              </a>
            )}
            <span className="muted small-text">{copied}</span>
          </div>
          {canOrder && (
            <div className="row-actions">
              {po.status === "draft" && (
                <button className="btn primary" disabled={busy} onClick={() => act("send")}>
                  Mark as sent
                </button>
              )}
              {["sent", "part_received"].includes(po.status) && (
                <>
                  <button className="btn" disabled={busy} onClick={() => setCame(Object.fromEntries(po.lines.map((line) => [line.skuCode, String(Math.max(0, line.qty - line.receivedQty))])))}>
                    All the rest came
                  </button>
                  <button
                    className="btn primary"
                    disabled={busy || !Object.values(came).some((value) => Number(value) > 0)}
                    onClick={() => act("receive", { items: Object.entries(came).filter(([, value]) => Number(value) > 0).map(([skuCode, value]) => ({ skuCode, qty: Number(value) })) })}
                  >
                    Put into stock
                  </button>
                </>
              )}
              {["draft", "sent", "part_received"].includes(po.status) && (
                <button className="btn" disabled={busy} onClick={() => act("cancel")}>
                  {po.status === "part_received" ? "Close: the rest is not coming" : "Cancel order"}
                </button>
              )}
              <span className="spacer" />
              <button className="btn" onClick={onClose}>
                Close
              </button>
            </div>
          )}
        </>
      )}
    </Dialog>
  );
}

// ---- Suppliers, test buys, size mix -----------------------------------------------------------------

function Suppliers({ canOrder, onDraft }: { canOrder: boolean; onDraft: (id: string) => void }) {
  const loaded = useLoad<{ suppliers: Card[] }>("/api/buying/suppliers");
  const { busy, error, run } = useRun();
  const draft = (supplierId: string) =>
    run(async () => {
      const result = await api<{ order: Po }>("/api/purchase-orders/reorder-draft", { method: "POST", body: { supplierId } });
      onDraft(result.order._id);
    });
  return (
    <>
      <p className="muted small-text">Score: how much of what they sent has sold (35), margin (20), returns for quality / damage / not as shown (20), delivery on time and in full (15), all returns (10). Add suppliers in Settings and link styles to them in the catalogue.</p>
      <Notice>{loaded.error || error}</Notice>
      <div className="cards-grid">
        {(loaded.data?.suppliers || []).map((card) => (
          <div key={card._id} className="card">
            <div className="report-head">
              <h3>
                {card.name} <span className="muted small-text">{card.city}</span>
              </h3>
              <Score value={card.score} />
            </div>
            <div className="stats">
              <div className="stat">
                <span className="muted small-text">Sold through</span>
                <strong>{pct(card.sellThrough)}</strong>
              </div>
              <div className="stat">
                <span className="muted small-text">Margin</span>
                <strong>{pct(card.marginPct)}</strong>
              </div>
              <div className="stat">
                <span className="muted small-text">Quality returns</span>
                <strong>{pct(card.qualityRate)}</strong>
              </div>
              <div className="stat">
                <span className="muted small-text">Lead time</span>
                <strong>{card.leadDays === null ? "–" : `${Math.round(card.leadDays)} d`}</strong>
              </div>
            </div>
            <ul className="why">
              {card.why.map((line) => (
                <li key={line}>{line}</li>
              ))}
            </ul>
            {card.top.length > 0 && <p className="muted small-text">Best: {card.top.map((style) => `${style.name} (${style.sold90} in 90 days)`).join(", ")}</p>}
            {canOrder && card.styles > 0 && (
              <button className="btn small" disabled={busy} onClick={() => draft(card._id)}>
                Draft a reorder
              </button>
            )}
          </div>
        ))}
      </div>
      {loaded.data && !loaded.data.suppliers.length && <p className="muted">No suppliers yet: add them in Settings.</p>}
    </>
  );
}

function Trials() {
  const loaded = useLoad<{ trialDays: number; rows: Trial[] }>("/api/buying/trials");
  const rows = loaded.data?.rows || [];
  return (
    <>
      <p className="muted small-text">Each test buy scored on sell-through (50), pace against the usual for its category (30) and pieces kept (20), judged after {loaded.data?.trialDays ?? 21} days.</p>
      <Notice>{loaded.error}</Notice>
      {rows.length ? (
        <div className="table-scroll">
          <table className="table">
            <thead>
              <tr>
                <th>Style</th>
                <th>Score</th>
                <th className="num">Bought</th>
                <th className="num">Sold</th>
                <th className="num">Days</th>
                <th>Next step</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.styleCode}>
                  <td>
                    <strong>{row.name}</strong>
                    <div className="muted small-text">
                      {row.styleCode} · {row.supplier} · PO #{row.poNumber}
                    </div>
                    <div className="muted small-text">{row.why.join(" · ")}</div>
                  </td>
                  <td>
                    <Score value={row.score} />
                  </td>
                  <td className="num">{row.bought}</td>
                  <td className="num">
                    {row.sold} <span className="muted small-text">({pct(row.sellThrough)})</span>
                  </td>
                  <td className="num">{row.daysIn}</td>
                  <td>{row.step}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        loaded.data && <p className="muted">No test buys yet. Use "Test buy" to order a few pieces of a new style first.</p>
      )}
    </>
  );
}

function SizeMix() {
  const loaded = useLoad<{ categories: { category: string; kept: number; sizes: MixSize[] }[] }>("/api/buying/size-mix");
  return (
    <>
      <p className="muted small-text">What sells by size over the last 180 days (pieces kept, after returns), against the share of what came in. Use it for the size split on every order.</p>
      <Notice>{loaded.error}</Notice>
      {(loaded.data?.categories || []).map((cat) => (
        <div key={cat.category} className="card">
          <h3>
            {cat.category} <span className="muted small-text">{cat.kept} kept</span>
          </h3>
          <div className="mix">
            {cat.sizes.map((size) => (
              <div key={size.size} className="mix-col" title={`${size.size}: sells ${pct(size.share)}, bought ${pct(size.boughtShare)}`}>
                <div className="mix-bars">
                  <span className="mix-bar sold" style={{ height: `${Math.round(size.share * 100)}%` }} />
                  <span className="mix-bar bought" style={{ height: `${Math.round(size.boughtShare * 100)}%` }} />
                </div>
                <strong>{size.size}</strong>
                <span className="muted small-text">{pct(size.share)}</span>
              </div>
            ))}
          </div>
          <p className="muted small-text">
            <span className="mix-key sold" /> sells <span className="mix-key bought" /> bought
          </p>
          {cat.sizes.flatMap((size) => size.notes).length > 0 && (
            <ul className="why">
              {cat.sizes.flatMap((size) => size.notes.map((line) => <li key={size.size + line}>{size.size} {line}</li>))}
            </ul>
          )}
        </div>
      ))}
      {loaded.data && !loaded.data.categories.length && <p className="muted">No sales yet.</p>}
    </>
  );
}

// ---- Markdowns and calendar -------------------------------------------------------------------------

function Markdowns({ canMark }: { canMark: boolean }) {
  const loaded = useLoad<{ plan: PlanRow[]; markdowns: MarkdownRow[] }>("/api/buying/markdowns");
  const [doing, setDoing] = useState<PlanRow | null>(null);
  const { busy, error, run } = useRun();
  const end = (markdownId: string) =>
    run(async () => {
      await api(`/api/buying/markdowns/${markdownId}/end`, { method: "POST", body: {} });
      loaded.reload();
    });
  const active = (loaded.data?.markdowns || []).filter((row) => row.status === "active");
  const ended = (loaded.data?.markdowns || []).filter((row) => row.status === "ended");
  return (
    <>
      <p className="muted small-text">Slow pieces by their slow score (days since a sale, sell-through, days on the rail). The suggested markdown grows with the score and never goes below cost plus the minimum markup. Quiet = members pay less at the counter while the rail price stays.</p>
      <Notice>{loaded.error || error}</Notice>
      {active.length > 0 && (
        <>
          <h3>Running now</h3>
          <div className="table-scroll">
            <table className="table plain">
              <tbody>
                {active.map((row) => (
                  <tr key={row._id}>
                    <td>
                      {row.styleCode} <span className={`badge ${row.kind === "quiet" ? "" : "warn"}`}>{row.kind === "quiet" ? "members only" : "public"}</span>
                    </td>
                    <td>
                      {rupees(row.listPaise)} → <strong>{rupees(row.pricePaise)}</strong> ({row.pct}% off)
                    </td>
                    <td>
                      {row.piecesAtStart - row.onHandNow} of {row.piecesAtStart} sold in {row.daysRunning} days
                    </td>
                    <td>{row.until ? `until ${dateOnly(row.until)}` : ""}</td>
                    <td>
                      {canMark && (
                        <button className="btn small" disabled={busy} onClick={() => end(row._id)}>
                          End
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
      <h3>Suggested</h3>
      {loaded.data?.plan.length ? (
        <div className="table-scroll">
          <table className="table">
            <thead>
              <tr>
                <th>Style</th>
                <th>Slow score</th>
                <th className="num">Pieces</th>
                <th>Suggest</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {loaded.data.plan.map((row) => (
                <tr key={row.styleCode}>
                  <td>
                    <strong>{row.name}</strong>
                    <div className="muted small-text">
                      {row.styleCode} · sizes left {row.sizesLeft.join(", ")}
                    </div>
                    <div className="muted small-text">{row.why.join(" · ")}</div>
                  </td>
                  <td>
                    <Score value={row.score} />
                  </td>
                  <td className="num">{row.onHand}</td>
                  <td>
                    {row.suggest.pct ? (
                      <>
                        <strong>
                          {row.suggest.pct}% {row.suggest.kind === "quiet" ? "for members" : "off"}
                        </strong>{" "}
                        {rupees(row.pricePaise)} → {rupees(row.suggest.pricePaise)}
                      </>
                    ) : (
                      "–"
                    )}
                    <div className="muted small-text">{row.suggest.note}</div>
                  </td>
                  <td>
                    {canMark && row.suggest.pct > 0 && (
                      <button className="btn small" onClick={() => setDoing(row)}>
                        Mark down
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        loaded.data && <p className="muted">Nothing is slow enough to mark down.</p>
      )}
      {ended.length > 0 && (
        <>
          <h3>Earlier markdowns</h3>
          <div className="table-scroll">
            <table className="table plain">
              <tbody>
                {ended.map((row) => (
                  <tr key={row._id}>
                    <td>{row.styleCode}</td>
                    <td>
                      {row.pct}% {row.kind === "quiet" ? "members" : "public"}
                    </td>
                    <td>
                      {dateOnly(row.startedAt)}, {row.daysRunning} days
                    </td>
                    <td>{row.cleared === null ? "" : `${pct(row.cleared)} cleared`}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
      {doing && (
        <MarkdownDialog
          row={doing}
          onClose={() => setDoing(null)}
          onDone={() => {
            setDoing(null);
            loaded.reload();
          }}
        />
      )}
    </>
  );
}

function MarkdownDialog({ row, onClose, onDone }: { row: PlanRow; onClose: () => void; onDone: () => void }) {
  const [kind, setKind] = useState<"public" | "quiet">(row.suggest.kind);
  const [percent, setPercent] = useState(String(row.suggest.pct));
  const [until, setUntil] = useState("");
  const [sure, setSure] = useState(false);
  const { busy, error, run } = useRun();
  const value = Number(percent) || 0;
  const raw = Math.round((row.pricePaise * (1 - value / 100)) / 1000) * 1000 - 100;
  const tooLow = raw < row.floorPaise;
  const save = () =>
    run(async () => {
      await api("/api/buying/markdowns", { method: "POST", body: { styleCode: row.styleCode, kind, pct: value, ...(until ? { until } : {}), reason: `slow score ${row.score}` } });
      onDone();
    });
  return (
    <Dialog title={`Mark down ${row.name}`} onClose={onClose}>
      <div className="chips">
        <button className={`chip ${kind === "quiet" ? "on" : ""}`} onClick={() => (setKind("quiet"), setSure(false))}>
          Quiet: members only
        </button>
        <button className={`chip ${kind === "public" ? "on" : ""}`} onClick={() => (setKind("public"), setSure(false))}>
          Public: new price everywhere
        </button>
      </div>
      <div className="form-grid two">
        <div className="field">
          <label htmlFor="md-pct">Off (%)</label>
          <input id="md-pct" className="input" inputMode="numeric" value={percent} onChange={(event) => (setPercent(event.target.value.replace(/\D/g, "")), setSure(false))} />
        </div>
        <div className="field">
          <label htmlFor="md-until">Ends on (optional)</label>
          <input id="md-until" className="input" type="date" value={until} onChange={(event) => setUntil(event.target.value)} />
        </div>
      </div>
      <p>
        {rupees(row.pricePaise)} → <strong>{tooLow ? "below the floor" : rupees(raw)}</strong> <span className="muted small-text">(lowest allowed {rupees(row.floorPaise)})</span>
      </p>
      <p className="muted small-text">{kind === "quiet" ? "The tag price stays. A customer with her phone on the bill pays the member price at the counter." : "Every size gets the new price at the counter and in the WhatsApp catalogue; the old price is kept and comes back when it ends."}</p>
      <Notice>{error}</Notice>
      <div className="row-actions">
        <button className="btn" onClick={onClose}>
          Cancel
        </button>
        {sure ? (
          <button className="btn primary" disabled={busy || tooLow || value < 5} onClick={save}>
            Yes, start it
          </button>
        ) : (
          <button className="btn primary" disabled={tooLow || value < 5} onClick={() => setSure(true)}>
            Start markdown
          </button>
        )}
      </div>
    </Dialog>
  );
}

function Calendar() {
  const loaded = useLoad<{ events: CalendarEvent[] }>("/api/buying/calendar");
  return (
    <>
      <p className="muted small-text">The moments the shop buys for, with the day to order by (the usual lead time plus the weeks before you want the pieces in). Change the list in Settings &gt; Buying desk; festival dates move each year.</p>
      <Notice>{loaded.error}</Notice>
      <div className="table-scroll">
        <table className="table">
          <thead>
            <tr>
              <th>Moment</th>
              <th>Date</th>
              <th>Order by</th>
              <th>For</th>
              <th className="num">In stock now</th>
            </tr>
          </thead>
          <tbody>
            {(loaded.data?.events || []).map((event) => (
              <tr key={event.name + event.date}>
                <td>
                  <strong>{event.name}</strong>
                  <div className="muted small-text">{event.note}</div>
                </td>
                <td>
                  {dateOnly(event.date)} <span className="muted small-text">in {event.daysAway} days</span>
                </td>
                <td>
                  <span className={`badge ${event.orderInDays < 0 ? "danger" : event.orderInDays <= 14 ? "warn" : ""}`}>{event.orderInDays < 0 ? `${-event.orderInDays} days late` : event.orderInDays === 0 ? "today" : `in ${event.orderInDays} days`}</span> <span className="muted small-text">{dateOnly(event.orderBy)}</span>
                </td>
                <td>{event.categories.length ? event.categories.join(", ") : "everything"}</td>
                <td className="num">
                  {event.inStock} <span className="muted small-text">pc, {event.styles} styles</span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}

// ---- Settings ---------------------------------------------------------------------------------------

export function BuyingForm({ settings, canWrite, onSaved }: { settings: Settings; canWrite: boolean; onSaved: () => void }) {
  const b = settings.buying;
  const [form, setForm] = useState({ coverDays: String(b?.coverDays ?? 45), leadDays: String(b?.leadDays ?? 14), minMarkupPct: String(b?.minMarkupPct ?? 15), trialDays: String(b?.trialDays ?? 21) });
  const [events, setEvents] = useState(() => (b?.calendar || []).map((event) => ({ ...event, categories: event.categories.join(", "), buyWeeksBefore: String(event.buyWeeksBefore ?? 4) })));
  const { busy, error, run } = useRun();
  const [saved, setSaved] = useState("");
  const save = () =>
    run(async () => {
      await api("/api/settings", {
        method: "PATCH",
        body: {
          buying: {
            coverDays: Number(form.coverDays),
            leadDays: Number(form.leadDays),
            minMarkupPct: Number(form.minMarkupPct),
            trialDays: Number(form.trialDays),
            calendar: events.filter((event) => event.name.trim() && event.date).map((event) => ({ name: event.name.trim(), date: event.date, yearly: Boolean(event.yearly), buyWeeksBefore: Number(event.buyWeeksBefore) || 0, categories: event.categories.split(",").map((value) => value.trim()).filter(Boolean), note: event.note || "" })),
          },
        },
      });
      setSaved("Saved.");
      onSaved();
    });
  const field = (key: keyof typeof form, label: string) => (
    <div className="field">
      <label htmlFor={`by-${key}`}>{label}</label>
      <input id={`by-${key}`} className="input" inputMode="numeric" value={form[key]} onChange={(event) => setForm({ ...form, [key]: event.target.value })} />
    </div>
  );
  const setEvent = (index: number, changes: object) => setEvents(events.map((event, i) => (i === index ? { ...event, ...changes } : event)));
  return (
    <form className="card form-card" onSubmit={(event) => (event.preventDefault(), save())}>
      <h2>Buying desk</h2>
      <fieldset disabled={!canWrite}>
        <div className="form-grid">
          {field("coverDays", "A reorder covers (days of selling)")}
          {field("leadDays", "Usual supplier lead time (days)")}
          {field("minMarkupPct", "Markdowns keep at least (% over cost)")}
          {field("trialDays", "Judge a test buy after (days)")}
        </div>
        <h3>Buying calendar</h3>
        <div className="table-scroll">
          <table className="table plain">
            <thead>
              <tr>
                <th>Moment</th>
                <th>Date</th>
                <th>Every year</th>
                <th>Weeks before</th>
                <th>Categories</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {events.map((event, index) => (
                <tr key={index}>
                  <td>
                    <input className="input" value={event.name} onChange={(e) => setEvent(index, { name: e.target.value })} aria-label="Moment" />
                  </td>
                  <td>
                    <input className="input" type="date" value={event.date} onChange={(e) => setEvent(index, { date: e.target.value })} aria-label="Date" />
                  </td>
                  <td>
                    <input type="checkbox" checked={Boolean(event.yearly)} onChange={(e) => setEvent(index, { yearly: e.target.checked })} aria-label="Same date every year" />
                  </td>
                  <td>
                    <input className="input" inputMode="numeric" value={event.buyWeeksBefore} onChange={(e) => setEvent(index, { buyWeeksBefore: e.target.value })} aria-label="Weeks before" />
                  </td>
                  <td>
                    <input className="input" value={event.categories} onChange={(e) => setEvent(index, { categories: e.target.value })} placeholder="dresses, tops" aria-label="Categories" />
                  </td>
                  <td>
                    <button type="button" className="btn small" onClick={() => setEvents(events.filter((_, i) => i !== index))} aria-label={`Remove ${event.name}`}>
                      ×
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <button type="button" className="btn small" onClick={() => setEvents([...events, { name: "", date: "", yearly: false, buyWeeksBefore: "4", categories: "", note: "" }])}>
          Add a moment
        </button>
      </fieldset>
      <Notice>{error}</Notice>
      <Notice tone="ok">{saved}</Notice>
      {canWrite && (
        <button className="btn primary" disabled={busy}>
          Save buying desk
        </button>
      )}
    </form>
  );
}
