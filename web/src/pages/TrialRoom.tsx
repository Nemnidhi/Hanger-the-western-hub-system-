import { useEffect, useMemo, useRef, useState } from "react";
import { codeHas, sameCode, squash } from "../codes";
import { api, can, type Me } from "../api";
import { rupees } from "../format";
import { Notice, useLoad, useRun } from "../ui";
import type { Location, Pick, PickPart, PicksResult, Style } from "../types";

// The trial room: scan what she is trying, and the screen lists what to bring her next from this
// store's rail, in her size, best first, with the reasons. Staff can send the picks to her WhatsApp.

const PART_LABEL: Record<string, string> = { dress: "Dress", top: "Top", bottom: "Bottom", layer: "Layer", other: "Other" };
const SHORT: Record<PickPart, string> = { size: "Size", pair: "Pairs", colour: "Colour", occasion: "Occasion", taste: "Her taste", push: "Shop push" };
const digits = (text: string) => text.replace(/\D/g, "");
const validPhone = (text: string) => {
  const value = digits(text);
  return value.length === 10 || (value.length === 11 && value.startsWith("0")) || (value.length === 12 && value.startsWith("91"));
};

interface InRoom {
  code: string; // the scanned size code, or the style code
  styleCode: string;
  name: string;
  size: string;
  image: string;
}

export function TrialRoom({ me }: { me: Me }) {
  const styles = useLoad<{ styles: Style[] }>("/api/styles?status=live");
  const locations = useLoad<{ locations: Location[] }>("/api/locations");
  const places = useMemo(() => (locations.data?.locations || []).filter((location) => location.active), [locations.data]);
  const [locationCode, setLocationCode] = useState(() => {
    try {
      return localStorage.getItem("trial-location") || "";
    } catch {
      return "";
    }
  });
  const location = places.find((place) => place.code === locationCode) || places.find((place) => place.kind === "store") || places[0];
  const [scan, setScan] = useState("");
  const [room, setRoom] = useState<InRoom[]>([]);
  const [phone, setPhone] = useState("");
  const [size, setSize] = useState("");
  const [waist, setWaist] = useState("");
  const [result, setResult] = useState<PicksResult | null>(null);
  const [chosen, setChosen] = useState<string[]>([]);
  const [open, setOpen] = useState("");
  const [agreed, setAgreed] = useState(false);
  const [message, setMessage] = useState("");
  const [sent, setSent] = useState("");
  const load = useRun();
  const send = useRun();
  const scanRef = useRef<HTMLInputElement>(null);
  const canSend = can(me, "inbox:write");

  useEffect(() => {
    if (!location) return;
    try {
      localStorage.setItem("trial-location", location.code);
    } catch {
      /* private window */
    }
  }, [location]);

  // Every size of every live style, so a barcode or a size code finds its style.
  const sizes = useMemo(() => {
    const rows: InRoom[] = [];
    for (const style of styles.data?.styles || []) {
      for (const row of style.sizes) rows.push({ code: row.code, styleCode: style.code, name: style.name, size: row.size, image: style.images[0] || "" });
    }
    return rows;
  }, [styles.data]);
  const barcodes = useMemo(() => new Map((styles.data?.styles || []).flatMap((style) => style.sizes.filter((row) => row.barcode).map((row) => [squash(row.barcode), row.code] as const))), [styles.data]);
  const term = scan.trim().toUpperCase();
  const matches = term.length >= 2 ? sizes.filter((row) => codeHas(row.code, term) || row.name.toUpperCase().includes(term)).slice(0, 10) : [];

  function add(code: string) {
    const row = sizes.find((item) => item.code === code);
    if (!row) return;
    setRoom((pieces) => [...pieces.filter((piece) => piece.styleCode !== row.styleCode), row]);
    setScan("");
    setMessage("");
    scanRef.current?.focus();
  }

  function onScanKey(event: React.KeyboardEvent<HTMLInputElement>) {
    if (event.key !== "Enter") return;
    event.preventDefault();
    const exact = barcodes.get(squash(term)) || sizes.find((row) => sameCode(term, row.code))?.code;
    if (exact) add(exact);
    else if (matches.length === 1) add(matches[0].code);
    else if (!matches.length) setMessage(`Nothing matches "${scan.trim()}".`);
  }

  const phoneReady = validPhone(phone);
  const request = useMemo(
    () => ({ pieces: room.map((piece) => piece.code), phone: phoneReady ? digits(phone) : undefined, size: size.trim().toUpperCase() || undefined, waist: digits(waist) || undefined, location: location?.code, limit: 8 }),
    [room, phone, phoneReady, size, waist, location],
  );
  const key = JSON.stringify(request);

  // New picks whenever what she is trying, who she is or the sizes change.
  useEffect(() => {
    if (!location || (!request.pieces.length && !request.phone)) {
      setResult(null);
      return;
    }
    let live = true;
    load.run(async () => {
      const data = await api<PicksResult>("/api/picks", { method: "POST", body: request });
      if (!live) return;
      setResult(data);
      setSent("");
      const all = [...data.complete, ...data.swap].map((pick) => pick.styleCode);
      setChosen((before) => {
        const kept = before.filter((code) => all.includes(code));
        return kept.length ? kept : data.complete.slice(0, 3).map((pick) => pick.styleCode);
      });
    });
    return () => {
      live = false;
    };
  }, [key]); // eslint-disable-line react-hooks/exhaustive-deps

  const customer = result?.customer;
  const consent = Boolean(customer?.offersConsent);
  const toggle = (code: string) => setChosen((list) => (list.includes(code) ? list.filter((item) => item !== code) : [...list, code]));

  const saveSizes = () =>
    send.run(async () => {
      await api("/api/customers/sizes", { method: "POST", body: { phone: digits(phone), usualSize: size.trim().toUpperCase() || undefined, waist: digits(waist) || undefined } });
      setSent("Her sizes are saved for next time.");
    });

  const sendPicks = () =>
    send.run(async () => {
      const done = await api<{ via: string; picks: Pick[] }>("/api/picks/send", {
        method: "POST",
        body: { ...request, phone: digits(phone), styleCodes: chosen, consentNow: !consent && agreed },
      });
      const how = done.via === "products" ? "as a product list she can add to her cart" : done.via === "template" ? "with the picks template" : "as a message";
      setSent(`Sent ${done.picks.length} picks to her WhatsApp ${how}.`);
      setAgreed(false);
      if (result?.customer) setResult({ ...result, customer: { ...result.customer, offersConsent: true } });
    });

  function reset() {
    setRoom([]);
    setPhone("");
    setSize("");
    setWaist("");
    setResult(null);
    setChosen([]);
    setSent("");
    setAgreed(false);
    scanRef.current?.focus();
  }

  return (
    <div className="page trial">
      <div className="detail-head">
        <h1>Trial room</h1>
        {places.length > 1 && (
          <select className="input auto" value={location?.code || ""} onChange={(event) => setLocationCode(event.target.value)} aria-label="Picks from">
            {places.map((place) => (
              <option key={place._id} value={place.code}>
                Picks from {place.name}
              </option>
            ))}
          </select>
        )}
        <button className="btn small" onClick={reset}>
          Next customer
        </button>
      </div>
      <Notice>{styles.error || locations.error}</Notice>

      <div className="trial-grid">
        <div className="trial-side">
          <section className="card">
            <h2>In the room</h2>
            <input ref={scanRef} className="input big" autoFocus placeholder="Scan the tag, or type a code / name" value={scan} onChange={(event) => setScan(event.target.value)} onKeyDown={onScanKey} aria-label="Scan what she is trying" />
            <Notice tone="warn">{message}</Notice>
            {matches.length > 0 && (
              <div className="matches">
                {matches.map((row) => (
                  <button key={row.code} className="match" onClick={() => add(row.code)}>
                    {row.image ? <img src={row.image} alt="" /> : <span className="thumb" />}
                    <span>
                      <strong>{row.name}</strong>
                      <span className="muted">{row.code}</span>
                    </span>
                    <span className="muted">{row.size}</span>
                  </button>
                ))}
              </div>
            )}
            {room.length === 0 ? (
              <p className="muted small-text">Scan each piece she takes in. Picks start from the first one.</p>
            ) : (
              <ul className="room-list">
                {room.map((piece) => {
                  const part = result?.trying.find((row) => row.styleCode === piece.styleCode)?.part;
                  return (
                    <li key={piece.styleCode}>
                      {piece.image ? <img src={piece.image} alt="" /> : <span className="thumb" />}
                      <span>
                        <strong>{piece.name}</strong>
                        <span className="muted small-text">
                          {piece.size} · {part ? PART_LABEL[part] : piece.styleCode}
                        </span>
                      </span>
                      <button className="btn small" onClick={() => setRoom((list) => list.filter((row) => row.styleCode !== piece.styleCode))} aria-label={`Remove ${piece.name}`}>
                        Remove
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
          </section>

          <section className="card">
            <h2>Her</h2>
            <div className="form-grid two">
              <div className="field span-2">
                <label htmlFor="trial-phone">Mobile number</label>
                <input id="trial-phone" className="input" inputMode="tel" value={phone} onChange={(event) => setPhone(event.target.value)} placeholder="98260 12345" />
              </div>
              <div className="field">
                <label htmlFor="trial-size">Her size</label>
                <input id="trial-size" className="input" value={size} onChange={(event) => setSize(event.target.value)} placeholder={customer?.letter ? `${customer.letter} (on file)` : "S, M, L…"} maxLength={5} />
              </div>
              <div className="field">
                <label htmlFor="trial-waist">Waist</label>
                <input id="trial-waist" className="input" inputMode="numeric" value={waist} onChange={(event) => setWaist(event.target.value)} placeholder={customer?.waist ? `${customer.waist} (on file)` : "28, 30…"} maxLength={2} />
              </div>
            </div>
            {phoneReady && customer && (
              <div className="her">
                <p>
                  <strong>{customer.name || "New customer"}</strong>
                  <span className="muted">
                    {" "}
                    · {customer.orders ? `${customer.orders} order${customer.orders === 1 ? "" : "s"}` : "no orders yet"}
                    {customer.band ? ` · usually ${rupees(customer.band[0])}–${rupees(customer.band[1])}` : ""}
                  </span>
                </p>
                {customer.colours.length > 0 && <p className="muted small-text">Has bought: {customer.colours.join(", ")}</p>}
                {customer.history.length > 0 && (
                  <ul className="scans">
                    {customer.history.map((order) => (
                      <li key={order.number}>
                        #{order.number} · {order.lines.join(", ")}
                      </li>
                    ))}
                  </ul>
                )}
                {customer.returned.length > 0 && <p className="muted small-text">Returned before: {customer.returned.join(", ")}</p>}
                <p className="small-text">{consent ? <span className="badge accent">Agreed to picks on WhatsApp</span> : <span className="badge warn">Not agreed to WhatsApp picks yet</span>}</p>
                {canSend && (size.trim() || waist.trim()) && (
                  <button className="btn small" onClick={saveSizes} disabled={send.busy}>
                    Save her sizes
                  </button>
                )}
              </div>
            )}
          </section>
        </div>

        <div className="trial-picks">
          <Notice>{load.error}</Notice>
          {!result && <div className="empty-card card muted">Scan what she is trying (or type her number) to see what to bring next.</div>}
          {result && (
            <>
              <PickGroup title="Completes the look" note="Parts of the outfit she has not got yet" picks={result.complete} chosen={chosen} toggle={toggle} open={open} setOpen={setOpen} />
              <PickGroup title="Other options" note="Swaps for a part she already has" picks={result.swap} chosen={chosen} toggle={toggle} open={open} setOpen={setOpen} />
              <p className="muted small-text">
                {result.considered} pieces in stock at {result.location.name} were scored. Weights are in Settings, under Outfit picks.
              </p>
              {canSend && (
                <section className="card send-card">
                  <h2>Send to her WhatsApp</h2>
                  {!phoneReady ? (
                    <p className="muted small-text">Type her mobile number to send these picks.</p>
                  ) : (
                    <>
                      <p className="small-text">
                        {chosen.length ? `${chosen.length} picked: ${[...result.complete, ...result.swap].filter((pick) => chosen.includes(pick.styleCode)).map((pick) => `${pick.name} (${pick.size})`).join(", ")}` : "Tick the picks to send."}
                      </p>
                      {!consent && (
                        <label className="check">
                          <input type="checkbox" checked={agreed} onChange={(event) => setAgreed(event.target.checked)} /> She agreed just now to get picks and offers on WhatsApp
                        </label>
                      )}
                      <button className="btn primary" onClick={sendPicks} disabled={send.busy || !chosen.length || (!consent && !agreed)}>
                        Send {chosen.length || ""} picks
                      </button>
                    </>
                  )}
                  <Notice>{send.error}</Notice>
                  <Notice tone="ok">{sent}</Notice>
                </section>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function PickGroup({ title, note, picks, chosen, toggle, open, setOpen }: { title: string; note: string; picks: Pick[]; chosen: string[]; toggle: (code: string) => void; open: string; setOpen: (code: string) => void }) {
  if (!picks.length) return null;
  return (
    <section className="pick-group">
      <h2>
        {title} <span className="muted small-text">{note}</span>
      </h2>
      <div className="pick-list">
        {picks.map((pick) => (
          <article key={pick.styleCode} className={`pick card${chosen.includes(pick.styleCode) ? " on" : ""}`}>
            {pick.image ? <img src={pick.image} alt="" /> : <span className="thumb" />}
            <div className="pick-body">
              <div className="pick-head">
                <strong>{pick.name}</strong>
                <span className="pick-score" title="Score out of 100">
                  {pick.score}
                </span>
              </div>
              <div className="muted small-text">
                {PART_LABEL[pick.part] || pick.part} · bring <strong>{pick.size}</strong> · {pick.left} left · {rupees(pick.pricePaise)}
              </div>
              <div className="muted small-text">{pick.why.pair && pick.parts.pair >= 1 ? pick.why.pair : pick.why.size}</div>
              <div className="pick-actions">
                <label className="check">
                  <input type="checkbox" checked={chosen.includes(pick.styleCode)} onChange={() => toggle(pick.styleCode)} /> Bring / send
                </label>
                <button className="btn small link" onClick={() => setOpen(open === pick.styleCode ? "" : pick.styleCode)} aria-expanded={open === pick.styleCode}>
                  Why
                </button>
              </div>
              {open === pick.styleCode && (
                <dl className="why">
                  {(Object.keys(SHORT) as PickPart[]).map((key) => (
                    <div key={key}>
                      <dt>{SHORT[key]}</dt>
                      <dd>
                        <span className="bar" aria-hidden="true">
                          <span style={{ width: `${Math.round(pick.parts[key] * 100)}%` }} />
                        </span>
                        <span className="small-text">{pick.why[key]}</span>
                      </dd>
                    </div>
                  ))}
                </dl>
              )}
            </div>
          </article>
        ))}
      </div>
    </section>
  );
}
