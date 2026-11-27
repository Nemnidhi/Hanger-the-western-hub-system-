import { useState } from "react";
import { api } from "../api";
import { rupees, when } from "../format";
import { Dialog, Notice, useLoad, useRun } from "../ui";

// Returns and exchanges, shared by the Orders page and the Counter: choose the pieces that came back,
// why, whether they can be sold again, and how the money goes back.

export interface ReturnableLine { skuCode: string; name: string; size: string; qty: number; returnedQty?: number; unitPaise: number }
export interface ReturnDone { return: { _id: string; number: number; refund: { method: string; amountPaise: number } }; creditNote: { _id: string; number: string } | null }
interface FoundOrder { _id: string; number: number; channel: string; customer: { name: string; phone: string }; shipToName: string; createdAt: string; invoiceNumber: string; payment: string; lines: ReturnableLine[] }

export const REFUND_LABEL: Record<string, string> = {
  original: "Back to the original payment (Razorpay / UPI)",
  cash: "Cash",
  upi: "UPI",
  card: "Card",
  exchange: "Exchange (credit into a new bill)",
  store_credit: "Store credit (noted)",
  none: "No refund",
};

type Pick = { qty: number; reason: string; damaged: boolean };

export function ReturnDialog({ orderId, lines, channel, location, onClose, onDone }: { orderId: string; lines: ReturnableLine[]; channel: string; location?: string; onClose: () => void; onDone: (done: ReturnDone) => void }) {
  const reasons = useLoad<{ reasons: { id: string; label: string }[]; refunds: string[] }>("/api/returns/reasons");
  const open = lines.filter((line) => line.qty > (line.returnedQty || 0));
  const [picks, setPicks] = useState<Record<string, Pick>>(() => Object.fromEntries(open.map((line) => [line.skuCode, { qty: open.length === 1 ? line.qty - (line.returnedQty || 0) : 0, reason: "", damaged: false }])));
  const [method, setMethod] = useState(channel === "store" ? "exchange" : "original");
  const [note, setNote] = useState("");
  const { busy, error, setError, run } = useRun();
  const chosen = open.filter((line) => picks[line.skuCode]?.qty > 0);
  const amount = chosen.reduce((sum, line) => sum + line.unitPaise * picks[line.skuCode].qty, 0);
  const set = (code: string, change: Partial<Pick>) => setPicks({ ...picks, [code]: { ...picks[code], ...change } });
  const methods = channel === "store" ? ["exchange", "cash", "upi", "card", "store_credit"] : ["original", "upi", "exchange", "store_credit", "none"];

  async function submit() {
    if (!chosen.length) return setError("Choose how many of each piece came back.");
    const missing = chosen.find((line) => !picks[line.skuCode].reason);
    if (missing) return setError(`Say why ${missing.skuCode} came back.`);
    const done = await run(() =>
      api<ReturnDone>(`/api/orders/${orderId}/returns`, {
        method: "POST",
        body: { items: chosen.map((line) => ({ skuCode: line.skuCode, qty: picks[line.skuCode].qty, reason: picks[line.skuCode].reason, condition: picks[line.skuCode].damaged ? "damaged" : "resell" })), note: note.trim(), refund: { method }, location },
      }),
    );
    if (done) onDone(done);
  }

  return (
    <Dialog title="Pieces coming back" onClose={onClose} wide>
      <Notice>{reasons.error}</Notice>
      <table className="table plain return-lines">
        <tbody>
          {open.map((line) => {
            const left = line.qty - (line.returnedQty || 0);
            const pick = picks[line.skuCode];
            return (
              <tr key={line.skuCode}>
                <td>
                  <strong>{line.skuCode}</strong> <span className="muted">{line.name}</span>
                  <div className="muted small-text">
                    {rupees(line.unitPaise)} each · {left} can come back
                  </div>
                </td>
                <td className="num">
                  <input className="input qty-input" type="number" min={0} max={left} value={pick.qty} onChange={(event) => set(line.skuCode, { qty: Math.max(0, Math.min(left, Math.floor(Number(event.target.value)) || 0)) })} aria-label={`Pieces of ${line.skuCode} back`} />
                </td>
                <td>
                  <select className="input" value={pick.reason} onChange={(event) => set(line.skuCode, { reason: event.target.value })} disabled={!pick.qty} aria-label={`Why ${line.skuCode} came back`}>
                    <option value="">Why?</option>
                    {(reasons.data?.reasons || []).map((reason) => (
                      <option key={reason.id} value={reason.id}>
                        {reason.label}
                      </option>
                    ))}
                  </select>
                </td>
                <td>
                  <label className="check small-text">
                    <input type="checkbox" checked={pick.damaged} disabled={!pick.qty} onChange={(event) => set(line.skuCode, { damaged: event.target.checked })} /> Damaged (not for sale)
                  </label>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <div className="form-grid two">
        <div className="field">
          <label htmlFor="ret-method">Money back</label>
          <select id="ret-method" className="input" value={method} onChange={(event) => setMethod(event.target.value)}>
            {methods.map((id) => (
              <option key={id} value={id}>
                {REFUND_LABEL[id]}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label htmlFor="ret-note">Note (optional)</label>
          <input id="ret-note" className="input" maxLength={300} value={note} onChange={(event) => setNote(event.target.value)} placeholder="Tag still on, packed well" />
        </div>
      </div>
      <p className="muted small-text">
        {chosen.length ? `${rupees(amount)} back` : "Nothing chosen yet"}. Pieces fit to sell go back on the shelf{location ? " of this store" : ""}; a credit note is made for exactly these pieces.
        {method === "original" ? " Refund the online payment in Razorpay, or by UPI for cash on delivery." : ""}
      </p>
      <Notice>{error}</Notice>
      <div className="row-actions">
        <button className="btn primary" disabled={busy || !chosen.length} onClick={submit}>
          {busy ? "Saving…" : method === "exchange" ? "Take back, then bill the new pieces" : "Take back"}
        </button>
        <button className="btn" onClick={onClose}>
          Cancel
        </button>
      </div>
    </Dialog>
  );
}

/** The counter's way in: find the bill by its number, invoice number or her phone. */
export function FindBillDialog({ location, onClose, onDone }: { location: string; onClose: () => void; onDone: (done: ReturnDone) => void }) {
  const [q, setQ] = useState("");
  const [search, setSearch] = useState("");
  const found = useLoad<{ orders: FoundOrder[] }>(search ? `/api/returns/find?q=${encodeURIComponent(search)}` : null);
  const [chosen, setChosen] = useState<FoundOrder | null>(null);

  if (chosen) return <ReturnDialog orderId={chosen._id} lines={chosen.lines} channel={chosen.channel} location={location} onClose={() => setChosen(null)} onDone={onDone} />;
  return (
    <Dialog title="Return or exchange" onClose={onClose} wide>
      <form className="row-actions" onSubmit={(event) => (event.preventDefault(), setSearch(q.trim()))}>
        <input className="input" autoFocus value={q} onChange={(event) => setQ(event.target.value)} placeholder="Bill number, invoice number (ST1/2627/00012) or her phone" aria-label="Find the bill" />
        <button className="btn primary" disabled={q.trim().length < 3}>
          Find
        </button>
      </form>
      <Notice>{found.error}</Notice>
      {found.data && !found.data.orders.length && <p className="muted">No delivered order or bill found. Online orders can be returned once delivered.</p>}
      {(found.data?.orders || []).map((order) => {
        const left = order.lines.reduce((sum, line) => sum + line.qty - (line.returnedQty || 0), 0);
        return (
          <button key={order._id} className="found-bill" onClick={() => setChosen(order)} disabled={!left}>
            <strong>
              #{order.number} · {order.invoiceNumber}
            </strong>
            <span className="muted small-text">
              {order.channel === "store" ? "Store bill" : "Online order"} · {when(order.createdAt)} · {order.customer.name || order.shipToName || "Walk-in"}
              {order.customer.phone ? ` · ${order.customer.phone}` : ""}
            </span>
            <span className="small-text">{order.lines.map((line) => `${line.qty} x ${line.skuCode}${line.returnedQty ? ` (${line.returnedQty} back)` : ""}`).join(", ")}</span>
          </button>
        );
      })}
    </Dialog>
  );
}
