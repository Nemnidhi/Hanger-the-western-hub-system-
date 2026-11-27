import { useEffect, useState } from "react";
import { api, can, type Me } from "../api";
import { dateOnly, phone, rupees, when } from "../format";
import { Dialog, Notice, toPaise, useLoad, useRun } from "../ui";
import type { Settings } from "../types";

// Customers: one record per person across WhatsApp, the website and the counter (matched by phone),
// with her sizes, what she bought and sent back, her consents, points and tier. Creators and their
// codes have a tab of their own.

interface Tier { name: string; minSpendPaise: number; multiplier: number; perk: string }
interface TierNow { name: string; multiplier: number; perk: string; next: { name: string; needPaise: number } | null }
interface Row { _id: string; name: string; waId: string; usualSize: string; points: number; tier: string; offers: boolean; lastInboundAt: string | null; updatedAt: string }
interface Contact {
  _id: string;
  waId: string;
  name: string;
  profileName: string;
  firstSeenAt: string;
  consents: { offers: { given: boolean; at: string | null; source: string }; orderUpdates: { given: boolean } };
  fit: { usualSize: string; waist: string; notes: string };
  birthday: { day: number | null; month: number | null };
  notes: string;
  loyalty: { points: number; tier: string; referralCode?: string; joinedAt: string | null };
}
interface Line { skuCode: string; name: string; size: string; qty: number; returnedQty?: number; unitPaise: number; listUnitPaise?: number }
interface Profile {
  customer: Contact;
  stats: { orders: number; lifetimePaise: number; yearPaise: number; lastOrderAt: string | null; piecesReturned: number; referred: number };
  tier: TierNow;
  fitNotes: string[];
  orders: { _id: string; number: number; channel: string; status: string; createdAt: string; totalPaise: number; lines: Line[]; discount?: { code: string; kind: string; pointsUsed: number } }[];
  returns: { _id: string; number: number; orderNumber: number; at: string; lines: { skuCode: string; qty: number; reason: string }[]; refund: { method: string; amountPaise: number } }[];
  points: { _id: string; kind: string; points: number; note: string; at: string; by: string }[];
}
interface Statement { month: string; orders: number; netSalesPaise: number; commissionPaise: number; tdsPaise: number; payablePaise: number; lines: { orderId: string; number: number; invoice: string; customer: string; netPaise: number }[]; payout: { paidPaise: number; reference: string; paidAt: string } | null }
interface Creator { _id: string; name: string; code: string; phone: string; instagram: string; upi: string; discountPct: number; commissionPct: number; tdsPct: number; active: boolean; notes: string; statement: Statement }

const CHANNEL: Record<string, string> = { whatsapp: "WhatsApp", website: "Website", store: "Counter" };
const KIND: Record<string, string> = { earn: "Earned", redeem: "Paid with", reverse: "Return", referral: "Friend's first bill", adjust: "By hand" };
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const thisMonth = () => new Date(Date.now() + 330 * 60_000).toISOString().slice(0, 7);

export function Customers({ me }: { me: Me }) {
  const [tab, setTab] = useState<"customers" | "creators">("customers");
  return (
    <div className="page">
      <div className="report-head">
        <h1>Customers</h1>
        <div className="chips" role="tablist">
          <button className={`chip ${tab === "customers" ? "on" : ""}`} onClick={() => setTab("customers")} role="tab" aria-selected={tab === "customers"}>
            Members
          </button>
          {can(me, "broadcasts:send") && (
            <button className={`chip ${tab === "creators" ? "on" : ""}`} onClick={() => setTab("creators")} role="tab" aria-selected={tab === "creators"}>
              Creator codes
            </button>
          )}
        </div>
      </div>
      {tab === "customers" ? <Members me={me} /> : <Creators me={me} />}
    </div>
  );
}

function Members({ me }: { me: Me }) {
  const [q, setQ] = useState("");
  const [sort, setSort] = useState<"recent" | "points">("recent");
  const [query, setQuery] = useState("");
  useEffect(() => {
    const timer = setTimeout(() => setQuery(q.trim()), 250);
    return () => clearTimeout(timer);
  }, [q]);
  const list = useLoad<{ customers: Row[]; tiers: Tier[] }>(`/api/customers?q=${encodeURIComponent(query)}&sort=${sort}`);
  const [open, setOpen] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const rows = list.data?.customers || [];

  return (
    <>
      <div className="report-bar">
        <input className="input" placeholder="Name, mobile or referral code" value={q} onChange={(event) => setQ(event.target.value)} aria-label="Search customers" />
        <select className="input auto" value={sort} onChange={(event) => setSort(event.target.value as "recent" | "points")} aria-label="Sort">
          <option value="recent">Recently active</option>
          <option value="points">Most points</option>
        </select>
        <span className="spacer" />
        {can(me, "orders:write") && (
          <button className="btn" onClick={() => setAdding(true)}>
            Add customer
          </button>
        )}
      </div>
      {list.data?.tiers?.length ? (
        <p className="muted small-text">
          Tiers by spend kept over 12 months: {list.data.tiers.map((tier) => `${tier.name} from ${rupees(tier.minSpendPaise)} (${tier.multiplier}x)`).join(" · ")}
        </p>
      ) : null}
      <Notice>{list.error}</Notice>
      {rows.length ? (
        <div className="table-scroll">
          <table className="table">
            <thead>
              <tr>
                <th>Customer</th>
                <th>Size</th>
                <th>Tier</th>
                <th className="num">Points</th>
                <th>Offers</th>
                <th>Last active</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row._id} className="clickable" onClick={() => setOpen(row._id)}>
                  <td>
                    <strong>{row.name || "No name yet"}</strong>
                    <div className="muted small-text">{phone(row.waId)}</div>
                  </td>
                  <td>{row.usualSize || "–"}</td>
                  <td>{row.tier ? <span className="badge accent">{row.tier}</span> : <span className="muted">not yet</span>}</td>
                  <td className="num">{row.points || ""}</td>
                  <td>{row.offers ? <span className="badge">yes</span> : <span className="muted">no</span>}</td>
                  <td>{when(row.lastInboundAt || row.updatedAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        list.data && <p className="muted">{query ? "Nobody matches." : "No customers yet."}</p>
      )}
      {open && <CustomerView id={open} me={me} onClose={() => setOpen(null)} onChanged={list.reload} />}
      {adding && (
        <AddCustomer
          onClose={() => setAdding(false)}
          onAdded={(id) => {
            setAdding(false);
            list.reload();
            setOpen(id);
          }}
        />
      )}
    </>
  );
}

function AddCustomer({ onClose, onAdded }: { onClose: () => void; onAdded: (id: string) => void }) {
  const [form, setForm] = useState({ phone: "", name: "" });
  const { busy, error, run } = useRun();
  const save = () =>
    run(async () => {
      const result = await api<{ customer: Contact }>("/api/customers", { method: "POST", body: { phone: form.phone, name: form.name.trim() } });
      onAdded(result.customer._id);
    });
  return (
    <Dialog title="Add a customer" onClose={onClose}>
      <form onSubmit={(event) => (event.preventDefault(), save())}>
        <div className="form-grid two">
          <div className="field">
            <label htmlFor="nc-phone">Mobile</label>
            <input id="nc-phone" className="input" inputMode="tel" autoFocus value={form.phone} onChange={(event) => setForm({ ...form, phone: event.target.value })} />
          </div>
          <div className="field">
            <label htmlFor="nc-name">Name</label>
            <input id="nc-name" className="input" value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} />
          </div>
        </div>
        <p className="muted small-text">If she is already a customer, her record opens.</p>
        <Notice>{error}</Notice>
        <div className="row-actions">
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn primary" disabled={busy || form.phone.replace(/\D/g, "").length < 10}>
            Add
          </button>
        </div>
      </form>
    </Dialog>
  );
}

function CustomerView({ id, me, onClose, onChanged }: { id: string; me: Me; onClose: () => void; onChanged: () => void }) {
  const loaded = useLoad<Profile>(`/api/customers/${id}`);
  const [editing, setEditing] = useState(false);
  const [adjusting, setAdjusting] = useState(false);
  const profile = loaded.data;
  const c = profile?.customer;
  const reload = () => {
    loaded.reload();
    onChanged();
  };

  return (
    <Dialog title={c ? c.name || c.profileName || phone(c.waId) : "Customer"} onClose={onClose} wide>
      <Notice>{loaded.error}</Notice>
      {profile && c && (
        <>
          <div className="stats">
            <div className="stat">
              <span className="muted small-text">Tier</span>
              <strong>{profile.tier.name}</strong>
              <span className="muted small-text">{profile.tier.next ? `${rupees(profile.tier.next.needPaise)} more to ${profile.tier.next.name}` : "top tier"}</span>
            </div>
            <div className="stat">
              <span className="muted small-text">Points</span>
              <strong>{c.loyalty.points}</strong>
              <span className="muted small-text">{c.loyalty.referralCode ? `her code ${c.loyalty.referralCode}` : "code after the first bill"}</span>
            </div>
            <div className="stat">
              <span className="muted small-text">Kept, 12 months</span>
              <strong>{rupees(profile.stats.yearPaise)}</strong>
              <span className="muted small-text">{rupees(profile.stats.lifetimePaise)} in all</span>
            </div>
            <div className="stat">
              <span className="muted small-text">Orders</span>
              <strong>{profile.stats.orders}</strong>
              <span className="muted small-text">
                {profile.stats.piecesReturned} pieces back{profile.stats.referred ? ` · ${profile.stats.referred} friends brought` : ""}
              </span>
            </div>
          </div>
          <p className="muted small-text">
            {phone(c.waId)} · first seen {dateOnly(c.firstSeenAt)} · size {c.fit.usualSize || "not known"}
            {c.fit.waist ? `, waist ${c.fit.waist}` : ""}
            {c.birthday?.day && c.birthday?.month ? ` · birthday ${c.birthday.day} ${MONTHS[c.birthday.month - 1]}` : ""} · offers on WhatsApp: {c.consents.offers.given ? `yes (${c.consents.offers.source || "chat"})` : "no"}
          </p>
          {c.fit.notes && <p>Fit: {c.fit.notes}</p>}
          {profile.fitNotes.length > 0 && <Notice tone="warn">From her returns: {profile.fitNotes.join("; ")}.</Notice>}
          {c.notes && <p className="muted">Notes: {c.notes}</p>}
          <div className="row-actions">
            {can(me, "orders:write") && (
              <button className="btn" onClick={() => setEditing(true)}>
                Edit details
              </button>
            )}
            {can(me, "settings:write") && (
              <button className="btn" onClick={() => setAdjusting(true)}>
                Add or remove points
              </button>
            )}
            <span className="spacer" />
            <button className="btn" onClick={onClose}>
              Close
            </button>
          </div>

          <h3>Orders and bills</h3>
          {profile.orders.length ? (
            <div className="table-scroll">
              <table className="table plain">
                <tbody>
                  {profile.orders.map((order) => (
                    <tr key={order._id}>
                      <td>
                        #{order.number} <span className="muted small-text">{CHANNEL[order.channel] || order.channel}</span>
                      </td>
                      <td>{dateOnly(order.createdAt)}</td>
                      <td>
                        {order.lines.map((line) => `${line.qty - (line.returnedQty || 0)}${line.returnedQty ? ` (+${line.returnedQty} back)` : ""} x ${line.name} ${line.size}`).join(", ")}
                        {order.discount?.code ? <span className="muted small-text"> · code {order.discount.code}</span> : null}
                        {order.discount?.pointsUsed ? <span className="muted small-text"> · {order.discount.pointsUsed} points</span> : null}
                      </td>
                      <td>{order.status}</td>
                      <td className="num">{rupees(order.totalPaise)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <p className="muted">No orders yet.</p>
          )}

          {profile.points.length > 0 && (
            <>
              <h3>Points</h3>
              <div className="table-scroll">
                <table className="table plain">
                  <tbody>
                    {profile.points.map((entry) => (
                      <tr key={entry._id}>
                        <td>{dateOnly(entry.at)}</td>
                        <td>{KIND[entry.kind] || entry.kind}</td>
                        <td className="muted">{entry.note}</td>
                        <td className="num">{entry.points > 0 ? `+${entry.points}` : entry.points}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}
          {editing && (
            <EditCustomer
              contact={c}
              onClose={() => setEditing(false)}
              onSaved={() => {
                setEditing(false);
                reload();
              }}
            />
          )}
          {adjusting && (
            <AdjustPoints
              id={c._id}
              onClose={() => setAdjusting(false)}
              onSaved={() => {
                setAdjusting(false);
                reload();
              }}
            />
          )}
        </>
      )}
    </Dialog>
  );
}

function EditCustomer({ contact, onClose, onSaved }: { contact: Contact; onClose: () => void; onSaved: () => void }) {
  const [form, setForm] = useState({
    name: contact.name || "",
    usualSize: contact.fit.usualSize || "",
    waist: contact.fit.waist || "",
    fitNotes: contact.fit.notes || "",
    day: contact.birthday?.day ? String(contact.birthday.day) : "",
    month: contact.birthday?.month ? String(contact.birthday.month) : "",
    notes: contact.notes || "",
    offers: Boolean(contact.consents.offers.given),
  });
  const { busy, error, run } = useRun();
  const set = (key: keyof typeof form) => (event: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) =>
    setForm({ ...form, [key]: event.target.type === "checkbox" ? (event.target as HTMLInputElement).checked : event.target.value });
  const save = () =>
    run(async () => {
      const birthday = form.day && form.month ? { day: Number(form.day), month: Number(form.month) } : { day: null, month: null };
      await api(`/api/customers/${contact._id}`, { method: "PATCH", body: { name: form.name.trim(), fit: { usualSize: form.usualSize.trim(), waist: form.waist.trim(), notes: form.fitNotes }, birthday, notes: form.notes, offers: form.offers } });
      onSaved();
    });
  return (
    <Dialog title="Her details" onClose={onClose}>
      <form onSubmit={(event) => (event.preventDefault(), save())}>
        <div className="form-grid two">
          <div className="field">
            <label htmlFor="ec-name">Name</label>
            <input id="ec-name" className="input" value={form.name} onChange={set("name")} />
          </div>
          <div className="field">
            <label htmlFor="ec-size">Usual size</label>
            <input id="ec-size" className="input" value={form.usualSize} onChange={set("usualSize")} placeholder="M" />
          </div>
          <div className="field">
            <label htmlFor="ec-waist">Waist (jeans)</label>
            <input id="ec-waist" className="input" inputMode="numeric" value={form.waist} onChange={set("waist")} placeholder="28" />
          </div>
          <div className="field">
            <label>Birthday</label>
            <div className="field-row">
              <input className="input" inputMode="numeric" placeholder="Day" value={form.day} onChange={set("day")} aria-label="Birthday day" />
              <select className="input" value={form.month} onChange={set("month")} aria-label="Birthday month">
                <option value="">Month</option>
                {MONTHS.map((label, index) => (
                  <option key={label} value={index + 1}>
                    {label}
                  </option>
                ))}
              </select>
            </div>
          </div>
          <div className="field span-2">
            <label htmlFor="ec-fit">Fit notes, in her words</label>
            <input id="ec-fit" className="input" value={form.fitNotes} onChange={set("fitNotes")} maxLength={300} />
          </div>
          <div className="field span-2">
            <label htmlFor="ec-notes">Notes for staff</label>
            <textarea id="ec-notes" className="input" rows={2} value={form.notes} onChange={set("notes")} maxLength={500} />
          </div>
        </div>
        <label className="check">
          <input type="checkbox" checked={form.offers} onChange={set("offers")} /> She said yes to offers and new drops on WhatsApp (ask her; record only her own answer)
        </label>
        <Notice>{error}</Notice>
        <div className="row-actions">
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn primary" disabled={busy}>
            Save
          </button>
        </div>
      </form>
    </Dialog>
  );
}

function AdjustPoints({ id, onClose, onSaved }: { id: string; onClose: () => void; onSaved: () => void }) {
  const [form, setForm] = useState({ points: "", note: "" });
  const { busy, error, run } = useRun();
  const save = () =>
    run(async () => {
      await api(`/api/customers/${id}/points`, { method: "POST", body: { points: Number(form.points), note: form.note.trim() } });
      onSaved();
    });
  return (
    <Dialog title="Add or remove points" onClose={onClose}>
      <form onSubmit={(event) => (event.preventDefault(), save())}>
        <div className="form-grid two">
          <div className="field">
            <label htmlFor="ap-points">Points (minus to remove)</label>
            <input id="ap-points" className="input" inputMode="numeric" autoFocus value={form.points} onChange={(event) => setForm({ ...form, points: event.target.value })} placeholder="100" />
          </div>
          <div className="field">
            <label htmlFor="ap-note">Why</label>
            <input id="ap-note" className="input" value={form.note} onChange={(event) => setForm({ ...form, note: event.target.value })} placeholder="birthday gift" />
          </div>
        </div>
        <Notice>{error}</Notice>
        <div className="row-actions">
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn primary" disabled={busy || !Number(form.points) || form.note.trim().length < 3}>
            Save
          </button>
        </div>
      </form>
    </Dialog>
  );
}

// ---- Creators ----------------------------------------------------------------------------------

function Creators({ me }: { me: Me }) {
  const [month, setMonth] = useState(thisMonth);
  const list = useLoad<{ month: string; creators: Creator[] }>(`/api/creators?month=${month}`);
  const [editing, setEditing] = useState<Creator | "new" | null>(null);
  const [open, setOpen] = useState<Creator | null>(null);
  const creators = list.data?.creators || [];
  const total = creators.reduce((sum, creator) => sum + creator.statement.payablePaise, 0);

  return (
    <>
      <p className="muted small-text">
        A creator's followers get her discount on the bill; she earns her commission on what they keep (value before GST, less returns), paid monthly. Codes work at the counter and online.
      </p>
      <div className="report-bar">
        <input className="input auto" type="month" value={month} max={thisMonth()} onChange={(event) => event.target.value && setMonth(event.target.value)} aria-label="Month" />
        <span className="muted">{creators.length ? `${rupees(total)} payable this month` : ""}</span>
        <span className="spacer" />
        <button className="btn primary" onClick={() => setEditing("new")}>
          New creator
        </button>
      </div>
      <Notice>{list.error}</Notice>
      {creators.length ? (
        <div className="table-scroll">
          <table className="table">
            <thead>
              <tr>
                <th>Creator</th>
                <th>Code</th>
                <th className="num">Off / commission</th>
                <th className="num">Bills</th>
                <th className="num">Net sales</th>
                <th className="num">Payable</th>
                <th>Paid</th>
              </tr>
            </thead>
            <tbody>
              {creators.map((creator) => (
                <tr key={creator._id} className="clickable" onClick={() => setOpen(creator)}>
                  <td>
                    <strong>{creator.name}</strong>
                    {!creator.active && <span className="badge danger"> paused</span>}
                    <div className="muted small-text">{creator.instagram ? `@${creator.instagram.replace(/^@/, "")}` : creator.phone}</div>
                  </td>
                  <td>
                    <code>{creator.code}</code>
                  </td>
                  <td className="num">
                    {creator.discountPct}% / {creator.commissionPct}%
                  </td>
                  <td className="num">{creator.statement.orders || ""}</td>
                  <td className="num">{creator.statement.netSalesPaise ? rupees(creator.statement.netSalesPaise) : ""}</td>
                  <td className="num">{creator.statement.payablePaise ? rupees(creator.statement.payablePaise) : ""}</td>
                  <td>{creator.statement.payout ? <span className="badge accent">paid</span> : creator.statement.payablePaise > 0 ? <span className="badge warn">due</span> : ""}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        list.data && <p className="muted">No creators yet.</p>
      )}
      {editing && (
        <CreatorForm
          creator={editing === "new" ? null : editing}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            setOpen(null);
            list.reload();
          }}
        />
      )}
      {open && (
        <CreatorView
          creator={open}
          canPay={can(me, "settings:write")}
          onEdit={() => setEditing(open)}
          onClose={() => setOpen(null)}
          onPaid={() => {
            setOpen(null);
            list.reload();
          }}
        />
      )}
    </>
  );
}

function CreatorForm({ creator, onClose, onSaved }: { creator: Creator | null; onClose: () => void; onSaved: () => void }) {
  const [form, setForm] = useState({
    name: creator?.name || "",
    code: creator?.code || "",
    phone: creator?.phone || "",
    instagram: creator?.instagram || "",
    upi: creator?.upi || "",
    discountPct: String(creator?.discountPct ?? 10),
    commissionPct: String(creator?.commissionPct ?? 10),
    tdsPct: String(creator?.tdsPct ?? 0),
    active: creator?.active ?? true,
    notes: creator?.notes || "",
  });
  const { busy, error, run } = useRun();
  const set = (key: keyof typeof form) => (event: React.ChangeEvent<HTMLInputElement>) => setForm({ ...form, [key]: event.target.type === "checkbox" ? event.target.checked : event.target.value });
  const save = () =>
    run(async () => {
      const body = { name: form.name.trim(), phone: form.phone.trim(), instagram: form.instagram.trim(), upi: form.upi.trim(), discountPct: Number(form.discountPct), commissionPct: Number(form.commissionPct), tdsPct: Number(form.tdsPct), active: form.active, notes: form.notes };
      if (creator) await api(`/api/creators/${creator._id}`, { method: "PATCH", body });
      else await api("/api/creators", { method: "POST", body: { ...body, code: form.code.trim() } });
      onSaved();
    });
  return (
    <Dialog title={creator ? `Edit ${creator.name}` : "New creator"} onClose={onClose}>
      <form onSubmit={(event) => (event.preventDefault(), save())}>
        <div className="form-grid two">
          <div className="field">
            <label htmlFor="cr-name">Name</label>
            <input id="cr-name" className="input" autoFocus value={form.name} onChange={set("name")} />
          </div>
          <div className="field">
            <label htmlFor="cr-code">Code</label>
            <input id="cr-code" className="input" value={form.code} onChange={set("code")} disabled={Boolean(creator)} placeholder="RIYA10" maxLength={16} />
          </div>
          <div className="field">
            <label htmlFor="cr-insta">Instagram</label>
            <input id="cr-insta" className="input" value={form.instagram} onChange={set("instagram")} />
          </div>
          <div className="field">
            <label htmlFor="cr-phone">Mobile</label>
            <input id="cr-phone" className="input" inputMode="tel" value={form.phone} onChange={set("phone")} />
          </div>
          <div className="field">
            <label htmlFor="cr-off">Followers get (% off)</label>
            <input id="cr-off" className="input" type="number" min={0} max={50} value={form.discountPct} onChange={set("discountPct")} />
          </div>
          <div className="field">
            <label htmlFor="cr-comm">She earns (% of net sales)</label>
            <input id="cr-comm" className="input" type="number" min={0} max={50} value={form.commissionPct} onChange={set("commissionPct")} />
          </div>
          <div className="field">
            <label htmlFor="cr-tds">TDS (% of commission, per your CA)</label>
            <input id="cr-tds" className="input" type="number" min={0} max={30} step="0.1" value={form.tdsPct} onChange={set("tdsPct")} />
          </div>
          <div className="field">
            <label htmlFor="cr-upi">UPI for payouts</label>
            <input id="cr-upi" className="input" value={form.upi} onChange={set("upi")} />
          </div>
        </div>
        <label className="check">
          <input type="checkbox" checked={form.active} onChange={set("active")} /> Code works
        </label>
        <Notice>{error}</Notice>
        <div className="row-actions">
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn primary" disabled={busy || form.name.trim().length < 2 || (!creator && !/^[A-Za-z0-9]{3,16}$/.test(form.code.trim()))}>
            Save
          </button>
        </div>
      </form>
    </Dialog>
  );
}

function CreatorView({ creator, canPay, onEdit, onClose, onPaid }: { creator: Creator; canPay: boolean; onEdit: () => void; onClose: () => void; onPaid: () => void }) {
  const s = creator.statement;
  const [reference, setReference] = useState("");
  const [confirm, setConfirm] = useState(false);
  const { busy, error, run } = useRun();
  const pay = () =>
    run(async () => {
      await api(`/api/creators/${creator._id}/payouts`, { method: "POST", body: { month: s.month, reference: reference.trim() } });
      onPaid();
    });
  return (
    <Dialog title={`${creator.name} · ${creator.code}`} onClose={onClose} wide>
      <div className="stats">
        <div className="stat">
          <span className="muted small-text">Bills in {s.month}</span>
          <strong>{s.orders}</strong>
        </div>
        <div className="stat">
          <span className="muted small-text">Net sales (before GST, less returns)</span>
          <strong>{rupees(s.netSalesPaise)}</strong>
        </div>
        <div className="stat">
          <span className="muted small-text">Commission {creator.commissionPct}%</span>
          <strong>{rupees(s.commissionPaise)}</strong>
          {s.tdsPaise > 0 && <span className="muted small-text">less TDS {rupees(s.tdsPaise)}</span>}
        </div>
        <div className="stat">
          <span className="muted small-text">Payable</span>
          <strong>{rupees(s.payablePaise)}</strong>
          {s.payout && <span className="muted small-text">paid {dateOnly(s.payout.paidAt)} · {s.payout.reference}</span>}
        </div>
      </div>
      {s.lines.length > 0 && (
        <div className="table-scroll">
          <table className="table plain">
            <tbody>
              {s.lines.map((line) => (
                <tr key={line.orderId}>
                  <td>#{line.number}</td>
                  <td>{line.invoice || <span className="muted">returned only</span>}</td>
                  <td>{line.customer}</td>
                  <td className="num">{rupees(line.netPaise)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {creator.upi && <p className="muted small-text">Pay to UPI {creator.upi}</p>}
      <Notice>{error}</Notice>
      {canPay && !s.payout && s.payablePaise > 0 && (
        <div className="field-row">
          <input className="input" placeholder="Payment reference (UPI / bank)" value={reference} onChange={(event) => (setReference(event.target.value), setConfirm(false))} aria-label="Payment reference" />
          {confirm ? (
            <button className="btn primary" disabled={busy} onClick={pay}>
              Yes, mark {rupees(s.payablePaise)} paid
            </button>
          ) : (
            <button className="btn" disabled={reference.trim().length < 3} onClick={() => setConfirm(true)}>
              Record payment
            </button>
          )}
        </div>
      )}
      <p className="muted small-text">Recording a payment writes down this month's figures; the money itself goes from your bank or UPI app.</p>
      <div className="row-actions">
        <button className="btn" onClick={onEdit}>
          Edit creator
        </button>
        <button className="btn" onClick={onClose}>
          Close
        </button>
      </div>
    </Dialog>
  );
}

// ---- Settings: the members' circle ---------------------------------------------------------------

export function LoyaltyForm({ settings, canWrite, onSaved }: { settings: Settings; canWrite: boolean; onSaved: () => void }) {
  const initial = () => {
    const l = settings.loyalty;
    return {
      enabled: l?.enabled ?? true,
      rupeesPerPoint: String(l?.rupeesPerPoint ?? 100),
      pointValue: String((l?.pointValuePaise ?? 100) / 100),
      maxRedeemPct: String(l?.maxRedeemPct ?? 20),
      minRedeemPoints: String(l?.minRedeemPoints ?? 100),
      referrerPoints: String(l?.referrerPoints ?? 200),
      referralDiscountPct: String(l?.referralDiscountPct ?? 10),
      tiers: (l?.tiers || []).map((tier) => ({ name: tier.name, from: String(tier.minSpendPaise / 100), multiplier: String(tier.multiplier), perk: tier.perk || "" })),
    };
  };
  const [form, setForm] = useState(initial);
  useEffect(() => setForm(initial()), [settings]); // eslint-disable-line react-hooks/exhaustive-deps
  const { busy, error, run } = useRun();
  const [saved, setSaved] = useState("");
  const save = () =>
    run(async () => {
      const tiers = form.tiers.filter((tier) => tier.name.trim()).map((tier) => ({ name: tier.name.trim(), minSpendPaise: toPaise(tier.from || "0"), multiplier: Number(tier.multiplier), perk: tier.perk.trim() }));
      if (tiers.some((tier) => Number.isNaN(tier.minSpendPaise))) throw new Error("Each tier's 'from' must be an amount in rupees.");
      await api("/api/settings", {
        method: "PATCH",
        body: {
          loyalty: {
            enabled: form.enabled,
            rupeesPerPoint: Number(form.rupeesPerPoint),
            pointValuePaise: toPaise(form.pointValue),
            maxRedeemPct: Number(form.maxRedeemPct),
            minRedeemPoints: Number(form.minRedeemPoints),
            referrerPoints: Number(form.referrerPoints),
            referralDiscountPct: Number(form.referralDiscountPct),
            tiers,
          },
        },
      });
      setSaved("Saved.");
      onSaved();
    });
  const field = (key: "rupeesPerPoint" | "pointValue" | "maxRedeemPct" | "minRedeemPoints" | "referrerPoints" | "referralDiscountPct", label: string) => (
    <div className="field">
      <label htmlFor={`ly-${key}`}>{label}</label>
      <input id={`ly-${key}`} className="input" inputMode="decimal" value={form[key]} onChange={(event) => setForm({ ...form, [key]: event.target.value })} />
    </div>
  );
  const setTier = (index: number, key: "name" | "from" | "multiplier" | "perk", value: string) => setForm({ ...form, tiers: form.tiers.map((tier, i) => (i === index ? { ...tier, [key]: value } : tier)) });
  return (
    <form className="card form-card" onSubmit={(event) => (event.preventDefault(), save())}>
      <h2>Members' circle</h2>
      <p className="muted small-text">Points on what a customer keeps (taken back when pieces return), spent on a later bill. Tiers come from her spend over the last 12 months, all channels.</p>
      <fieldset disabled={!canWrite}>
        <label className="check">
          <input type="checkbox" checked={form.enabled} onChange={(event) => setForm({ ...form, enabled: event.target.checked })} /> Points are on
        </label>
        <div className="form-grid">
          {field("rupeesPerPoint", "1 point for every Rs")}
          {field("pointValue", "A point is worth Rs")}
          {field("maxRedeemPct", "Points pay at most (% of a bill)")}
          {field("minRedeemPoints", "Points used from")}
          {field("referrerPoints", "Points to a friend who refers")}
          {field("referralDiscountPct", "New customer's first bill (% off)")}
        </div>
        <h3>Tiers</h3>
        <div className="table-scroll">
          <table className="table plain">
            <thead>
              <tr>
                <th>Name</th>
                <th>From (Rs a year)</th>
                <th>Points x</th>
                <th>What she gets</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {form.tiers.map((tier, index) => (
                <tr key={index}>
                  <td>
                    <input className="input" value={tier.name} onChange={(event) => setTier(index, "name", event.target.value)} aria-label="Tier name" />
                  </td>
                  <td>
                    <input className="input" inputMode="numeric" value={tier.from} onChange={(event) => setTier(index, "from", event.target.value)} aria-label="Tier starts at" />
                  </td>
                  <td>
                    <input className="input" inputMode="decimal" value={tier.multiplier} onChange={(event) => setTier(index, "multiplier", event.target.value)} aria-label="Points multiplier" />
                  </td>
                  <td>
                    <input className="input" value={tier.perk} onChange={(event) => setTier(index, "perk", event.target.value)} aria-label="Perk" />
                  </td>
                  <td>
                    <button type="button" className="btn small" onClick={() => setForm({ ...form, tiers: form.tiers.filter((_, i) => i !== index) })} aria-label={`Remove ${tier.name}`}>
                      ×
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {form.tiers.length < 6 && (
          <button type="button" className="btn small" onClick={() => setForm({ ...form, tiers: [...form.tiers, { name: "", from: "", multiplier: "1", perk: "" }] })}>
            Add a tier
          </button>
        )}
      </fieldset>
      <Notice>{error}</Notice>
      <Notice tone="ok">{saved}</Notice>
      {canWrite && (
        <button className="btn primary" disabled={busy}>
          Save members' circle
        </button>
      )}
    </form>
  );
}
