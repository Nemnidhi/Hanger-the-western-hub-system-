import { useEffect, useState } from "react";
import { api, can, type Me } from "../api";
import { dateOnly, rupees } from "../format";
import { Notice, useLoad, useRun } from "../ui";
import { words } from "./InvoicePrint";

// A delivery challan for stock moved between the shop's own locations, laid out for A4, with the
// e-way bill data below it (not printed): what is missing, the transport details, the portal's
// bulk-upload JSON to copy or download, and the e-way bill number once the portal gives one.
// Opened at #challan/<id>.

export interface TransferLine {
  skuCode: string;
  styleCode: string;
  name: string;
  size: string;
  hsn: string;
  qty: number;
  unitValuePaise: number;
  gstRate: number;
}
export interface Transfer {
  _id: string;
  number: number;
  challanNo: string;
  lines: TransferLine[];
  valuePaise: number;
  sameGstin: boolean;
  ewayNeeded: boolean;
  transport: { mode: "road" | "rail" | "air" | "ship"; vehicleNo: string; transporterName: string; transporterId: string; distanceKm: number };
  ewayBillNo: string;
  ewayBillAt: string | null;
  note: string;
  by: string;
  at: string;
}
interface Place {
  name: string;
  gstin: string;
  stateCode: string;
  place: string;
  pincode: string;
  address: string;
}
interface Eway {
  json: { version: string; billLists: Record<string, unknown>[] };
  problems: string[];
  from: Place;
  to: Place;
}
interface View {
  transfer: Transfer;
  eway: Eway;
  business: { legalName: string; brandName: string; gstin: string; address: string };
  thresholdPaise: number;
}

export function Challan({ id, me }: { id: string; me: Me }) {
  const loaded = useLoad<View>(`/api/transfers/${id}`);
  const [view, setView] = useState<View | null>(null);
  useEffect(() => setView(loaded.data), [loaded.data]);
  if (loaded.error) return <Notice>{loaded.error}</Notice>;
  if (!view) return <div className="empty">Loading…</div>;
  const { transfer, eway, business } = view;
  const pieces = transfer.lines.reduce((sum, line) => sum + line.qty, 0);

  return (
    <div className="invoice-page">
      <div className="no-print invoice-tools">
        <button className="btn primary" onClick={() => window.print()}>
          Print challan
        </button>
        <a className="btn" href="#stock">
          Back to stock
        </a>
      </div>
      <article className="invoice">
        <header>
          <div>
            <h1>{business.legalName || business.brandName || "—"}</h1>
            <div>{business.address}</div>
            <div>GSTIN: {business.gstin || "not set"}</div>
          </div>
          <div className="invoice-title">
            <h2>Delivery challan</h2>
            <div>
              No. <strong>{transfer.challanNo}</strong>
            </div>
            <div>Date {dateOnly(transfer.at)}</div>
            <div>{transfer.sameGstin ? "Stock transfer, not a sale" : "Supply between branches"}</div>
          </div>
        </header>

        <section className="invoice-parties">
          {[
            ["From", eway.from],
            ["To", eway.to],
          ].map(([label, place]) => {
            const p = place as Place;
            return (
              <div key={label as string}>
                <div className="label">{label as string}</div>
                <div>
                  <strong>{p.name}</strong>
                </div>
                <div className="pre">{p.address}</div>
                <div>
                  {p.place !== p.name ? p.place : ""} {p.pincode}
                </div>
                <div>GSTIN: {p.gstin || "—"}</div>
              </div>
            );
          })}
        </section>

        <table className="invoice-lines">
          <thead>
            <tr>
              <th>#</th>
              <th>Item</th>
              <th>HSN</th>
              <th className="num">Qty</th>
              <th className="num">Value each</th>
              <th className="num">Value</th>
            </tr>
          </thead>
          <tbody>
            {transfer.lines.map((line, index) => (
              <tr key={line.skuCode}>
                <td>{index + 1}</td>
                <td>
                  {line.name || line.styleCode} · {line.size}
                  <div className="muted small-text">{line.skuCode}</div>
                </td>
                <td>{line.hsn}</td>
                <td className="num">{line.qty}</td>
                <td className="num">{rupees(line.unitValuePaise)}</td>
                <td className="num">{rupees(line.unitValuePaise * line.qty)}</td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr>
              <td colSpan={3}>Total</td>
              <td className="num">{pieces}</td>
              <td />
              <td className="num">{rupees(transfer.valuePaise)}</td>
            </tr>
          </tfoot>
        </table>
        <p>
          Value in words: <strong>{words(transfer.valuePaise)}</strong>
        </p>
        <p className="small-text">
          Ready-made garments moved between our own premises{transfer.sameGstin ? " under the same GSTIN, not for sale; no tax charged" : ""}. Value at cost (the price before GST where no cost is entered).
          {transfer.transport.vehicleNo && ` Vehicle ${transfer.transport.vehicleNo}.`}
          {transfer.ewayBillNo && ` E-way bill ${transfer.ewayBillNo}.`}
        </p>
        {transfer.note && <p className="small-text">Note: {transfer.note}</p>}
        <footer className="challan-sign">
          <div>Sent by: {transfer.by}</div>
          <div>Received by (name and signature): ____________________</div>
        </footer>
      </article>

      <EwayPanel view={view} canWrite={can(me, "stock:write")} onSaved={(next) => setView({ ...view, ...next })} />
    </div>
  );
}

function EwayPanel({ view, canWrite, onSaved }: { view: View; canWrite: boolean; onSaved: (next: { transfer: Transfer; eway: Eway }) => void }) {
  const { transfer, eway, thresholdPaise } = view;
  const { busy, error, run } = useRun();
  const [form, setForm] = useState({
    mode: transfer.transport.mode,
    vehicleNo: transfer.transport.vehicleNo,
    transporterName: transfer.transport.transporterName,
    transporterId: transfer.transport.transporterId,
    distanceKm: String(transfer.transport.distanceKm || ""),
    ewayBillNo: transfer.ewayBillNo,
  });
  const [copied, setCopied] = useState("");
  const text = JSON.stringify(eway.json, null, 2);
  const set = (key: keyof typeof form) => (event: { target: { value: string } }) => setForm({ ...form, [key]: event.target.value });

  const save = () =>
    run(async () => {
      const next = await api<{ transfer: Transfer; eway: Eway }>(`/api/transfers/${transfer._id}`, {
        method: "PATCH",
        body: {
          transport: { mode: form.mode, vehicleNo: form.vehicleNo.replace(/[\s-]/g, ""), transporterName: form.transporterName, transporterId: form.transporterId, distanceKm: Number(form.distanceKm) || 0 },
          ewayBillNo: form.ewayBillNo.replace(/\s/g, ""),
        },
      });
      onSaved(next);
      setCopied("Saved.");
    });
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied("JSON copied.");
    } catch {
      setCopied("Could not copy; select the text below.");
    }
  };
  const download = () => {
    const url = URL.createObjectURL(new Blob([text], { type: "application/json" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = `eway-${transfer.challanNo.replace(/\//g, "-")}.json`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  return (
    <section className="card form-card no-print eway-panel">
      <h2>E-way bill</h2>
      {transfer.ewayBillNo ? (
        <Notice tone="ok">E-way bill {transfer.ewayBillNo} is recorded for this challan.</Notice>
      ) : transfer.ewayNeeded ? (
        <Notice tone="warn">
          This move is worth {rupees(transfer.valuePaise)}, at or above the {rupees(thresholdPaise)} limit: make an e-way bill on the government portal before the goods leave, then write its number here.
        </Notice>
      ) : (
        <p className="muted">
          Worth {rupees(transfer.valuePaise)}, under the {rupees(thresholdPaise)} limit: the challan is enough. You can still make an e-way bill if you want one.
        </p>
      )}
      {eway.problems.length > 0 && (
        <ul className="problems">
          {eway.problems.map((line) => (
            <li key={line}>{line}</li>
          ))}
        </ul>
      )}
      <form onSubmit={(event) => (event.preventDefault(), save())}>
        <fieldset disabled={!canWrite}>
          <div className="form-grid">
            <div className="field">
              <label htmlFor="ew-mode">Transport</label>
              <select id="ew-mode" className="input" value={form.mode} onChange={set("mode")}>
                <option value="road">Road</option>
                <option value="rail">Rail</option>
                <option value="air">Air</option>
                <option value="ship">Ship</option>
              </select>
            </div>
            <div className="field">
              <label htmlFor="ew-vehicle">Vehicle number</label>
              <input id="ew-vehicle" className="input" value={form.vehicleNo} onChange={set("vehicleNo")} placeholder="MP09AB1234" />
            </div>
            <div className="field">
              <label htmlFor="ew-km">Distance (km)</label>
              <input id="ew-km" className="input" inputMode="numeric" value={form.distanceKm} onChange={set("distanceKm")} />
            </div>
            <div className="field">
              <label htmlFor="ew-tname">Transporter (if any)</label>
              <input id="ew-tname" className="input" value={form.transporterName} onChange={set("transporterName")} />
            </div>
            <div className="field">
              <label htmlFor="ew-tid">Transporter ID</label>
              <input id="ew-tid" className="input" value={form.transporterId} onChange={set("transporterId")} placeholder="15 characters" />
            </div>
            <div className="field">
              <label htmlFor="ew-no">E-way bill number</label>
              <input id="ew-no" className="input" inputMode="numeric" value={form.ewayBillNo} onChange={set("ewayBillNo")} placeholder="12 digits, from the portal" />
            </div>
          </div>
          <div className="row-actions">
            <button className="btn primary" disabled={busy}>
              Save
            </button>
            <button type="button" className="btn" onClick={copy}>
              Copy JSON
            </button>
            <button type="button" className="btn" onClick={download}>
              Download JSON
            </button>
          </div>
        </fieldset>
      </form>
      <Notice>{error}</Notice>
      <Notice tone="ok">{copied}</Notice>
      <p className="muted small-text">
        On the e-way bill portal: e-Waybill › Generate Bulk › upload this file. Check every field there before you submit; the portal gives the e-way bill number.
      </p>
      <details>
        <summary>See the JSON</summary>
        <pre className="po-text">{text}</pre>
      </details>
    </section>
  );
}
