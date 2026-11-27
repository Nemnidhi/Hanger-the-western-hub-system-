import { useEffect, useState } from "react";
import { DEFAULT_LOOK, TAG_SIZES, type TagLook } from "../tags";
import { TagPreview } from "./Tags";
import { api, can, type Me } from "../api";
import { Notice, toPaise, useLoad, useRun } from "../ui";
import type { Location, PickPart, PickSettings, Settings, Supplier } from "../types";

// The owner's settings: business and GST details, cash-on-delivery rules, locations and suppliers.
export function SettingsPage({ me }: { me: Me }) {
  const loaded = useLoad<{ settings: Settings; paymentsReady: boolean; courierReady: boolean }>("/api/settings");
  const locations = useLoad<{ locations: Location[] }>("/api/locations");
  const canWrite = can(me, "settings:write");
  return (
    <div className="page settings">
      <h1>Settings</h1>
      <Notice>{loaded.error}</Notice>
      {loaded.data && locations.data && <BusinessForm settings={loaded.data.settings} paymentsReady={loaded.data.paymentsReady} locations={locations.data.locations} canWrite={canWrite} onSaved={loaded.reload} />}
      {loaded.data && <ShippingForm settings={loaded.data.settings} courierReady={loaded.data.courierReady} canWrite={canWrite} onSaved={loaded.reload} />}
      {loaded.data && <PicksForm settings={loaded.data.settings} canWrite={canWrite} onSaved={loaded.reload} />}
      {loaded.data && <StudioForm settings={loaded.data.settings} canWrite={canWrite} onSaved={loaded.reload} />}
      {loaded.data && <TagsForm settings={loaded.data.settings} canWrite={canWrite} onSaved={loaded.reload} />}
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

/** Courier booking: which Shiprocket pickup address to use, and the usual parcel size. */
function ShippingForm({ settings, courierReady, canWrite, onSaved }: { settings: Settings; courierReady: boolean; canWrite: boolean; onSaved: () => void }) {
  const shipping = settings.shipping || { pickupLocation: "", weightGrams: 500, lengthCm: 30, breadthCm: 25, heightCm: 4 };
  const pickups = useLoad<{ ready: boolean; locations: { name: string; pincode: string; city: string; primary: boolean }[] }>(courierReady ? "/api/shipping/pickup-locations" : null);
  const [form, setForm] = useState(() => ({ ...shipping, weightGrams: String(shipping.weightGrams), lengthCm: String(shipping.lengthCm), breadthCm: String(shipping.breadthCm), heightCm: String(shipping.heightCm) }));
  const { busy, error, run } = useRun();
  const [saved, setSaved] = useState("");
  const set = (key: keyof typeof form) => (event: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => setForm({ ...form, [key]: event.target.value });
  const save = () =>
    run(async () => {
      await api("/api/settings", {
        method: "PATCH",
        body: { shipping: { pickupLocation: form.pickupLocation.trim(), weightGrams: Number(form.weightGrams), lengthCm: Number(form.lengthCm), breadthCm: Number(form.breadthCm), heightCm: Number(form.heightCm) } },
      });
      setSaved("Saved.");
      onSaved();
    });
  const names = pickups.data?.locations || [];
  return (
    <form className="card form-card" onSubmit={(event) => (event.preventDefault(), save())}>
      <h2>Shipping</h2>
      <p className="muted small-text">
        {courierReady
          ? "Couriers are booked through the brand's own Shiprocket account. Tracking updates move orders to Shipped, Delivered or RTO by themselves."
          : "Courier booking is not connected: staff type the courier and tracking number by hand. To connect Shiprocket, add its API user to the server settings."}
      </p>
      <fieldset disabled={!canWrite}>
        <div className="form-grid">
          <div className="field span-2">
            <label htmlFor="pickup">Pickup address (its name in Shiprocket)</label>
            {names.length > 0 ? (
              <select id="pickup" className="input" value={form.pickupLocation} onChange={set("pickupLocation")}>
                <option value="">Choose the pickup address</option>
                {names.map((row) => (
                  <option key={row.name} value={row.name}>
                    {row.name} · {row.city} {row.pincode}
                    {row.primary ? " (primary)" : ""}
                  </option>
                ))}
              </select>
            ) : (
              <input id="pickup" className="input" value={form.pickupLocation} onChange={set("pickupLocation")} placeholder="Primary" />
            )}
          </div>
          <div className="field">
            <label htmlFor="grams">Usual parcel weight (grams)</label>
            <input id="grams" className="input" type="number" min={50} max={30000} step={50} value={form.weightGrams} onChange={set("weightGrams")} />
          </div>
          <div className="field">
            <label htmlFor="length">Box length (cm)</label>
            <input id="length" className="input" type="number" min={1} max={200} value={form.lengthCm} onChange={set("lengthCm")} />
          </div>
          <div className="field">
            <label htmlFor="breadth">Breadth (cm)</label>
            <input id="breadth" className="input" type="number" min={1} max={200} value={form.breadthCm} onChange={set("breadthCm")} />
          </div>
          <div className="field">
            <label htmlFor="height">Height (cm)</label>
            <input id="height" className="input" type="number" min={1} max={200} value={form.heightCm} onChange={set("heightCm")} />
          </div>
        </div>
        <p className="muted small-text">Couriers charge by the higher of the real weight and the box size (length x breadth x height / 5000 kg), so a snug box costs less.</p>
      </fieldset>
      <Notice>{pickups.error}</Notice>
      <Notice>{error}</Notice>
      <Notice tone="ok">{saved}</Notice>
      {canWrite && (
        <button className="btn primary" disabled={busy}>
          Save shipping
        </button>
      )}
    </form>
  );
}

const PICK_PARTS: { key: PickPart; label: string; hint: string }[] = [
  { key: "size", label: "Her size in stock", hint: "Her size (or the right one for how it runs) is on the rail, and how many are left" },
  { key: "pair", label: "Goes with what she has on", hint: "Staff set it in the catalogue under 'Goes with'" },
  { key: "colour", label: "Colours work together", hint: "Neutrals go with anything; some colour pairs are known to work" },
  { key: "occasion", label: "Same occasion", hint: "Work with work, party with party" },
  { key: "taste", label: "Her taste and budget", hint: "Her usual spend and colours; anything she returned scores nothing here" },
  { key: "push", label: "What the shop wants moving", hint: "New arrivals and pieces on the rail a long time" },
];
const DEFAULT_PICKS: PickSettings = { weights: { size: 30, pair: 20, colour: 15, occasion: 15, taste: 10, push: 10 }, newDays: 14, slowDays: 45, autoSend: false, autoSendDelayMinutes: 60, minGapDays: 7, template: { name: "", language: "en" } };

/** Outfit picks: how much each reason counts, the shop's push, and the automatic WhatsApp picks. */
function PicksForm({ settings, canWrite, onSaved }: { settings: Settings; canWrite: boolean; onSaved: () => void }) {
  const initial = () => {
    const picks = { ...DEFAULT_PICKS, ...(settings.picks || {}) };
    return { ...picks, weights: { ...DEFAULT_PICKS.weights, ...picks.weights }, template: { ...DEFAULT_PICKS.template, ...picks.template } };
  };
  const [form, setForm] = useState(initial);
  useEffect(() => setForm(initial()), [settings]); // eslint-disable-line react-hooks/exhaustive-deps
  const { busy, error, run } = useRun();
  const [saved, setSaved] = useState("");
  const total = PICK_PARTS.reduce((sum, part) => sum + form.weights[part.key], 0);
  const number = (key: "newDays" | "slowDays" | "autoSendDelayMinutes" | "minGapDays") => (event: React.ChangeEvent<HTMLInputElement>) => setForm({ ...form, [key]: Number(event.target.value) });
  const save = () =>
    run(async () => {
      if (!total) throw new Error("At least one reason needs a weight above 0.");
      if (form.newDays >= form.slowDays) throw new Error("'New for' must be fewer days than 'slow after'.");
      await api("/api/settings", { method: "PATCH", body: { picks: { ...form, template: { name: form.template.name.trim(), language: form.template.language.trim() || "en" } } } });
      setSaved("Saved.");
      onSaved();
    });
  return (
    <form className="card form-card" onSubmit={(event) => (event.preventDefault(), save())}>
      <h2>Outfit picks</h2>
      <p className="muted small-text">
        In the trial room (and on WhatsApp), every live piece in stock gets a score out of 100 from these six reasons. Nothing is cut off except a piece with no size left: a higher weight makes that reason count for more.
      </p>
      <fieldset disabled={!canWrite}>
        <div className="weights">
          {PICK_PARTS.map((part) => (
            <div key={part.key} className="weight-row">
              <label htmlFor={`w-${part.key}`}>
                <strong>{part.label}</strong>
                <span className="muted small-text">{part.hint}</span>
              </label>
              <input id={`w-${part.key}`} type="range" min={0} max={40} value={form.weights[part.key]} onChange={(event) => setForm({ ...form, weights: { ...form.weights, [part.key]: Number(event.target.value) } })} />
              <span className="weight-share">{total ? Math.round((form.weights[part.key] / total) * 100) : 0}%</span>
            </div>
          ))}
        </div>
        <div className="form-grid">
          <div className="field">
            <label htmlFor="new-days">New for (days on the rail)</label>
            <input id="new-days" className="input" type="number" min={1} max={90} value={form.newDays} onChange={number("newDays")} />
          </div>
          <div className="field">
            <label htmlFor="slow-days">Slow after (days on the rail)</label>
            <input id="slow-days" className="input" type="number" min={7} max={365} value={form.slowDays} onChange={number("slowDays")} />
          </div>
          <div className="field">
            <label htmlFor="picks-template">Picks template (approved by Meta)</label>
            <input id="picks-template" className="input" value={form.template.name} onChange={(event) => setForm({ ...form, template: { ...form.template, name: event.target.value } })} placeholder="outfit_picks" />
          </div>
          <div className="field">
            <label htmlFor="picks-lang">Template language</label>
            <input id="picks-lang" className="input" value={form.template.language} onChange={(event) => setForm({ ...form, template: { ...form.template, language: event.target.value } })} placeholder="en" />
          </div>
          <label className="check span-3">
            <input type="checkbox" checked={form.autoSend} onChange={(event) => setForm({ ...form, autoSend: event.target.checked })} /> Send picks automatically after a customer saves or leaves a look on the website
          </label>
          <div className="field">
            <label htmlFor="delay">Wait before sending (minutes)</label>
            <input id="delay" className="input" type="number" min={10} max={1440} value={form.autoSendDelayMinutes} onChange={number("autoSendDelayMinutes")} />
          </div>
          <div className="field">
            <label htmlFor="gap">At most once in (days)</label>
            <input id="gap" className="input" type="number" min={1} max={60} value={form.minGapDays} onChange={number("minGapDays")} />
          </div>
        </div>
        <p className="muted small-text">
          Picks go only to customers who agreed to offers on WhatsApp. Inside 24 hours of her last message they go as a product list from the catalogue; after that only the approved template can be sent. The template's body needs three blanks: her first name, the piece she looked at, and the picks (for example: "Hi {"{{1}}"}, these go with the {"{{2}}"}: {"{{3}}"}. Reply to see them.").
        </p>
      </fieldset>
      <Notice>{error}</Notice>
      <Notice tone="ok">{saved}</Notice>
      {canWrite && (
        <button className="btn primary" disabled={busy}>
          Save outfit picks
        </button>
      )}
    </form>
  );
}

/** Photo studio: the brand backdrop colour, the voice for write-ups, and the shop's own hashtags. */
function StudioForm({ settings, canWrite, onSaved }: { settings: Settings; canWrite: boolean; onSaved: () => void }) {
  const initial = () => ({ backdrop: `#${settings.studio?.backdrop || "F4ECE6"}`, voice: settings.studio?.voice || "", hashtags: (settings.studio?.hashtags || ["TheHangerIndore", "IndoreFashion", "WesternWear"]).map((tag) => `#${tag}`).join(" ") });
  const [form, setForm] = useState(initial);
  useEffect(() => setForm(initial()), [settings]); // eslint-disable-line react-hooks/exhaustive-deps
  const { busy, error, run } = useRun();
  const [saved, setSaved] = useState("");
  const save = () =>
    run(async () => {
      const hashtags = form.hashtags.split(/[\s,]+/).map((tag) => tag.replace(/^#/, "")).filter(Boolean);
      if (hashtags.length > 10) throw new Error("Keep the shop's own hashtags to 10 or fewer; the write-up adds the rest.");
      await api("/api/settings", { method: "PATCH", body: { studio: { backdrop: form.backdrop, voice: form.voice.trim(), hashtags } } });
      setSaved("Saved.");
      onSaved();
    });
  return (
    <form className="card form-card" onSubmit={(event) => (event.preventDefault(), save())}>
      <h2>Photo studio</h2>
      <p className="muted small-text">Used for every new piece in the photo studio: the colour behind the brand photos, how the write-ups should sound, and hashtags every Instagram caption carries.</p>
      <fieldset disabled={!canWrite}>
        <div className="form-grid">
          <div className="field">
            <label htmlFor="studio-backdrop">Backdrop colour</label>
            <div className="colour-pick">
              <input id="studio-backdrop" type="color" value={form.backdrop} onChange={(event) => setForm({ ...form, backdrop: event.target.value })} />
              <span>{form.backdrop.toUpperCase()}</span>
            </div>
          </div>
          <div className="field span-2">
            <label htmlFor="studio-tags">Shop hashtags (always added)</label>
            <input id="studio-tags" className="input" value={form.hashtags} onChange={(event) => setForm({ ...form, hashtags: event.target.value })} />
          </div>
          <div className="field span-3">
            <label htmlFor="studio-voice">Voice for write-ups</label>
            <textarea id="studio-voice" className="input" rows={2} maxLength={600} value={form.voice} onChange={(event) => setForm({ ...form, voice: event.target.value })} placeholder="Warm and simple, like a friend in the shop. No big words. Mention trial at the Indore store." />
          </div>
        </div>
      </fieldset>
      <Notice>{error}</Notice>
      <Notice tone="ok">{saved}</Notice>
      {canWrite && (
        <button className="btn primary" disabled={busy}>
          Save photo studio
        </button>
      )}
    </form>
  );
}

/** Price tags: what the label printer prints on each piece, with a preview. */
function TagsForm({ settings, canWrite, onSaved }: { settings: Settings; canWrite: boolean; onSaved: () => void }) {
  const initial = () => ({ ...DEFAULT_LOOK, ...(settings.tags || {}) });
  const [form, setForm] = useState<TagLook>(initial);
  useEffect(() => setForm(initial()), [settings]); // eslint-disable-line react-hooks/exhaustive-deps
  const { busy, error, run } = useRun();
  const [saved, setSaved] = useState("");
  const preset = TAG_SIZES.findIndex((size) => size.widthMm === form.widthMm && size.heightMm === form.heightMm);
  const sample = { code: "DRS-015-M", name: "Linen midi dress", size: "M", pricePaise: 249900 };
  const save = () =>
    run(async () => {
      await api("/api/settings", { method: "PATCH", body: { tags: { ...form, brandLine: form.brandLine.trim(), qrUrl: form.qrUrl.trim(), footer: form.footer.trim() } } });
      setSaved("Saved.");
      onSaved();
    });
  return (
    <form className="card form-card" onSubmit={(event) => (event.preventDefault(), save())}>
      <h2>Price tags</h2>
      <p className="muted small-text">
        Printed from Catalogue (Price tags on a style) or after receiving stock. Every tag has the size code as a barcode and in large type, so staff can type it when the scanner can't read it.
      </p>
      <TagPreview item={sample} look={form} brandName={settings.brandName} />
      <fieldset disabled={!canWrite}>
        <div className="form-grid">
          <div className="field">
            <label htmlFor="tag-brand">Brand line</label>
            <input id="tag-brand" className="input" maxLength={30} value={form.brandLine} onChange={(event) => setForm({ ...form, brandLine: event.target.value })} placeholder={settings.brandName} />
          </div>
          <div className="field">
            <label htmlFor="tag-size">Label size</label>
            <select id="tag-size" className="input" value={preset} onChange={(event) => {
                const picked = TAG_SIZES[Number(event.target.value)];
                if (picked) setForm({ ...form, widthMm: picked.widthMm, heightMm: picked.heightMm });
              }}>
              {preset < 0 && <option value={-1}>{form.widthMm} x {form.heightMm} mm</option>}
              {TAG_SIZES.map((size, index) => (
                <option key={size.label} value={index}>
                  {size.label}
                </option>
              ))}
            </select>
          </div>
          <div className="field">
            <label htmlFor="tag-footer">Line under the QR</label>
            <input id="tag-footer" className="input" maxLength={30} value={form.footer} onChange={(event) => setForm({ ...form, footer: event.target.value })} placeholder="www.thehanger.in" />
          </div>
          <div className="field span-3">
            <label htmlFor="tag-qr">QR code link (optional; {"{code}"} becomes the size code)</label>
            <input id="tag-qr" className="input" type="url" value={form.qrUrl} onChange={(event) => setForm({ ...form, qrUrl: event.target.value })} placeholder="https://www.instagram.com/thehanger" />
          </div>
          <label className="check span-3">
            <input type="checkbox" checked={form.showName} onChange={(event) => setForm({ ...form, showName: event.target.checked })} /> Show the piece's name
          </label>
        </div>
      </fieldset>
      <Notice>{error}</Notice>
      <Notice tone="ok">{saved}</Notice>
      {canWrite && (
        <button className="btn primary" disabled={busy}>
          Save price tags
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
