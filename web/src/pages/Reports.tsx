import { useState } from "react";
import { rupees } from "../format";
import { Notice, useLoad } from "../ui";

// The owner's and manager's reports: sales over a period, stock value and the slow pieces, and the
// month's GST summary for the CA. Every table can be saved as a CSV file for a spreadsheet.

type Tab = "sales" | "stock" | "gst";

interface SalesRow { netPaise: number; bills: number }
interface StyleRow { styleCode: string; name: string; category: string; pieces: number; returned: number; netPaise: number; taxablePaise: number; costPaise: number; marginPaise: number | null; marginPct: number | null }
interface DeliveryRow { sent: number; delivered: number; rto: number; returned: number; onTheWay: number; rtoRate: number | null; returnRate: number | null }
interface SalesReport {
  period: { from: string; to: string; days: number };
  totals: { salesPaise: number; returnsPaise: number; netPaise: number; taxablePaise: number; gstPaise: number; invoices: number; creditNotes: number; pieces: number; piecesReturned: number; averageBillPaise: number; marginPaise: number; costCoverage: number };
  byDay: { day: string; salesPaise: number; returnsPaise: number; bills: number }[];
  byChannel: (SalesRow & { channel: string })[];
  byPayment: (SalesRow & { method: string })[];
  byLocation: (SalesRow & { location: string })[];
  byCategory: { category: string; pieces: number; netPaise: number }[];
  bySize: { size: string; pieces: number; netPaise: number; returned: number }[];
  topStyles: StyleRow[];
  delivery: { cod: DeliveryRow; prepaid: DeliveryRow };
  returns: {
    pieces: number;
    byReason: { reason: string; pieces: number; valuePaise: number }[];
    byChannel: { channel: string; pieces: number; valuePaise: number }[];
    topStyles: { styleCode: string; name: string; pieces: number; damaged: number; reasons: Record<string, number>; soldInPeriod: number; returnRate: number | null; fitLean: number }[];
  };
}
interface SlowRow { styleCode: string; name: string; category: string; status: string; onHand: number; sizes: Record<string, number>; atPricePaise: number; atCostPaise: number; daysOnRail: number; daysSinceSale: number; sold60: number; sellThrough: number; daysOfCover: number | null; score: number; why: string[] }
interface StockReport {
  value: { pieces: number; atPricePaise: number; atCostPaise: number; costedPieces: number; styles: number };
  byLocation: { location: string; pieces: number; atPricePaise: number; atCostPaise: number }[];
  byCategory: { category: string; pieces: number; atPricePaise: number; atCostPaise: number }[];
  slow: SlowRow[];
}
interface GstMoney { taxablePaise: number; cgstPaise: number; sgstPaise: number; igstPaise: number }
interface GstReport {
  month: string;
  totals: GstMoney & { totalPaise: number };
  invoices: number;
  creditNotes: number;
  b2cs: (GstMoney & { stateCode: string; state: string; rate: number; interState: boolean })[];
  b2cl: (GstMoney & { number: string; date: string; placeOfSupply: { stateCode: string; state: string }; totalPaise: number; rates: number[] })[];
  cdnur: (GstMoney & { number: string; date: string; against: string; placeOfSupply: { stateCode: string; state: string }; totalPaise: number })[];
  hsn: (GstMoney & { hsn: string; rate: number; qty: number; totalPaise: number })[];
  documents: { series: string; kind: string; from: string; to: string; count: number; missing: number }[];
}

const CHANNEL: Record<string, string> = { store: "Store counter", whatsapp: "WhatsApp", website: "Website", phone: "Phone", marketplace: "Marketplace", unknown: "Other" };
const METHOD: Record<string, string> = { store_cash: "Cash", store_upi: "UPI", store_card: "Card", prepaid: "Paid online", cod: "Cash on delivery", unknown: "Other" };

const indiaDay = (date: Date) => new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata" }).format(date);
const pct = (value: number | null | undefined) => (value === null || value === undefined ? "–" : `${Math.round(value * 100)}%`);
const shortDay = (day: string) => new Intl.DateTimeFormat("en-IN", { day: "numeric", month: "short", timeZone: "UTC" }).format(new Date(`${day}T00:00:00Z`));
const amount = (paise: number) => (paise / 100).toFixed(2);
const REASON: Record<string, string> = { too_small: "Too small", too_big: "Too big", fit: "Fit not right", looks_different: "Looks different", quality: "Quality / fabric", damaged: "Damaged", wrong_item: "Wrong piece sent", changed_mind: "Changed her mind", late: "Came too late", other: "Other" };

/** Saves rows as a CSV file (opens in Excel or Google Sheets). */
function saveCsv(name: string, header: string[], rows: (string | number)[][]) {
  const cell = (value: string | number) => (/[",\n]/.test(String(value)) ? `"${String(value).replace(/"/g, '""')}"` : String(value));
  const text = [header, ...rows].map((row) => row.map(cell).join(",")).join("\r\n");
  const link = document.createElement("a");
  link.href = URL.createObjectURL(new Blob([`﻿${text}`], { type: "text/csv;charset=utf-8" }));
  link.download = `${name}.csv`;
  link.click();
  setTimeout(() => URL.revokeObjectURL(link.href), 10_000);
}

function CsvButton({ onClick }: { onClick: () => void }) {
  return (
    <button className="btn small" onClick={onClick}>
      Save as CSV
    </button>
  );
}

function presets() {
  const today = indiaDay(new Date());
  const [year, month] = today.split("-").map(Number);
  const back = (days: number) => indiaDay(new Date(Date.now() - days * 86_400_000));
  const monthStart = `${today.slice(0, 7)}-01`;
  const lastMonthEnd = indiaDay(new Date(Date.UTC(year, month - 1, 1) - 86_400_000 + 12 * 3_600_000));
  const fyStart = `${month >= 4 ? year : year - 1}-04-01`;
  return [
    { id: "today", label: "Today", from: today, to: today },
    { id: "7", label: "Last 7 days", from: back(6), to: today },
    { id: "30", label: "Last 30 days", from: back(29), to: today },
    { id: "month", label: "This month", from: monthStart, to: today },
    { id: "lastMonth", label: "Last month", from: `${lastMonthEnd.slice(0, 7)}-01`, to: lastMonthEnd },
    { id: "fy", label: "This financial year", from: fyStart, to: today },
  ];
}

export function Reports() {
  const [tab, setTab] = useState<Tab>("sales");
  return (
    <div className="page">
      <h1>Reports</h1>
      <div className="chips" role="tablist">
        {(
          [
            ["sales", "Sales"],
            ["stock", "Stock and slow pieces"],
            ["gst", "GST for the CA"],
          ] as [Tab, string][]
        ).map(([id, label]) => (
          <button key={id} role="tab" aria-selected={tab === id} className={`chip${tab === id ? " on" : ""}`} onClick={() => setTab(id)}>
            {label}
          </button>
        ))}
      </div>
      {tab === "sales" && <Sales />}
      {tab === "stock" && <Stock />}
      {tab === "gst" && <Gst />}
    </div>
  );
}

function Sales() {
  const options = presets();
  const [range, setRange] = useState({ id: "30", from: options[2].from, to: options[2].to });
  const { data, error } = useLoad<SalesReport>(`/api/reports/sales?from=${range.from}&to=${range.to}`);
  const t = data?.totals;

  return (
    <>
      <div className="report-bar">
        <div className="chips">
          {options.map((option) => (
            <button key={option.id} className={`chip${range.id === option.id ? " on" : ""}`} onClick={() => setRange({ id: option.id, from: option.from, to: option.to })}>
              {option.label}
            </button>
          ))}
        </div>
        <div className="report-dates">
          <input className="input" type="date" value={range.from} max={range.to} onChange={(event) => event.target.value && setRange({ id: "", from: event.target.value, to: range.to })} aria-label="From" />
          <span className="muted">to</span>
          <input className="input" type="date" value={range.to} min={range.from} onChange={(event) => event.target.value && setRange({ id: "", from: range.from, to: event.target.value })} aria-label="To" />
        </div>
      </div>
      <Notice>{error}</Notice>
      {data && t && (
        <>
          <div className="stats">
            <Stat label="Net sales" value={rupees(t.netPaise)} hint={`${rupees(t.salesPaise)} sold, ${rupees(t.returnsPaise)} back`} />
            <Stat label="Bills" value={String(t.invoices)} hint={`Average bill ${rupees(t.averageBillPaise)}`} />
            <Stat label="Pieces sold" value={String(t.pieces - t.piecesReturned)} hint={`${t.pieces} out, ${t.piecesReturned} back (${pct(t.pieces ? t.piecesReturned / t.pieces : 0)})`} />
            <Stat label="Margin" value={t.costCoverage ? rupees(t.marginPaise) : "–"} hint={t.costCoverage ? `Before GST, less cost. Cost entered for ${pct(t.costCoverage)} of sales` : "Enter each style's cost to see margin"} />
            <Stat label="GST in the sales" value={rupees(t.gstPaise)} hint={`Value before GST ${rupees(t.taxablePaise)}`} />
          </div>

          <DayBars days={data.byDay} />

          <div className="report-grid">
            <MiniTable title="By channel" rows={data.byChannel.map((row) => [CHANNEL[row.channel] || row.channel, row.bills, rupees(row.netPaise)])} head={["", "Bills", "Net"]} />
            <MiniTable title="By payment" rows={data.byPayment.map((row) => [METHOD[row.method] || row.method, row.bills, rupees(row.netPaise)])} head={["", "Bills", "Net"]} />
            <MiniTable title="By location" rows={data.byLocation.map((row) => [row.location, row.bills, rupees(row.netPaise)])} head={["", "Bills", "Net"]} />
            <MiniTable title="By category" rows={data.byCategory.map((row) => [row.category, row.pieces, rupees(row.netPaise)])} head={["", "Pieces", "Net"]} />
            <MiniTable title="By size" rows={data.bySize.map((row) => [row.size, row.pieces, row.returned ? `${row.returned} back` : ""])} head={["", "Pieces", ""]} />
            <Delivery delivery={data.delivery} />
          </div>

          {data.returns.pieces > 0 && <ReturnsSection returns={data.returns} />}

          <div className="report-head">
            <h2 className="section-title">Best styles</h2>
            <CsvButton
              onClick={() =>
                saveCsv(
                  `sales-by-style-${data.period.from}-to-${data.period.to}`,
                  ["Style", "Name", "Category", "Pieces (net)", "Returned", "Net sales (Rs)", "Before GST (Rs)", "Cost (Rs)", "Margin (Rs)", "Margin %"],
                  data.topStyles.map((row) => [row.styleCode, row.name, row.category, row.pieces, row.returned, amount(row.netPaise), amount(row.taxablePaise), row.marginPaise === null ? "" : amount(row.costPaise), row.marginPaise === null ? "" : amount(row.marginPaise), row.marginPct === null ? "" : Math.round(row.marginPct * 100)]),
                )
              }
            />
          </div>
          {data.topStyles.length ? (
            <div className="table-scroll">
              <table className="table">
                <thead>
                  <tr>
                    <th>Style</th>
                    <th className="num">Pieces</th>
                    <th className="num">Back</th>
                    <th className="num">Net sales</th>
                    <th className="num">Margin</th>
                  </tr>
                </thead>
                <tbody>
                  {data.topStyles.map((row) => (
                    <tr key={row.styleCode}>
                      <td>
                        <strong>{row.styleCode}</strong> <span className="muted">{row.name}</span>
                      </td>
                      <td className="num">{row.pieces}</td>
                      <td className="num">{row.returned || ""}</td>
                      <td className="num">{rupees(row.netPaise)}</td>
                      <td className="num">{row.marginPaise === null ? <span className="muted">no cost</span> : `${rupees(row.marginPaise)} · ${pct(row.marginPct)}`}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <p className="muted">No sales in these days.</p>
          )}
        </>
      )}
    </>
  );
}

function ReturnsSection({ returns }: { returns: SalesReport["returns"] }) {
  const lean = (value: number) => (value <= -0.25 ? "runs small" : value >= 0.25 ? "runs big" : "");
  return (
    <>
      <h2 className="section-title">Why pieces came back</h2>
      <div className="report-grid">
        <MiniTable title={`Reasons (${returns.pieces} pieces)`} head={["", "Pieces", "Value"]} rows={returns.byReason.map((row) => [REASON[row.reason] || row.reason, row.pieces, rupees(row.valuePaise)])} />
        <section className="report-card wide">
          <h3>Styles that come back most</h3>
          <table className="table plain">
            <thead>
              <tr>
                <th>Style</th>
                <th className="num">Back</th>
                <th className="num">Of billed</th>
                <th>Size feedback</th>
                <th>Reasons</th>
              </tr>
            </thead>
            <tbody>
              {returns.topStyles.map((row) => (
                <tr key={row.styleCode}>
                  <td>
                    <strong>{row.styleCode}</strong> <span className="muted">{row.name}</span>
                  </td>
                  <td className="num">
                    {row.pieces}
                    {row.damaged ? <span className="muted small-text"> ({row.damaged} damaged)</span> : null}
                  </td>
                  <td className="num">{pct(row.returnRate)}</td>
                  <td>
                    <span className="fit-lean" title="Left: comes back too small. Right: too big." aria-label={`Fit lean ${row.fitLean.toFixed(2)}`}>
                      <span style={{ left: `${50 + row.fitLean * 50}%` }} />
                    </span>{" "}
                    <span className="small-text">{lean(row.fitLean)}</span>
                  </td>
                  <td className="small-text">
                    {Object.entries(row.reasons)
                      .sort((a, b) => b[1] - a[1])
                      .map(([reason, n]) => `${REASON[reason] || reason} ${n}`)
                      .join(" · ")}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="muted small-text">A style that keeps coming back too small can be marked "runs small" in the catalogue, so the trial room and website suggest a size up.</p>
        </section>
      </div>
    </>
  );
}

function Stat({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="stat">
      <div className="muted">{label}</div>
      <div className="stat-value">{value}</div>
      {hint && <div className="muted small-text">{hint}</div>}
    </div>
  );
}

function MiniTable({ title, head, rows }: { title: string; head: string[]; rows: (string | number)[][] }) {
  return (
    <section className="report-card">
      <h3>{title}</h3>
      {rows.length ? (
        <table className="table plain">
          <thead>
            <tr>
              {head.map((cell, index) => (
                <th key={index} className={index ? "num" : ""}>
                  {cell}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row, index) => (
              <tr key={index}>
                {row.map((cell, column) => (
                  <td key={column} className={column ? "num" : ""}>
                    {cell}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <p className="muted small-text">Nothing yet.</p>
      )}
    </section>
  );
}

function Delivery({ delivery }: { delivery: SalesReport["delivery"] }) {
  const line = (label: string, row: DeliveryRow) => [label, row.sent, row.delivered, `${row.rto} (${pct(row.rtoRate)})`, `${row.returned} (${pct(row.returnRate)})`];
  return (
    <section className="report-card wide">
      <h3>Online orders sent</h3>
      <table className="table plain">
        <thead>
          <tr>
            <th></th>
            <th className="num">Sent</th>
            <th className="num">Delivered</th>
            <th className="num">Came back (RTO)</th>
            <th className="num">Returned</th>
          </tr>
        </thead>
        <tbody>
          {[line("Cash on delivery", delivery.cod), line("Paid online", delivery.prepaid)].map((row) => (
            <tr key={row[0]}>
              {row.map((cell, column) => (
                <td key={column} className={column ? "num" : ""}>
                  {cell}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      <p className="muted small-text">Rates are of the orders that have arrived or come back; {delivery.cod.onTheWay + delivery.prepaid.onTheWay} still on the way.</p>
    </section>
  );
}

/** Sales a day as bars, returns as a darker bar beside each. */
function DayBars({ days }: { days: SalesReport["byDay"] }) {
  if (days.length < 2) return null;
  const top = Math.max(1, ...days.map((day) => Math.max(day.salesPaise, day.returnsPaise)));
  const width = 1000;
  const height = 150;
  const step = width / days.length;
  const bar = Math.max(1, step * 0.7);
  const best = days.reduce((a, b) => (b.salesPaise > a.salesPaise ? b : a));
  return (
    <figure className="day-bars">
      <svg viewBox={`0 0 ${width} ${height + 18}`} preserveAspectRatio="none" role="img" aria-label={`Sales a day; best day ${shortDay(best.day)} with ${rupees(best.salesPaise)}`}>
        {days.map((day, index) => {
          const salesHeight = (day.salesPaise / top) * height;
          const returnsHeight = (day.returnsPaise / top) * height;
          return (
            <g key={day.day}>
              <title>{`${shortDay(day.day)}: ${rupees(day.salesPaise)} sold in ${day.bills} bill${day.bills === 1 ? "" : "s"}${day.returnsPaise ? `, ${rupees(day.returnsPaise)} back` : ""}`}</title>
              <rect x={index * step + (step - bar) / 2} y={height - salesHeight} width={bar} height={salesHeight || 0.5} className="bar-sales" />
              {day.returnsPaise > 0 && <rect x={index * step + (step - bar) / 2} y={height - returnsHeight} width={bar * 0.35} height={returnsHeight} className="bar-returns" />}
            </g>
          );
        })}
      </svg>
      <figcaption className="muted small-text">
        <span>{shortDay(days[0].day)}</span>
        <span>
          Best day {shortDay(best.day)}: {rupees(best.salesPaise)}
        </span>
        <span>{shortDay(days[days.length - 1].day)}</span>
      </figcaption>
    </figure>
  );
}

function Stock() {
  const { data, error } = useLoad<StockReport>("/api/reports/stock");
  const v = data?.value;
  return (
    <>
      <Notice>{error}</Notice>
      {data && v && (
        <>
          <div className="stats">
            <Stat label="Pieces in stock" value={v.pieces.toLocaleString("en-IN")} hint={`${v.styles} styles`} />
            <Stat label="Worth at selling price" value={rupees(v.atPricePaise)} hint="MRP, GST included" />
            <Stat label="Worth at cost" value={v.costedPieces ? rupees(v.atCostPaise) : "–"} hint={v.costedPieces < v.pieces ? `Cost entered for ${v.costedPieces} of ${v.pieces} pieces` : "What the shop paid"} />
          </div>
          <div className="report-grid">
            <MiniTable title="By location" head={["", "Pieces", "At price"]} rows={data.byLocation.map((row) => [row.location, row.pieces, rupees(row.atPricePaise)])} />
            <MiniTable title="By category" head={["", "Pieces", "At price"]} rows={data.byCategory.map((row) => [row.category, row.pieces, rupees(row.atPricePaise)])} />
          </div>

          <div className="report-head">
            <h2 className="section-title">Slowest pieces first</h2>
            <CsvButton
              onClick={() =>
                saveCsv(
                  `slow-stock-${indiaDay(new Date())}`,
                  ["Style", "Name", "Category", "Slowness (0-100)", "In stock", "Sizes", "At price (Rs)", "Days on the rail", "Days since last sale", "Sold in 60 days", "Sell-through %", "Days of stock at this pace"],
                  data.slow.map((row) => [row.styleCode, row.name, row.category, row.score, row.onHand, Object.entries(row.sizes).map(([size, n]) => `${size}:${n}`).join(" "), amount(row.atPricePaise), row.daysOnRail, row.daysSinceSale, row.sold60, Math.round(row.sellThrough * 100), row.daysOfCover ?? ""]),
                )
              }
            />
          </div>
          <p className="muted small-text">
            The slowness score: half is how long since the style last sold, three tenths how little of it sold in the last 60 days, a fifth how long it has been on the rail. No cut-off: the list is in order.
          </p>
          {data.slow.length ? (
            <div className="table-scroll">
              <table className="table">
                <thead>
                  <tr>
                    <th>Style</th>
                    <th>Slowness</th>
                    <th className="num">In stock</th>
                    <th className="num">At price</th>
                    <th>Why</th>
                  </tr>
                </thead>
                <tbody>
                  {data.slow.map((row) => (
                    <tr key={row.styleCode}>
                      <td>
                        <strong>{row.styleCode}</strong> <span className="muted">{row.name}</span>
                        {row.status !== "live" && <span className="muted small-text"> · {row.status}</span>}
                      </td>
                      <td>
                        <span className="score-bar" aria-label={`${row.score} of 100`}>
                          <span style={{ width: `${row.score}%` }} />
                        </span>{" "}
                        {row.score}
                      </td>
                      <td className="num">
                        {row.onHand}
                        <div className="muted small-text">{Object.entries(row.sizes).map(([size, n]) => `${size} ${n}`).join(" · ")}</div>
                      </td>
                      <td className="num">{rupees(row.atPricePaise)}</td>
                      <td className="small-text">{row.why.join("; ")}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <p className="muted">No stock on hand.</p>
          )}
        </>
      )}
    </>
  );
}

function Gst() {
  const [month, setMonth] = useState(indiaDay(new Date()).slice(0, 7));
  const { data, error } = useLoad<GstReport>(`/api/reports/gst?month=${month}`);
  const money = (row: GstMoney) => [amount(row.taxablePaise), amount(row.igstPaise), amount(row.cgstPaise), amount(row.sgstPaise)];
  return (
    <>
      <div className="report-bar">
        <label className="report-dates">
          <span className="muted">Month</span>
          <input className="input" type="month" value={month} onChange={(event) => event.target.value && setMonth(event.target.value)} />
        </label>
      </div>
      <Notice>{error}</Notice>
      {data && (
        <>
          <div className="stats">
            <Stat label="Value before GST" value={rupees(data.totals.taxablePaise)} hint={`${data.invoices} invoices, ${data.creditNotes} credit notes`} />
            <Stat label="CGST + SGST" value={rupees(data.totals.cgstPaise + data.totals.sgstPaise)} hint="Sales in the shop's state" />
            <Stat label="IGST" value={rupees(data.totals.igstPaise)} hint="Sent to other states" />
            <Stat label="Invoice value" value={rupees(data.totals.totalPaise)} hint="Credit notes taken off" />
          </div>
          <Notice tone="">This is the summary in the shape of GSTR-1 for the CA to file from. The app does not file returns.</Notice>

          <GstTable
            title="B2C (small): by place of supply and rate"
            note="Table 7 of GSTR-1. Credit notes are netted in."
            head={["Place of supply", "Rate %", "Value before GST", "IGST", "CGST", "SGST"]}
            rows={data.b2cs.map((row) => [`${row.stateCode}-${row.state}`, row.rate, ...money(row)])}
            file={`gstr1-b2cs-${data.month}`}
          />
          {data.b2cl.length > 0 && (
            <GstTable
              title="B2C (large): inter-state invoices above Rs 1 lakh"
              note="Table 5 of GSTR-1, invoice by invoice."
              head={["Invoice", "Date", "Place of supply", "Invoice value", "Value before GST", "IGST"]}
              rows={data.b2cl.map((row) => [row.number, row.date.slice(0, 10), `${row.placeOfSupply.stateCode}-${row.placeOfSupply.state}`, amount(row.totalPaise), amount(row.taxablePaise), amount(row.igstPaise)])}
              file={`gstr1-b2cl-${data.month}`}
            />
          )}
          {data.cdnur.length > 0 && (
            <GstTable
              title="Credit notes against B2C (large) invoices"
              note="Table 9B of GSTR-1 (unregistered)."
              head={["Credit note", "Date", "Against invoice", "Value", "Value before GST", "IGST"]}
              rows={data.cdnur.map((row) => [row.number, row.date.slice(0, 10), row.against, amount(row.totalPaise), amount(row.taxablePaise), amount(row.igstPaise)])}
              file={`gstr1-cdnur-${data.month}`}
            />
          )}
          <GstTable
            title="HSN summary"
            note="Table 12 of GSTR-1 (B2C). Quantity in pieces (PCS)."
            head={["HSN", "Rate %", "Pieces", "Value", "Value before GST", "IGST", "CGST", "SGST"]}
            rows={data.hsn.map((row) => [row.hsn, row.rate, row.qty, amount(row.totalPaise), ...money(row)])}
            file={`gstr1-hsn-${data.month}`}
          />
          <GstTable
            title="Documents issued"
            note="Table 13 of GSTR-1."
            head={["Series", "Kind", "From", "To", "Count", "Gaps"]}
            rows={data.documents.map((doc) => [doc.series, doc.kind === "invoice" ? "Invoices" : "Credit notes", doc.from, doc.to, doc.count, doc.missing])}
            file={`gstr1-docs-${data.month}`}
          />
        </>
      )}
    </>
  );
}

function GstTable({ title, note, head, rows, file }: { title: string; note: string; head: string[]; rows: (string | number)[][]; file: string }) {
  return (
    <>
      <div className="report-head">
        <h2 className="section-title">{title}</h2>
        {rows.length > 0 && <CsvButton onClick={() => saveCsv(file, head, rows)} />}
      </div>
      <p className="muted small-text">{note}</p>
      {rows.length ? (
        <div className="table-scroll">
          <table className="table">
            <thead>
              <tr>
                {head.map((cell, index) => (
                  <th key={cell} className={index > 1 ? "num" : ""}>
                    {cell}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((row, index) => (
                <tr key={index}>
                  {row.map((cell, column) => (
                    <td key={column} className={column > 1 ? "num" : ""}>
                      {cell}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <p className="muted">Nothing this month.</p>
      )}
    </>
  );
}
