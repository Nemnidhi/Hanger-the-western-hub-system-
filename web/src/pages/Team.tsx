import { useCallback, useEffect, useState, type FormEvent } from "react";
import { api, ApiError, type Me, type Role, type User } from "../api";
import { roleLabel, shortTime } from "../format";

const ROLES: Role[] = ["owner", "manager", "staff", "packer"];

export function Team({ me }: { me: Me }) {
  const [users, setUsers] = useState<User[]>([]);
  const [error, setError] = useState("");
  const [adding, setAdding] = useState(false);
  const [secret, setSecret] = useState<{ who: string; password: string } | null>(null);

  const load = useCallback(async () => {
    try {
      setUsers((await api<{ data: User[] }>("/api/users")).data);
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : "Could not load the team.");
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  async function act(task: () => Promise<void>) {
    setError("");
    try {
      await task();
      await load();
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : "Could not save.");
    }
  }

  return (
    <div className="page">
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12, marginBottom: 16 }}>
        <h1 style={{ margin: 0 }}>Team</h1>
        <button className="btn primary" onClick={() => setAdding(true)}>
          Add a person
        </button>
      </div>
      {error && <div className="notice error" role="alert">{error}</div>}
      {secret && (
        <div className="notice ok" role="status">
          Temporary password for {secret.who}: <strong className="secret" style={{ padding: "1px 6px" }}>{secret.password}</strong>. Give it to them in person or by phone;
          it is shown only now, and they must change it at first sign-in.{" "}
          <button className="btn link" onClick={() => setSecret(null)}>
            Done
          </button>
        </div>
      )}
      <table className="table">
        <thead>
          <tr>
            <th>Name</th>
            <th>Role</th>
            <th>Two-step login</th>
            <th>Last sign-in</th>
            <th>Actions</th>
          </tr>
        </thead>
        <tbody>
          {users.map((user) => (
            <tr key={user.id}>
              <td>
                <strong>{user.name}</strong>
                {user.id === me.user.id && <span className="muted"> (you)</span>}
                <div className="muted">{user.email}</div>
                {user.status === "disabled" && <span className="badge danger">disabled</span>}
              </td>
              <td>
                <select className="input" style={{ width: "auto" }} value={user.role} onChange={(event) => act(async () => void (await api(`/api/users/${user.id}`, { method: "PATCH", body: { role: event.target.value } })))} aria-label={`Role of ${user.name}`}>
                  {ROLES.map((role) => (
                    <option key={role} value={role}>
                      {roleLabel[role]}
                    </option>
                  ))}
                </select>
              </td>
              <td>{user.twoFactorEnabled ? <span className="badge accent">on</span> : <span className="badge">off</span>}</td>
              <td className="muted">{user.lastLoginAt ? shortTime(user.lastLoginAt) : "never"}</td>
              <td>
                <div className="row-actions">
                  {user.id !== me.user.id && (
                    <button
                      className={`btn small ${user.status === "active" ? "danger" : ""}`}
                      onClick={() => act(async () => void (await api(`/api/users/${user.id}`, { method: "PATCH", body: { status: user.status === "active" ? "disabled" : "active" } })))}
                    >
                      {user.status === "active" ? "Disable" : "Enable"}
                    </button>
                  )}
                  <button
                    className="btn small"
                    onClick={() =>
                      window.confirm(`Give ${user.name} a new temporary password? They will be signed out everywhere.`) &&
                      act(async () => {
                        const result = await api<{ temporaryPassword: string }>(`/api/users/${user.id}/reset-password`, { method: "POST", body: {} });
                        setSecret({ who: user.name, password: result.temporaryPassword });
                      })
                    }
                  >
                    New password
                  </button>
                  {user.twoFactorEnabled && (
                    <button
                      className="btn small"
                      onClick={() =>
                        window.confirm(`Reset two-step login for ${user.name}? Use this when they lost their phone; they set it up again at next sign-in.`) &&
                        act(async () => void (await api(`/api/users/${user.id}/reset-two-factor`, { method: "POST", body: {} })))
                      }
                    >
                      Reset two-step
                    </button>
                  )}
                </div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {adding && (
        <AddPerson
          onClose={() => setAdding(false)}
          onAdded={(who, password) => {
            setAdding(false);
            setSecret({ who, password });
            load();
          }}
        />
      )}
    </div>
  );
}

function AddPerson({ onClose, onAdded }: { onClose: () => void; onAdded: (who: string, password: string) => void }) {
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");
  const [role, setRole] = useState<Role>("staff");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      const result = await api<{ temporaryPassword: string }>("/api/users", { method: "POST", body: { name, email, phone, role } });
      onAdded(name, result.temporaryPassword);
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : "Could not add.");
      setBusy(false);
    }
  }

  return (
    <div className="dialog-backdrop" onClick={onClose}>
      <form className="dialog" role="dialog" aria-modal="true" aria-label="Add a person" onClick={(event) => event.stopPropagation()} onSubmit={submit}>
        <h2>Add a person</h2>
        {error && <div className="notice error">{error}</div>}
        <div className="field">
          <label htmlFor="add-name">Name</label>
          <input id="add-name" className="input" value={name} onChange={(event) => setName(event.target.value)} required autoFocus />
        </div>
        <div className="field">
          <label htmlFor="add-email">Email (used to sign in)</label>
          <input id="add-email" className="input" type="email" value={email} onChange={(event) => setEmail(event.target.value)} required />
        </div>
        <div className="field">
          <label htmlFor="add-phone">Mobile (optional)</label>
          <input id="add-phone" className="input" value={phone} onChange={(event) => setPhone(event.target.value)} />
        </div>
        <div className="field">
          <label htmlFor="add-role">Role</label>
          <select id="add-role" className="input" value={role} onChange={(event) => setRole(event.target.value as Role)}>
            {ROLES.map((item) => (
              <option key={item} value={item}>
                {roleLabel[item]}
              </option>
            ))}
          </select>
          <span className="muted" style={{ fontSize: 12 }}>
            Owners and managers must use two-step login. Store staff sell and chat; packers see orders to pack and ship.
          </span>
        </div>
        <div className="actions">
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn primary" disabled={busy}>
            {busy ? "Adding…" : "Add"}
          </button>
        </div>
      </form>
    </div>
  );
}
