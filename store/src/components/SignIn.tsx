"use client";

import { useState } from "react";
import { errorText, shop } from "@/lib/client";
import type { Account } from "@/lib/types";

/** Sign in with a 6-digit code sent to her WhatsApp. No passwords. */
export function SignIn({ onSignedIn, title = "Sign in with WhatsApp" }: { onSignedIn: (account: Account) => void; title?: string }) {
  const [phone, setPhone] = useState("");
  const [code, setCode] = useState("");
  const [offers, setOffers] = useState(false);
  const [sent, setSent] = useState(false);
  const [devCode, setDevCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const ask = async () => {
    setBusy(true);
    setError("");
    try {
      const result = await shop<{ sent: boolean; devCode?: string }>("/login/code", { method: "POST", body: { phone } });
      setSent(true);
      setDevCode(result.devCode || "");
    } catch (failure) {
      setError(errorText(failure));
    } finally {
      setBusy(false);
    }
  };
  const verify = async () => {
    setBusy(true);
    setError("");
    try {
      const result = await shop<{ account: Account }>("/login/verify", { method: "POST", body: { phone, code, offers } });
      onSignedIn(result.account);
    } catch (failure) {
      setError(errorText(failure));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="panel">
      <h2>{title}</h2>
      <p className="muted small" style={{ margin: 0 }}>
        We send a 6-digit code to your WhatsApp. Your number is also how we send order updates and how you earn points.
      </p>
      {!sent ? (
        <form onSubmit={(event) => (event.preventDefault(), ask())} style={{ display: "grid", gap: 12 }}>
          <div className="field">
            <label htmlFor="phone">WhatsApp number</label>
            <div className="inline">
              <span className="input" style={{ flex: "none", width: "auto" }} aria-hidden="true">
                +91
              </span>
              <input id="phone" className="input" inputMode="tel" autoComplete="tel-national" required value={phone} onChange={(event) => setPhone(event.target.value)} placeholder="98765 43210" />
            </div>
          </div>
          <button className="btn dark block" disabled={busy || phone.replace(/\D/g, "").length < 10}>
            {busy ? "Sending…" : "Send my code"}
          </button>
        </form>
      ) : (
        <form onSubmit={(event) => (event.preventDefault(), verify())} style={{ display: "grid", gap: 12 }}>
          <div className="field">
            <label htmlFor="code">The code on your WhatsApp</label>
            <input id="code" className="input" inputMode="numeric" autoComplete="one-time-code" maxLength={6} required value={code} onChange={(event) => setCode(event.target.value.replace(/\D/g, ""))} placeholder="6 digits" style={{ letterSpacing: "0.3em", fontSize: 20 }} />
          </div>
          {devCode && <div className="notice warn">Test mode: no WhatsApp is connected, so the code is {devCode}.</div>}
          <label className="check">
            <input type="checkbox" checked={offers} onChange={(event) => setOffers(event.target.checked)} />
            <span>Send me new arrivals and members&apos; offers on WhatsApp (a few a month; reply STOP any time).</span>
          </label>
          <button className="btn dark block" disabled={busy || code.length !== 6}>
            {busy ? "Checking…" : "Sign in"}
          </button>
          <button type="button" className="link small" onClick={() => (setSent(false), setCode(""))}>
            Change number or send again
          </button>
        </form>
      )}
      {error && <div className="notice">{error}</div>}
    </div>
  );
}
