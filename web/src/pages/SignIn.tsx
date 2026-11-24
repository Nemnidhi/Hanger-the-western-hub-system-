import { useEffect, useState, type FormEvent } from "react";
import QRCode from "qrcode";
import { api, ApiError, type Me } from "../api";

function useSubmit() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function run(task: () => Promise<void>) {
    setBusy(true);
    setError("");
    try {
      await task();
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : "Something went wrong. Please try again.");
    } finally {
      setBusy(false);
    }
  }
  return { busy, error, run };
}

/** Sign-in and every step after it: authenticator code, new password, two-step login setup. */
export function SignIn({ me, onSignedIn }: { me: Me | null; onSignedIn: (me: Me | null) => void }) {
  return (
    <div className="auth-page">
      <div className="auth-card">
        {!me && <PasswordStep onDone={onSignedIn} />}
        {me?.next === "two_factor" && <CodeStep onDone={onSignedIn} />}
        {me?.next === "change_password" && <ChangePasswordStep onDone={onSignedIn} />}
        {me?.next === "two_factor_setup" && <SetupStep me={me} onDone={onSignedIn} />}
      </div>
    </div>
  );
}

function PasswordStep({ onDone }: { onDone: (me: Me) => void }) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const { busy, error, run } = useSubmit();
  const submit = (event: FormEvent) => {
    event.preventDefault();
    run(async () => onDone(await api<Me>("/api/auth/login", { method: "POST", body: { email, password } })));
  };
  return (
    <form onSubmit={submit}>
      <h1>Sign in</h1>
      <p className="muted">The Hanger, for the store's team.</p>
      {error && <div className="notice error" role="alert">{error}</div>}
      <div className="field">
        <label htmlFor="email">Email</label>
        <input id="email" className="input" type="email" autoComplete="username" value={email} onChange={(event) => setEmail(event.target.value)} required autoFocus />
      </div>
      <div className="field">
        <label htmlFor="password">Password</label>
        <input id="password" className="input" type="password" autoComplete="current-password" value={password} onChange={(event) => setPassword(event.target.value)} required />
      </div>
      <button className="btn primary" style={{ width: "100%" }} disabled={busy}>
        {busy ? "Signing in…" : "Sign in"}
      </button>
    </form>
  );
}

function CodeStep({ onDone }: { onDone: (me: Me) => void }) {
  const [code, setCode] = useState("");
  const [recovery, setRecovery] = useState(false);
  const { busy, error, run } = useSubmit();
  const submit = (event: FormEvent) => {
    event.preventDefault();
    run(async () => onDone(await api<Me>(recovery ? "/api/auth/2fa/recovery" : "/api/auth/2fa/verify", { method: "POST", body: { code } })));
  };
  return (
    <form onSubmit={submit}>
      <h1>Two-step login</h1>
      <p className="muted">{recovery ? "Enter one of your recovery codes. Each works only once." : "Enter the 6-digit code from your authenticator app."}</p>
      {error && <div className="notice error" role="alert">{error}</div>}
      <div className="field">
        <label htmlFor="code">{recovery ? "Recovery code" : "Code"}</label>
        <input
          id="code"
          className="input"
          inputMode={recovery ? "text" : "numeric"}
          autoComplete="one-time-code"
          value={code}
          onChange={(event) => setCode(event.target.value)}
          required
          autoFocus
        />
      </div>
      <button className="btn primary" style={{ width: "100%" }} disabled={busy}>
        {busy ? "Checking…" : "Continue"}
      </button>
      <p style={{ marginTop: 14 }}>
        <button type="button" className="btn link" onClick={() => setRecovery(!recovery)}>
          {recovery ? "Use the authenticator app instead" : "Lost your phone? Use a recovery code"}
        </button>
      </p>
    </form>
  );
}

function ChangePasswordStep({ onDone }: { onDone: (me: Me) => void }) {
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [repeat, setRepeat] = useState("");
  const { busy, error, run } = useSubmit();
  const mismatch = repeat.length > 0 && next !== repeat;
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (mismatch) return;
    run(async () => onDone(await api<Me>("/api/auth/password", { method: "POST", body: { currentPassword: current, newPassword: next } })));
  };
  return (
    <form onSubmit={submit}>
      <h1>Choose your password</h1>
      <p className="muted">Replace the temporary password you were given. Use at least 10 characters.</p>
      {error && <div className="notice error" role="alert">{error}</div>}
      <div className="field">
        <label htmlFor="current">Temporary password</label>
        <input id="current" className="input" type="password" autoComplete="current-password" value={current} onChange={(event) => setCurrent(event.target.value)} required autoFocus />
      </div>
      <div className="field">
        <label htmlFor="new">New password</label>
        <input id="new" className="input" type="password" autoComplete="new-password" value={next} onChange={(event) => setNext(event.target.value)} required minLength={10} />
      </div>
      <div className="field">
        <label htmlFor="repeat">New password again</label>
        <input id="repeat" className="input" type="password" autoComplete="new-password" value={repeat} onChange={(event) => setRepeat(event.target.value)} required />
        {mismatch && <span className="muted">The two passwords are different.</span>}
      </div>
      <button className="btn primary" style={{ width: "100%" }} disabled={busy || mismatch}>
        {busy ? "Saving…" : "Save password"}
      </button>
    </form>
  );
}

function SetupStep({ me, onDone }: { me: Me; onDone: (me: Me) => void }) {
  const [setup, setSetup] = useState<{ secret: string; qr: string } | null>(null);
  const [code, setCode] = useState("");
  const [result, setResult] = useState<(Me & { recoveryCodes: string[] }) | null>(null);
  const [saved, setSaved] = useState(false);
  const { busy, error, run } = useSubmit();

  useEffect(() => {
    run(async () => {
      const data = await api<{ secret: string; otpauthUrl: string }>("/api/auth/2fa/setup", { method: "POST", body: {} });
      setSetup({ secret: data.secret, qr: await QRCode.toDataURL(data.otpauthUrl, { margin: 0, width: 180 }) });
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (result) {
    return (
      <div>
        <h1>Save your recovery codes</h1>
        <p className="muted">If you lose your phone, each code lets you sign in once. They are shown only now: write them down or print them, and keep them safe.</p>
        <div className="codes">
          {result.recoveryCodes.map((item) => (
            <span key={item}>{item}</span>
          ))}
        </div>
        <label style={{ display: "flex", gap: 8, marginBottom: 14 }}>
          <input type="checkbox" checked={saved} onChange={(event) => setSaved(event.target.checked)} /> I have saved these codes.
        </label>
        <button className="btn primary" style={{ width: "100%" }} disabled={!saved} onClick={() => onDone({ user: result.user, next: result.next, permissions: result.permissions })}>
          Continue
        </button>
      </div>
    );
  }

  const submit = (event: FormEvent) => {
    event.preventDefault();
    run(async () => setResult(await api<Me & { recoveryCodes: string[] }>("/api/auth/2fa/enable", { method: "POST", body: { code } })));
  };
  return (
    <form onSubmit={submit}>
      <h1>Turn on two-step login</h1>
      <p className="muted">
        {me.user.role === "owner" ? "Owners" : "Pharmacists"} see customers' health information, so a code from your phone is needed at each sign-in. Install Google Authenticator,
        Microsoft Authenticator or Authy, then scan this code.
      </p>
      {error && <div className="notice error" role="alert">{error}</div>}
      {setup ? (
        <>
          <img className="qr" src={setup.qr} alt="QR code for your authenticator app" />
          <p className="muted" style={{ marginBottom: 6 }}>Can't scan? Type this key into the app:</p>
          <div className="secret" style={{ marginBottom: 14 }}>{setup.secret}</div>
          <div className="field">
            <label htmlFor="setup-code">6-digit code from the app</label>
            <input id="setup-code" className="input" inputMode="numeric" autoComplete="one-time-code" value={code} onChange={(event) => setCode(event.target.value)} required />
          </div>
          <button className="btn primary" style={{ width: "100%" }} disabled={busy}>
            {busy ? "Checking…" : "Turn on"}
          </button>
        </>
      ) : (
        !error && <p className="muted">Preparing…</p>
      )}
    </form>
  );
}
