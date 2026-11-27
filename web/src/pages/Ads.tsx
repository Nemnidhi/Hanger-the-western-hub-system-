import { useState } from "react";
import { rupees, when } from "../format";
import { Notice, useLoad } from "../ui";

// Meta ads: spend, clicks and Meta's own purchase count per campaign, beside our own sales from that
// campaign (the website link's utm_campaign, or the Click-to-WhatsApp ad she tapped). ROAS is our sales
// divided by spend. Every other source of sales sits below, so the page also works with no ads running.

interface Campaign { id: string; name: string; spendPaise: number; impressions: number; clicks: number; metaPurchases: number; metaValuePaise: number; orders: number; salesPaise: number; roas: number | null; costPerOrderPaise: number | null }
interface Other { source: string; medium: string; campaign: string; orders: number; salesPaise: number }
interface Summary {
  period: { days: number; since: string; until: string };
  connected: boolean;
  error: string;
  pixel: { connected: boolean; test: boolean; sent: number; failed: { number: number; error: string }[] };
  totals: { orders: number; salesPaise: number; spendPaise: number; adSalesPaise: number; roas: number | null };
  campaigns: Campaign[];
  others: Other[];
}

const SOURCE: Record<string, string> = { direct: "Direct", store: "In the store", creator: "Creator code", meta: "Meta", instagram: "Instagram", facebook: "Facebook", google: "Google", whatsapp: "WhatsApp" };
const roasText = (value: number | null) => (value === null ? "–" : `${value.toFixed(2)}×`);
const number = (value: number) => value.toLocaleString("en-IN");

export function Ads() {
  const [days, setDays] = useState(7);
  const loaded = useLoad<Summary>(`/api/ads/summary?days=${days}`);
  const data = loaded.data;
  return (
    <div className="page">
      <div className="report-head">
        <h1>Ads</h1>
        <div className="chips" role="group" aria-label="Period">
          {[1, 7, 14, 30, 90].map((value) => (
            <button key={value} className={`chip${days === value ? " on" : ""}`} onClick={() => setDays(value)}>
              {value === 1 ? "Today" : `${value} days`}
            </button>
          ))}
        </div>
      </div>
      <Notice>{loaded.error}</Notice>
      {data && (
        <>
          {!data.connected && <Notice tone="warn">Meta's ad account is not connected on the server yet (META_AD_ACCOUNT_ID and META_ADS_TOKEN), so spend is not shown. Your own sales by source are below.</Notice>}
          {data.error && <Notice tone="warn">Meta's numbers could not be read just now: {data.error}</Notice>}
          <div className="stats">
            <Stat label="Sales" value={rupees(data.totals.salesPaise)} hint={`${data.totals.orders} orders, every source`} />
            <Stat label="Ad spend" value={data.connected ? rupees(data.totals.spendPaise) : "–"} hint="Meta, this period" />
            <Stat label="Sales from ads" value={rupees(data.totals.adSalesPaise)} hint="Orders we can trace to a Meta campaign" />
            <Stat label="Return on ad spend" value={roasText(data.totals.roas)} hint="Sales from ads / spend" />
          </div>

          <h2 className="section-title">Meta campaigns</h2>
          {data.campaigns.length ? (
            <div className="table-scroll">
              <table className="table">
                <thead>
                  <tr>
                    <th>Campaign</th>
                    <th className="num">Spend</th>
                    <th className="num">Clicks</th>
                    <th className="num">Meta says</th>
                    <th className="num">Our orders</th>
                    <th className="num">Our sales</th>
                    <th className="num">ROAS</th>
                    <th className="num">Per order</th>
                  </tr>
                </thead>
                <tbody>
                  {data.campaigns.map((row) => (
                    <tr key={row.id}>
                      <td>
                        <strong>{row.name || row.id}</strong>
                        <div className="muted small-text">{number(row.impressions)} seen</div>
                      </td>
                      <td className="num">{rupees(row.spendPaise)}</td>
                      <td className="num">{number(row.clicks)}</td>
                      <td className="num">{row.metaPurchases ? `${row.metaPurchases} · ${rupees(row.metaValuePaise)}` : "–"}</td>
                      <td className="num">{row.orders || "–"}</td>
                      <td className="num">{row.salesPaise ? rupees(row.salesPaise) : "–"}</td>
                      <td className={`num${row.roas !== null && row.roas < 1 ? " bad" : ""}`}>{roasText(row.roas)}</td>
                      <td className="num">{row.costPerOrderPaise === null ? "–" : rupees(row.costPerOrderPaise)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <p className="muted">{data.connected ? "No campaign spent anything in this period." : "Connect the ad account to see campaigns here."}</p>
          )}
          <p className="muted small-text">
            "Meta says" is Meta's own count (from the purchases we send it, matched to people who saw or clicked an ad). "Our orders" are the ones that came through a campaign's own link
            or Click-to-WhatsApp ad. Put <code>utm_campaign</code> = the campaign's name (or {"{{campaign.id}}"}) on every ad's website link.
          </p>

          <h2 className="section-title">Other sources</h2>
          {data.others.length ? (
            <div className="table-scroll">
              <table className="table plain">
                <thead>
                  <tr>
                    <th>Source</th>
                    <th>Campaign / code</th>
                    <th className="num">Orders</th>
                    <th className="num">Sales</th>
                  </tr>
                </thead>
                <tbody>
                  {data.others.map((row) => (
                    <tr key={`${row.source}|${row.medium}|${row.campaign}`}>
                      <td>
                        {SOURCE[row.source] || row.source}
                        {row.medium && row.source !== "store" ? <span className="muted"> · {row.medium}</span> : null}
                      </td>
                      <td>{row.campaign || <span className="muted">–</span>}</td>
                      <td className="num">{row.orders}</td>
                      <td className="num">{rupees(row.salesPaise)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <p className="muted">No sales in this period.</p>
          )}

          <h2 className="section-title">Purchases sent to Meta</h2>
          <p className="muted">
            {data.pixel.connected
              ? `${data.pixel.sent} confirmed orders sent to the Conversions API in this period${data.pixel.test ? " (test events only: META_TEST_EVENT_CODE is set)" : ""}. Only hashed phone, name and pincode leave, with the ad click when there is one.`
              : "Not connected: set META_PIXEL_ID and META_ADS_TOKEN on the server to send confirmed orders to Meta, so it learns which ads sell."}
          </p>
          {data.pixel.failed.length > 0 && (
            <Notice tone="warn">
              Meta refused: {data.pixel.failed.map((row) => `order ${row.number} (${row.error})`).join("; ")}
            </Notice>
          )}
          <p className="muted small-text">Period {when(data.period.since)} to {when(data.period.until)}. Meta's numbers are refreshed every 15 minutes.</p>
        </>
      )}
    </div>
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
