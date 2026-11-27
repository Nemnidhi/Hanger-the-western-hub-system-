import { useEffect, useState } from "react";
import { api, can, type Me } from "../api";
import { when } from "../format";
import { Notice, useLoad, useRun } from "../ui";
import type { Settings } from "../types";

// The owner's morning brief, as it goes on WhatsApp, on the Today page; and its settings.

interface SendResult { waId: string; sent: string; why?: string }
interface BriefView { headline: string; text: string; sent: { at: string; results: SendResult[] } | null; settings?: Settings["brief"] }
const SENT: Record<string, string> = { text: "full text", template: "template (reply BRIEF for the rest)", none: "not sent" };

/** WhatsApp's *bold* shown as bold. */
function Rich({ text }: { text: string }) {
  return (
    <div className="brief-text">
      {text.split("\n").map((line, index) => (
        <div key={index}>{line ? line.split(/(\*[^*]+\*)/).map((part, i) => (/^\*[^*]+\*$/.test(part) ? <strong key={i}>{part.slice(1, -1)}</strong> : part)) : " "}</div>
      ))}
    </div>
  );
}

export function BriefCard({ me }: { me: Me }) {
  const loaded = useLoad<BriefView>("/api/brief");
  const [open, setOpen] = useState(false);
  const { busy, error, run } = useRun();
  const [done, setDone] = useState("");
  const send = () =>
    run(async () => {
      const result = await api<{ results: SendResult[] }>("/api/brief/send", { method: "POST", body: {} });
      setDone(result.results.length ? result.results.map((row) => `+${row.waId}: ${SENT[row.sent] || row.sent}${row.why ? ` (${row.why})` : ""}`).join("; ") : "No owner numbers set in Settings > Morning brief.");
      loaded.reload();
    });
  if (loaded.error) return <Notice>{loaded.error}</Notice>;
  if (!loaded.data) return null;
  const b = loaded.data;
  const at = `${String(b.settings?.hour ?? 9).padStart(2, "0")}:${String(b.settings?.minute ?? 0).padStart(2, "0")}`;
  return (
    <div className="card brief-card">
      <div className="report-head">
        <h2 className="section-title">Morning brief</h2>
        <div className="row-actions">
          <button className="btn small" onClick={() => setOpen(!open)}>
            {open ? "Hide" : "Read it"}
          </button>
          {can(me, "settings:write") && (
            <button className="btn small" disabled={busy} onClick={send}>
              Send to WhatsApp now
            </button>
          )}
        </div>
      </div>
      <p>{b.headline}</p>
      <p className="muted small-text">{b.sent ? `Sent ${when(b.sent.at)}: ${b.sent.results.map((row) => SENT[row.sent] || row.sent).join(", ") || "no numbers"}.` : b.settings?.enabled ? `Goes out at ${at}.` : "Not switched on: Settings > Morning brief."}</p>
      {open && <Rich text={b.text} />}
      <Notice>{error}</Notice>
      <Notice tone="ok">{done}</Notice>
    </div>
  );
}

export function BriefForm({ settings, canWrite, onSaved }: { settings: Settings; canWrite: boolean; onSaved: () => void }) {
  const initial = () => ({
    enabled: settings.brief?.enabled ?? false,
    time: `${String(settings.brief?.hour ?? 9).padStart(2, "0")}:${String(settings.brief?.minute ?? 0).padStart(2, "0")}`,
    phones: (settings.brief?.phones || []).join(", "),
    template: settings.brief?.template?.name || "",
    language: settings.brief?.template?.language || "en",
  });
  const [form, setForm] = useState(initial);
  useEffect(() => setForm(initial()), [settings]); // eslint-disable-line react-hooks/exhaustive-deps
  const { busy, error, run } = useRun();
  const [saved, setSaved] = useState("");
  const save = () =>
    run(async () => {
      const [hour, minute] = form.time.split(":").map(Number);
      await api("/api/settings", { method: "PATCH", body: { brief: { enabled: form.enabled, hour, minute, phones: form.phones.split(",").map((value) => value.trim()).filter(Boolean), template: { name: form.template.trim(), language: form.language.trim() || "en" } } } });
      setSaved("Saved.");
      onSaved();
    });
  return (
    <form className="card form-card" onSubmit={(event) => (event.preventDefault(), save())}>
      <h2>Morning brief</h2>
      <p className="muted small-text">
        Yesterday's sales, today's work, what is running out, birthdays, buying dates and alerts, on WhatsApp every morning. If the owner has not written to the shop's number in 24 hours, WhatsApp only allows an approved template: make a Utility template with two blanks (the date, the headline), for example "Good morning! {"{{1}}"}: {"{{2}}"}. Reply BRIEF for the full brief." Replying BRIEF any time sends the full brief.
      </p>
      <fieldset disabled={!canWrite}>
        <label className="check">
          <input type="checkbox" checked={form.enabled} onChange={(event) => setForm({ ...form, enabled: event.target.checked })} /> Send it every morning
        </label>
        <div className="form-grid">
          <div className="field">
            <label htmlFor="br-time">At (India time, 05:00 to 12:59)</label>
            <input id="br-time" className="input" type="time" min="05:00" max="12:59" value={form.time} onChange={(event) => setForm({ ...form, time: event.target.value })} />
          </div>
          <div className="field span-2">
            <label htmlFor="br-phones">Owner mobiles (comma between)</label>
            <input id="br-phones" className="input" inputMode="tel" value={form.phones} onChange={(event) => setForm({ ...form, phones: event.target.value })} />
          </div>
          <div className="field">
            <label htmlFor="br-tpl">Template name</label>
            <input id="br-tpl" className="input" value={form.template} onChange={(event) => setForm({ ...form, template: event.target.value })} placeholder="morning_brief" />
          </div>
          <div className="field">
            <label htmlFor="br-lang">Language</label>
            <input id="br-lang" className="input" value={form.language} onChange={(event) => setForm({ ...form, language: event.target.value })} />
          </div>
        </div>
      </fieldset>
      <Notice>{error}</Notice>
      <Notice tone="ok">{saved}</Notice>
      {canWrite && (
        <button className="btn primary" disabled={busy}>
          Save morning brief
        </button>
      )}
    </form>
  );
}
