import { useEffect, useState } from "react";
import { api } from "../api";
import { rupees, when } from "../format";
import { Dialog, Notice, useLoad, useRun } from "../ui";

// WhatsApp broadcasts: an approved Marketing template to the customers who agreed to offers, chosen by
// what they bought, their size and where they live. The reach is shown before anything is sent.

interface SetupTemplate { name: string; language: string; bodyText: string; paramCount: number; header: string; urlButton: boolean }
interface Setup { templates: SetupTemplate[]; categories: string[]; limits: { minGapDays: number; dailyLimit: number; sendFromHour: number; sendUntilHour: number } }
interface Audience { lastBoughtWithinDays?: number | null; notBoughtForDays?: number | null; neverBought?: boolean; categories?: string[]; sizes?: string[]; minSpend?: number; pincodePrefixes?: string[]; chattedWithinDays?: number | null }
interface Results { messages: { queued: number; sent: number; delivered: number; read: number; failed: number; reached: number }; replies: number; orders: number; salesPaise: number; optedOut: number }
interface Broadcast {
  _id: string;
  name: string;
  template: { name: string; language: string };
  params: string[];
  status: "draft" | "scheduled" | "sending" | "waiting" | "done" | "cancelled";
  scheduledAt: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  counts: { audience: number; queued: number; skipped: number };
  note: string;
  createdBy: string;
  createdAt: string;
  audience: Audience & { minSpendPaise?: number };
  results?: Results;
}

const STATUS: Record<Broadcast["status"], [string, string]> = {
  draft: ["Draft", ""],
  scheduled: ["Scheduled", "accent"],
  sending: ["Sending", "accent"],
  waiting: ["Waiting", "warn"],
  done: ["Sent", "accent"],
  cancelled: ["Stopped", "danger"],
};
const TOKENS = [
  ["{first_name}", "her first name"],
  ["{size}", "her usual size"],
  ["{brand}", "the shop's name"],
];
const pct = (part: number, whole: number) => (whole ? `${Math.round((part / whole) * 100)}%` : "–");

export function Broadcasts() {
  const list = useLoad<{ broadcasts: Broadcast[] }>("/api/broadcasts");
  const [creating, setCreating] = useState(false);
  const [open, setOpen] = useState<string | null>(null);
  const items = list.data?.broadcasts || [];

  return (
    <div className="page">
      <div className="report-head">
        <h1>WhatsApp broadcasts</h1>
        <button className="btn primary" onClick={() => setCreating(true)}>
          New broadcast
        </button>
      </div>
      <p className="muted small-text">
        Only customers who said yes to offers get them (at the counter, in the trial room, or by tapping Yes in the chat). Anyone can reply STOP to stop them.
      </p>
      <Notice>{list.error}</Notice>
      {items.length ? (
        <div className="table-scroll">
          <table className="table">
            <thead>
              <tr>
                <th>Broadcast</th>
                <th>Status</th>
                <th className="num">Customers</th>
                <th className="num">Delivered</th>
                <th className="num">Read</th>
                <th className="num">Replies</th>
                <th className="num">Orders in 7 days</th>
              </tr>
            </thead>
            <tbody>
              {items.map((item) => {
                const r = item.status === "draft" ? undefined : item.results;
                const [label, tone] = STATUS[item.status];
                return (
                  <tr key={item._id} className="clickable" onClick={() => setOpen(item._id)}>
                    <td>
                      <strong>{item.name}</strong>
                      <div className="muted small-text">
                        {item.template.name} · {when(item.startedAt || item.scheduledAt || item.createdAt)}
                      </div>
                    </td>
                    <td>
                      <span className={`badge ${tone}`}>{label}</span>
                    </td>
                    <td className="num">{item.counts.audience || "–"}</td>
                    <td className="num">{r ? `${r.messages.reached} (${pct(r.messages.reached, item.counts.queued)})` : ""}</td>
                    <td className="num">{r ? `${r.messages.read} (${pct(r.messages.read, item.counts.queued)})` : ""}</td>
                    <td className="num">{r?.replies || ""}</td>
                    <td className="num">{r?.orders ? `${r.orders} · ${rupees(r.salesPaise)}` : ""}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      ) : (
        list.data && <p className="muted">No broadcasts yet.</p>
      )}
      {creating && (
        <NewBroadcast
          onClose={() => setCreating(false)}
          onSaved={(id) => {
            setCreating(false);
            list.reload();
            setOpen(id);
          }}
        />
      )}
      {open && <BroadcastView id={open} onClose={() => setOpen(null)} onChanged={list.reload} />}
    </div>
  );
}

function NewBroadcast({ onClose, onSaved }: { onClose: () => void; onSaved: (id: string) => void }) {
  const setup = useLoad<Setup>("/api/broadcasts/setup");
  const { busy, error, run } = useRun();
  const [name, setName] = useState("");
  const [templateKey, setTemplateKey] = useState("");
  const [params, setParams] = useState<string[]>([]);
  const [headerImageUrl, setHeaderImageUrl] = useState("");
  const [urlSuffix, setUrlSuffix] = useState("");
  const [audience, setAudience] = useState<Audience>({});
  const [sizesText, setSizesText] = useState("");
  const [pinText, setPinText] = useState("");
  const [reach, setReach] = useState<{ counts: { customers: number; agreed: number; matching: number; heldBack: number; reach: number }; gapDays: number; sample: string[] } | null>(null);
  const templates = setup.data?.templates || [];
  const template = templates.find((item) => `${item.name}|${item.language}` === templateKey);

  const fullAudience: Audience = {
    ...audience,
    sizes: sizesText.split(/[\s,]+/).filter(Boolean),
    pincodePrefixes: pinText.split(/[\s,]+/).filter((pin) => /^\d{2,6}$/.test(pin)),
  };
  const audienceKey = JSON.stringify(fullAudience);
  useEffect(() => {
    const timer = setTimeout(() => {
      api<typeof reach>("/api/broadcasts/audience", { method: "POST", body: { audience: JSON.parse(audienceKey) } })
        .then(setReach)
        .catch(() => setReach(null));
    }, 350);
    return () => clearTimeout(timer);
  }, [audienceKey]);

  function pickTemplate(key: string) {
    setTemplateKey(key);
    const chosen = templates.find((item) => `${item.name}|${item.language}` === key);
    setParams(Array.from({ length: chosen?.paramCount || 0 }, (_, index) => (index === 0 ? "{first_name}" : "")));
  }
  const num = (value: string) => (value ? Math.max(1, Math.floor(Number(value))) : null);
  const toggleCategory = (category: string) => {
    const now = audience.categories || [];
    setAudience({ ...audience, categories: now.includes(category) ? now.filter((item) => item !== category) : [...now, category] });
  };
  const preview = template ? template.bodyText.replace(/\{\{(\d+)\}\}/g, (all, n) => (params[Number(n) - 1] || all).replace("{first_name}", "Priya").replace("{size}", "M").replace("{brand}", "The Hanger")) : "";

  async function save() {
    const saved = await run(() =>
      api<{ broadcast: Broadcast }>("/api/broadcasts", {
        method: "POST",
        body: { name: name.trim(), template: template ? { name: template.name, language: template.language } : undefined, params, headerImageUrl: headerImageUrl.trim(), urlSuffix: urlSuffix.trim(), audience: fullAudience },
      }),
    );
    if (saved) onSaved(saved.broadcast._id);
  }

  return (
    <Dialog title="New broadcast" onClose={onClose} wide>
      <Notice>{setup.error}</Notice>
      {setup.data && !templates.length && (
        <Notice tone="warn">
          No approved Marketing template yet. Create one in WhatsApp Manager (for example "New arrivals: Hi {"{{1}}"}, ..."), wait for approval, then refresh on the <a href="#templates">Templates</a> page.
        </Notice>
      )}
      <div className="form-grid two">
        <div className="field">
          <label htmlFor="b-name">Name (for you)</label>
          <input id="b-name" className="input" value={name} onChange={(event) => setName(event.target.value)} placeholder="Winter drop, week 1" maxLength={80} />
        </div>
        <div className="field">
          <label htmlFor="b-template">Template</label>
          <select id="b-template" className="input" value={templateKey} onChange={(event) => pickTemplate(event.target.value)}>
            <option value="">Choose…</option>
            {templates.map((item) => (
              <option key={`${item.name}|${item.language}`} value={`${item.name}|${item.language}`}>
                {item.name} ({item.language})
              </option>
            ))}
          </select>
        </div>
      </div>

      {template && (
        <>
          <p className="template-body">{template.bodyText}</p>
          <div className="form-grid two">
            {params.map((value, index) => (
              <div className="field" key={index}>
                <label htmlFor={`b-p${index}`}>Blank {`{{${index + 1}}}`}</label>
                <input id={`b-p${index}`} className="input" value={value} maxLength={500} onChange={(event) => setParams(params.map((item, at) => (at === index ? event.target.value : item)))} />
              </div>
            ))}
            {template.header === "IMAGE" && (
              <div className="field span-3">
                <label htmlFor="b-img">Photo at the top (a web address starting https://)</label>
                <input id="b-img" className="input" value={headerImageUrl} onChange={(event) => setHeaderImageUrl(event.target.value)} placeholder="https://www.thehanger.in/images/winter-drop.jpg" />
              </div>
            )}
            {template.urlButton && (
              <div className="field span-3">
                <label htmlFor="b-url">End of the button's link</label>
                <input id="b-url" className="input" value={urlSuffix} onChange={(event) => setUrlSuffix(event.target.value)} placeholder="new-arrivals" />
              </div>
            )}
          </div>
          {params.length > 0 && (
            <p className="muted small-text">
              Filled for each customer: {TOKENS.map(([token, meaning]) => `${token} (${meaning})`).join(", ")}.
            </p>
          )}
          <div className="bubble-preview" aria-label="How it reads">
            {preview}
          </div>
        </>
      )}

      <h3 className="section-title">Who gets it</h3>
      {(setup.data?.categories || []).length > 0 && (
        <>
          <div className="muted small-text">Bought from (any of these; none chosen = everyone)</div>
          <div className="chips">
            {(setup.data?.categories || []).map((category) => (
              <button key={category} className={`chip${audience.categories?.includes(category) ? " on" : ""}`} onClick={() => toggleCategory(category)}>
                {category}
              </button>
            ))}
          </div>
        </>
      )}
      <div className="form-grid">
        <div className="field">
          <label htmlFor="a-within">Bought in the last … days</label>
          <input id="a-within" className="input" type="number" min={1} value={audience.lastBoughtWithinDays ?? ""} onChange={(event) => setAudience({ ...audience, lastBoughtWithinDays: num(event.target.value) })} />
        </div>
        <div className="field">
          <label htmlFor="a-lapsed">Not bought for … days (win back)</label>
          <input id="a-lapsed" className="input" type="number" min={1} value={audience.notBoughtForDays ?? ""} onChange={(event) => setAudience({ ...audience, notBoughtForDays: num(event.target.value) })} />
        </div>
        <div className="field">
          <label htmlFor="a-spend">Spent at least (Rs)</label>
          <input id="a-spend" className="input" type="number" min={0} value={audience.minSpend || ""} onChange={(event) => setAudience({ ...audience, minSpend: Number(event.target.value) || 0 })} />
        </div>
        <div className="field">
          <label htmlFor="a-sizes">Usual size (e.g. S, M)</label>
          <input id="a-sizes" className="input" value={sizesText} onChange={(event) => setSizesText(event.target.value)} />
        </div>
        <div className="field">
          <label htmlFor="a-pin">Pincode starts with (e.g. 452)</label>
          <input id="a-pin" className="input" value={pinText} onChange={(event) => setPinText(event.target.value)} />
        </div>
        <div className="field">
          <label htmlFor="a-chat">Chatted in the last … days</label>
          <input id="a-chat" className="input" type="number" min={1} value={audience.chattedWithinDays ?? ""} onChange={(event) => setAudience({ ...audience, chattedWithinDays: num(event.target.value) })} />
        </div>
        <label className="check span-3">
          <input type="checkbox" checked={Boolean(audience.neverBought)} onChange={(event) => setAudience({ ...audience, neverBought: event.target.checked })} /> Only customers who have not bought yet
        </label>
      </div>
      {reach && (
        <div className="reach">
          <strong>{reach.counts.reach} customers</strong> will get it
          <span className="muted small-text">
            {" "}
            · {reach.counts.agreed} of {reach.counts.customers} said yes to offers · {reach.counts.matching} match
            {reach.counts.heldBack ? ` · ${reach.counts.heldBack} held back (an offer in the last ${reach.gapDays} days)` : ""}
            {reach.sample.length ? ` · e.g. ${reach.sample.join(", ")}` : ""}
          </span>
        </div>
      )}
      <Notice>{error}</Notice>
      <div className="row-actions">
        <button className="btn primary" disabled={busy || !template || name.trim().length < 2} onClick={save}>
          {busy ? "Saving…" : "Save, then choose when to send"}
        </button>
        <button className="btn" onClick={onClose}>
          Cancel
        </button>
      </div>
    </Dialog>
  );
}

function BroadcastView({ id, onClose, onChanged }: { id: string; onClose: () => void; onChanged: () => void }) {
  const detail = useLoad<{ broadcast: Broadcast; results: Results; preview: string }>(`/api/broadcasts/${id}`);
  const { busy, error, run } = useRun();
  const [confirming, setConfirming] = useState(false);
  const [later, setLater] = useState("");
  const [reach, setReach] = useState<number | null>(null);
  const b = detail.data?.broadcast;
  const r = detail.data?.results;

  useEffect(() => {
    if (b?.status !== "draft") return;
    const { minSpendPaise, ...rest } = b.audience;
    api<{ counts: { reach: number } }>("/api/broadcasts/audience", { method: "POST", body: { audience: { ...rest, minSpend: (minSpendPaise || 0) / 100 } } })
      .then((result) => setReach(result.counts.reach))
      .catch(() => setReach(null));
  }, [b]);

  async function act(path: string, body: unknown = {}) {
    const done = await run(() => api(path, { method: "POST", body }));
    if (done !== undefined) {
      setConfirming(false);
      detail.reload();
      onChanged();
    }
  }
  async function remove() {
    const done = await run(() => api(`/api/broadcasts/${id}`, { method: "DELETE" }));
    if (done !== undefined) {
      onChanged();
      onClose();
    }
  }

  return (
    <Dialog title={b?.name || "Broadcast"} onClose={onClose} wide>
      <Notice>{detail.error}</Notice>
      {b && r && (
        <>
          <p className="muted small-text">
            {b.template.name} · made by {b.createdBy} · <span className={`badge ${STATUS[b.status][1]}`}>{STATUS[b.status][0]}</span>
            {b.scheduledAt && b.status === "scheduled" ? ` for ${when(b.scheduledAt)}` : ""}
          </p>
          {b.note && <Notice tone="warn">{b.note}</Notice>}
          <div className="bubble-preview">{detail.data?.preview}</div>
          {b.status !== "draft" && (
            <div className="stats">
              <div className="stat">
                <div className="muted">Customers</div>
                <div className="stat-value">{b.counts.audience}</div>
                {b.counts.skipped > 0 && <div className="muted small-text">{b.counts.skipped} said STOP before it reached them</div>}
              </div>
              <div className="stat">
                <div className="muted">Delivered</div>
                <div className="stat-value">{r.messages.reached}</div>
                <div className="muted small-text">
                  {r.messages.read} read · {r.messages.failed} failed · {r.messages.queued} waiting
                </div>
              </div>
              <div className="stat">
                <div className="muted">Replies in 3 days</div>
                <div className="stat-value">{r.replies}</div>
                {r.optedOut > 0 && <div className="muted small-text">{r.optedOut} said STOP</div>}
              </div>
              <div className="stat">
                <div className="muted">Orders in 7 days</div>
                <div className="stat-value">{r.orders}</div>
                <div className="muted small-text">{rupees(r.salesPaise)} (store bills matched by phone)</div>
              </div>
            </div>
          )}
          <Notice>{error}</Notice>
          {b.status === "draft" && (
            <>
              {!confirming ? (
                <div className="row-actions">
                  <button className="btn primary" onClick={() => setConfirming(true)}>
                    Send…
                  </button>
                  <button className="btn" disabled={busy} onClick={remove}>
                    Delete draft
                  </button>
                </div>
              ) : (
                <div className="confirm-box">
                  <p>
                    Send to about <strong>{reach ?? "…"} customers</strong>? It goes out in small batches inside your sending hours (Settings). It cannot be taken back once a message has gone.
                  </p>
                  <div className="row-actions">
                    <button className="btn primary" disabled={busy} onClick={() => act(`/api/broadcasts/${id}/send`)}>
                      Send now
                    </button>
                    <input className="input" type="datetime-local" value={later} onChange={(event) => setLater(event.target.value)} aria-label="Send later at" style={{ width: "auto" }} />
                    <button className="btn" disabled={busy || !later} onClick={() => act(`/api/broadcasts/${id}/send`, { scheduledAt: new Date(later).toISOString() })}>
                      Schedule
                    </button>
                    <button className="btn" onClick={() => setConfirming(false)}>
                      Back
                    </button>
                  </div>
                </div>
              )}
            </>
          )}
          {["scheduled", "sending", "waiting"].includes(b.status) && (
            <div className="row-actions">
              <button className="btn" disabled={busy} onClick={() => act(`/api/broadcasts/${id}/cancel`)}>
                Stop sending
              </button>
              <span className="muted small-text">Messages already sent stay sent.</span>
            </div>
          )}
        </>
      )}
    </Dialog>
  );
}
