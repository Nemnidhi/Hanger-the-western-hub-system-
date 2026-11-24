import { useState, type FormEvent } from "react";
import { api, ApiError, type Me } from "../api";
import { roleLabel } from "../format";

export function Account({ me }: { me: Me }) {
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [repeat, setRepeat] = useState("");
  const [notice, setNotice] = useState<{ kind: "ok" | "error"; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const mismatch = repeat.length > 0 && next !== repeat;

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (mismatch) return;
    setBusy(true);
    setNotice(null);
    try {
      await api("/api/auth/password", { method: "POST", body: { currentPassword: current, newPassword: next } });
      setNotice({ kind: "ok", text: "Password changed. You were signed out on every other device." });
      setCurrent("");
      setNext("");
      setRepeat("");
    } catch (error) {
      setNotice({ kind: "error", text: error instanceof ApiError ? error.message : "Could not change the password." });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="page" style={{ maxWidth: 520 }}>
      <h1>My account</h1>
      <p>
        <strong>{me.user.name}</strong> · {me.user.email} · {roleLabel[me.user.role]}
        <br />
        <span className="muted">Two-step login: {me.user.twoFactorEnabled ? "on" : "off"}</span>
      </p>
      <h2 style={{ fontSize: 16, margin: "24px 0 12px" }}>Change password</h2>
      {notice && <div className={`notice ${notice.kind}`} role="status">{notice.text}</div>}
      <form onSubmit={submit}>
        <div className="field">
          <label htmlFor="cur">Current password</label>
          <input id="cur" className="input" type="password" autoComplete="current-password" value={current} onChange={(event) => setCurrent(event.target.value)} required />
        </div>
        <div className="field">
          <label htmlFor="nw">New password (at least 10 characters)</label>
          <input id="nw" className="input" type="password" autoComplete="new-password" value={next} onChange={(event) => setNext(event.target.value)} required minLength={10} />
        </div>
        <div className="field">
          <label htmlFor="rp">New password again</label>
          <input id="rp" className="input" type="password" autoComplete="new-password" value={repeat} onChange={(event) => setRepeat(event.target.value)} required />
          {mismatch && <span className="muted">The two passwords are different.</span>}
        </div>
        <button className="btn primary" disabled={busy || mismatch}>
          {busy ? "Saving…" : "Change password"}
        </button>
      </form>
    </div>
  );
}
