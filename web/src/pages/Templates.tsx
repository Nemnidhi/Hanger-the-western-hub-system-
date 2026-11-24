import { useCallback, useEffect, useState } from "react";
import { api, ApiError, can, type Me, type Template } from "../api";

const STATUS_CLASS: Record<string, string> = { APPROVED: "accent", PENDING: "warn", IN_APPEAL: "warn", REJECTED: "danger", PAUSED: "danger", DISABLED: "danger" };

export function Templates({ me }: { me: Me }) {
  const [templates, setTemplates] = useState<Template[]>([]);
  const [canSync, setCanSync] = useState(false);
  const [notice, setNotice] = useState<{ kind: "ok" | "error"; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const result = await api<{ data: Template[]; canSync: boolean }>("/api/templates");
      setTemplates(result.data);
      setCanSync(result.canSync);
    } catch (error) {
      setNotice({ kind: "error", text: error instanceof ApiError ? error.message : "Could not load templates." });
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  async function sync() {
    setBusy(true);
    setNotice(null);
    try {
      await api("/api/templates/sync", { method: "POST", body: {} });
      setNotice({ kind: "ok", text: "Copying templates from Meta. This page refreshes in a few seconds." });
      window.setTimeout(load, 4000);
    } catch (error) {
      setNotice({ kind: "error", text: error instanceof ApiError ? error.message : "Could not start the copy." });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="page">
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12, marginBottom: 16, flexWrap: "wrap" }}>
        <h1 style={{ margin: 0 }}>Templates</h1>
        {can(me, "templates:sync") && (
          <button className="btn primary" onClick={sync} disabled={busy || !canSync} title={canSync ? "" : "The server needs the WhatsApp Business Account id"}>
            Copy from Meta
          </button>
        )}
      </div>
      <p className="muted" style={{ marginTop: 0 }}>
        Approved templates are the only messages WhatsApp allows more than 24 hours after a customer's last message. They are created and approved in Meta's
        WhatsApp Manager; Meta's decisions show here automatically.
      </p>
      {notice && <div className={`notice ${notice.kind}`}>{notice.text}</div>}
      {templates.length === 0 ? (
        <div className="empty" style={{ height: "auto" }}>No templates yet.</div>
      ) : (
        <table className="table">
          <thead>
            <tr>
              <th>Name</th>
              <th>Status</th>
              <th>Kind</th>
              <th>Message</th>
            </tr>
          </thead>
          <tbody>
            {templates.map((template) => (
              <tr key={`${template.name}-${template.language}`}>
                <td>
                  <strong>{template.name}</strong>
                  <div className="muted">{template.language}</div>
                </td>
                <td>
                  <span className={`badge ${STATUS_CLASS[template.status] || ""}`}>{template.status.toLowerCase()}</span>
                  {template.rejectedReason && <div className="muted" style={{ fontSize: 12 }}>{template.rejectedReason}</div>}
                </td>
                <td>{template.category.toLowerCase()}</td>
                <td style={{ whiteSpace: "pre-wrap" }}>{template.bodyText}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
