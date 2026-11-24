import { useEffect, useState } from "react";
import { api, can, type Me } from "../api";
import { Notice, toPaise, useLoad, useRun } from "../ui";
import type { Location, Settings, Supplier } from "../types";

// The owner's settings: business and GST details, cash-on-delivery rules, locations and suppliers.
export function SettingsPage({ me }: { me: Me }) {
  const loaded = useLoad<{ settings: Settings; paymentsReady: boolean }>("/api/settings");
  const locations = useLoad<{ locations: Location[] }>("/api/locations");
  const canWrite = can(me, "settings:write");
  return (
    <div className="page settings">
      <h1>Settings</h1>
      <Notice>{loaded.error}</Notice>
      {loaded.data && locations.data && <BusinessForm settings={loaded.data.settings} paymentsReady={loaded.data.paymentsReady} locations={locations.data.locations} canWrite={canWrite} onSaved={loaded.reload} />}
      <Locations canWrite={canWrite} onlineCode={loaded.data?.settings.onlineLocationCode || ""} list={locations} />
      <Suppliers canWrite={can(me, "catalog:write")} />
    </div>
  );
}

function BusinessForm({ settings, paymentsReady, locations, canWrite, onSaved }: { settings: Settings; paymentsReady: boolean; locations: Location[]; canWrite: boolean; onSaved: () => void }) {
  const { busy, error, run } = useRun();
  const [saved, setSaved] = useState("");
  const [form, setForm] = useState(() => toForm(settings));
  useEffect(() => setForm(toForm(settings)), [settings]);
  const set = (key: keyof ReturnType<typeof toForm>) => (event: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) =>
    setForm({ ...form, [key]: event.target.type === "checkbox" ? (event.target as HTMLInputElement).checked : event.target.value });

  const save = () =>
    run(async () => {
      const low = Number(form.lowBelow);
      const high = Number(form.highFrom);
      if (!(low >= 0 && high <= 1 && low < high)) throw new Error("COD bands: 'ships at once below' must be lower than 'prepaid only from', both between 0 and 1.");
      const maxOrder = form.maxOrder.trim() ? toPaise(form.maxOrder) : 0;
      if (Number.isNaN(maxOrder)) throw new Error("COD limit must be an amount in rupees.");
      await api("/api/settings", {
        method: "PATCH",
        body: {
          brandName: form.brandName.trim(),
          legalName: form.legalName.trim(),
          ...(form.gstin.trim() ? { gstin: form.gstin.trim().toUpperCase() } : {}),
          registeredAddress: form.registeredAddress.trim(),
          orderPrefix: form.orderPrefix.trim().toUpperCase(),
          onlineLocationCode: form.onlineLocationCode,
          defaultHsn: form.defaultHsn.trim(),
          paymentHoldMinutes: Number(form.paymentHoldMinutes),
          cod: { enabled: form.codEnabled, maxOrderPaise: maxOrder, lowBelow: low, highFrom: high, confirmHours: Number(form.confirmHours) },
          templates: { orderUpdate: { name: form.template.trim(), language: form.templateLanguage.trim() || "en" } },
        },
      });
      setSaved("Saved.");
      onSaved();
    });

  return (
    <form className="card form-card" onSubmit={(event) => (event.preventDefault(), save())}>
      <h2>Business and GST</h2>
      <fieldset disabled={!canWrite}>
        <div className="form-grid">
          <div className="field">
            <label htmlFor="brand">Brand name</label>
            <input id="brand" className="input" value={form.brandName} onChange={set("brandName")} />
          </div>
          <div className="field span-2">
            <label htmlFor="legal">Legal name (on invoices)</label>
            <input id="legal" className="input" value={form.legalName} onChange={set("legalName")} />
          </div>
          <div className="field">
            <label htmlFor="gstin">GSTIN</label>
            <input id="gstin" className="input" value={form.gstin} onChange={set("gstin")} placeholder="23ABCDE1234F1Z5" maxLength={15} />
          </div>
          <div className="field span-2">
            <label htmlFor="address">Registered address</label>
            <input id="address" className="input" value={form.registeredAddress} onChange={set("registeredAddress")} />
          </div>
          <div className="field">
            <label htmlFor="prefix">Order number prefix</label>
            <input id="prefix" className="input" value={form.orderPrefix} onChange={set("orderPrefix")} maxLength={5} />
          </div>
          <div className="field">
            <label htmlFor="hsn">Default HSN</label>
            <input id="hsn" className="input" value={form.defaultHsn} onChange={set("defaultHsn")} />
          </div>
          <div className="field">
            <label htmlFor="hold">Online payment window (minutes)</label>
            <input id="hold" className="input" type="number" min={5} max={1440} value={form.paymentHoldMinutes} onChange={set("paymentHoldMinutes")} />
          </div>
        </div>

        <h2>Cash on delivery</h2>
        <p className="muted small-text">
          Every COD order gets a risk score from 0 (safe) to 1 (likely to be refused), from the customer's and the pincode's record, the order value and the address. You choose what each band does.
        </p>
        <div className="form-grid">
          <label className="check span-3">
            <input type="checkbox" checked={form.codEnabled} onChange={set("codEnabled")} /> Offer cash on delivery
          </label>
          <div className="field">
            <label htmlFor="low">Ships at once below</label>
            <input id="low" className="input" type="number" step="0.05" min={0} max={1} value={form.lowBelow} onChange={set("lowBelow")} />
          </div>
          <div className="field">
            <label htmlFor="high">Prepaid only from</label>
            <input id="high" className="input" type="number" step="0.05" min={0} max={1} value={form.highFrom} onChange={set("highFrom")} />
          </div>
          <div className="field">
            <label htmlFor="confirm">Hours to confirm a medium-risk COD</label>
            <input id="confirm" className="input" type="number" min={1} max={72} value={form.confirmHours} onChange={set("confirmHours")} />
          </div>
          <div className="field">
            <label htmlFor="max">No COD above, Rs (blank: no limit)</label>
            <input id="max" className="input" inputMode="decimal" value={form.maxOrder} onChange={set("maxOrder")} />
          </div>
        </div>

        <h2>WhatsApp and payments</h2>
        <div className="form-grid">
          <div className="field">
            <label htmlFor="online">Online orders ship from</label>
            <select id="online" className="input" value={form.onlineLocationCode} onChange={set("onlineLocationCode")}>
              <option value="">First location</option>
              {locations.map((location) => (
                <option key={location._id} value={location.code}>
                  {location.name} ({location.code})
                </option>
              ))}
            </select>
          </div>
          <div className="field">
            <label htmlFor="template">Order update template (approved by Meta)</label>
            <input id="template" className="input" value={form.template} onChange={set("template")} placeholder="order_update" />
          </div>
          <div className="field">
            <label htmlFor="lang">Template language</label>
            <input id="lang" className="input" value={form.templateLanguage} onChange={set("templateLanguage")} placeholder="en" />
          </div>
        </div>
        <p className="muted small-text">Online payments (Razorpay): {paymentsReady ? "connected." : "not connected yet; customers can only choose cash on delivery."}</p>
      </fieldset>
      <Notice>{error}</Notice>
      <Notice tone="ok">{saved}</Notice>
      {canWrite && (
        <button className="btn primary" disabled={busy}>
          Save settings
        </button>
      )}
    </form>
  );
}

function toForm(settings: Settings) {
  return {
    brandName: settings.brandName || "",
    legalName: settings.legalName || "",
    gstin: settings.gstin || "",
    registeredAddress: settings.registeredAddress || "",
    orderPrefix: settings.orderPrefix || "HWH",
    onlineLocationCode: settings.onlineLocationCode || "",
    defaultHsn: settings.defaultHsn || "6204",
    paymentHoldMinutes: String(settings.paymentHoldMinutes || 30),
    codEnabled: settings.cod?.enabled ?? true,
    lowBelow: String(settings.cod?.lowBelow ?? 0.35),
    highFrom: String(settings.cod?.highFrom ?? 0.6),
    confirmHours: String(settings.cod?.confirmHours ?? 12),
    maxOrder: settings.cod?.maxOrderPaise ? String(settings.cod.maxOrderPaise / 100) : "",
    template: settings.templates?.orderUpdate?.name || "",
    templateLanguage: settings.templates?.orderUpdate?.language || "en",
  };
}

function Locations({ canWrite, onlineCode, list }: { canWrite: boolean; onlineCode: string; list: ReturnType<typeof useLoad<{ locations: Location[] }>> }) {
  const { busy, error, run } = useRun();
  const empty = { code: "", name: "", kind: "store", address: "", pincode: "", invoicePrefix: "" };
  const [form, setForm] = useState(empty);
  const add = () =>
    run(async () => {
      await api("/api/locations", { method: "POST", body: { ...form, code: form.code.trim().toUpperCase(), invoicePrefix: form.invoicePrefix.trim().toUpperCase(), ...(form.pincode.trim() ? { pincode: form.pincode.trim() } : { pincode: undefined }) } });
      setForm(empty);
      list.reload();
    });
  return (
    <section className="card form-card">
      <h2>Locations</h2>
      <p className="muted small-text">Each store and stock room keeps its own stock and its own invoice series (GST rule: unique per financial year).</p>
      <table className="table plain">
        <thead>
          <tr>
            <th>Code</th>
            <th>Name</th>
            <th>Kind</th>
            <th>Invoice series</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {list.data?.locations.map((location) => (
            <tr key={location._id}>
              <td>{location.code}</td>
              <td>
                {location.name}
                <div className="muted small-text">
                  {location.address} {location.pincode}
                </div>
              </td>
              <td>{location.kind}</td>
              <td>{location.invoicePrefix}/…</td>
              <td>{location.code === onlineCode && <span className="badge accent">ships online</span>}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {canWrite && (
        <form className="form-grid" onSubmit={(event) => (event.preventDefault(), add())}>
          <div className="field">
            <label htmlFor="loc-code">Code</label>
            <input id="loc-code" className="input" required value={form.code} onChange={(event) => setForm({ ...form, code: event.target.value })} placeholder="ST1" pattern="[A-Za-z0-9]{2,6}" />
          </div>
          <div className="field">
            <label htmlFor="loc-name">Name</label>
            <input id="loc-name" className="input" required value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} placeholder="MG Road store" />
          </div>
          <div className="field">
            <label htmlFor="loc-kind">Kind</label>
            <select id="loc-kind" className="input" value={form.kind} onChange={(event) => setForm({ ...form, kind: event.target.value })}>
              <option value="store">Store (counter sales)</option>
              <option value="warehouse">Stock room</option>
            </select>
          </div>
          <div className="field span-2">
            <label htmlFor="loc-address">Address</label>
            <input id="loc-address" className="input" value={form.address} onChange={(event) => setForm({ ...form, address: event.target.value })} />
          </div>
          <div className="field">
            <label htmlFor="loc-pin">Pincode</label>
            <input id="loc-pin" className="input" value={form.pincode} onChange={(event) => setForm({ ...form, pincode: event.target.value })} inputMode="numeric" pattern="[1-9][0-9]{5}" />
          </div>
          <div className="field">
            <label htmlFor="loc-prefix">Invoice prefix</label>
            <input id="loc-prefix" className="input" required value={form.invoicePrefix} onChange={(event) => setForm({ ...form, invoicePrefix: event.target.value })} placeholder="ST1" pattern="[A-Za-z0-9]{2,4}" />
          </div>
          <div className="field end">
            <button className="btn" disabled={busy}>
              Add location
            </button>
          </div>
        </form>
      )}
      <Notice>{error || list.error}</Notice>
    </section>
  );
}

function Suppliers({ canWrite }: { canWrite: boolean }) {
  const list = useLoad<{ suppliers: Supplier[] }>("/api/suppliers");
  const { busy, error, run } = useRun();
  const [form, setForm] = useState({ name: "", city: "", waId: "", notes: "" });
  const add = () =>
    run(async () => {
      const digits = form.waId.replace(/\D/g, "");
      await api("/api/suppliers", { method: "POST", body: { name: form.name.trim(), city: form.city.trim(), notes: form.notes.trim(), ...(digits ? { waId: digits.length === 10 ? `91${digits}` : digits } : {}) } });
      setForm({ name: "", city: "", waId: "", notes: "" });
      list.reload();
    });
  return (
    <section className="card form-card">
      <h2>Suppliers</h2>
      <table className="table plain">
        <tbody>
          {list.data?.suppliers.map((supplier) => (
            <tr key={supplier._id}>
              <td>
                {supplier.name}
                <div className="muted small-text">{supplier.notes}</div>
              </td>
              <td>{supplier.city}</td>
              <td>{supplier.waId && `+${supplier.waId}`}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {list.data && !list.data.suppliers.length && <p className="muted">No suppliers yet.</p>}
      {canWrite && (
        <form className="form-grid" onSubmit={(event) => (event.preventDefault(), add())}>
          <div className="field">
            <label htmlFor="sup-name">Name</label>
            <input id="sup-name" className="input" required minLength={2} value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} />
          </div>
          <div className="field">
            <label htmlFor="sup-city">City</label>
            <input id="sup-city" className="input" value={form.city} onChange={(event) => setForm({ ...form, city: event.target.value })} placeholder="Surat" />
          </div>
          <div className="field">
            <label htmlFor="sup-wa">WhatsApp</label>
            <input id="sup-wa" className="input" inputMode="tel" value={form.waId} onChange={(event) => setForm({ ...form, waId: event.target.value })} />
          </div>
          <div className="field span-2">
            <label htmlFor="sup-notes">Notes</label>
            <input id="sup-notes" className="input" value={form.notes} onChange={(event) => setForm({ ...form, notes: event.target.value })} placeholder="Good for linen co-ords; 10-day delivery" />
          </div>
          <div className="field end">
            <button className="btn" disabled={busy}>
              Add supplier
            </button>
          </div>
        </form>
      )}
      <Notice>{error || list.error}</Notice>
    </section>
  );
}
