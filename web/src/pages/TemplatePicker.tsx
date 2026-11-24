import { useEffect, useState } from "react";
import { api, ApiError, type Template } from "../api";

type Send = (template: { name: string; language: string; params: string[] }) => Promise<void>;

/** Choose an approved template, fill its blanks, see exactly what the customer will get, send. */
export function TemplatePicker({ customerName, onClose, onSend }: { customerName: string; onClose: () => void; onSend: Send }) {
  const [templates, setTemplates] = useState<Template[] | null>(null);
  const [chosen, setChosen] = useState<Template | null>(null);
  const [params, setParams] = useState<string[]>([]);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api<{ data: Template[] }>("/api/templates")
      .then((result) => setTemplates(result.data.filter((template) => template.status === "APPROVED")))
      .catch((caught) => setError(caught instanceof ApiError ? caught.message : "Could not load templates."));
  }, []);

  useEffect(() => {
    const onKey = (event: globalThis.KeyboardEvent) => event.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  function choose(template: Template) {
    setChosen(template);
    // The first blank is usually the customer's name.
    setParams(Array.from({ length: template.paramCount }, (_, index) => (index === 0 ? customerName : "")));
  }

  const preview = chosen ? chosen.bodyText.replace(/\{\{\s*(\d+)\s*\}\}/g, (_, n) => params[Number(n) - 1] || `{{${n}}}`) : "";
  const complete = chosen && params.every((value) => value.trim());

  async function send() {
    if (!chosen || !complete) return;
    setBusy(true);
    setError("");
    try {
      await onSend({ name: chosen.name, language: chosen.language, params: params.map((value) => value.trim()) });
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : "Could not send.");
      setBusy(false);
    }
  }

  return (
    <div className="dialog-backdrop" onClick={onClose}>
      <div className="dialog" role="dialog" aria-modal="true" aria-label="Send a template" onClick={(event) => event.stopPropagation()}>
        <h2>Send a template</h2>
        {error && <div className="notice error">{error}</div>}
        {templates === null && !error && <p className="muted">Loading…</p>}
        {templates?.length === 0 && <p className="muted">No approved templates yet. The owner can copy them from Meta on the Templates page.</p>}
        {!chosen &&
          templates?.map((template) => (
            <button key={`${template.name}-${template.language}`} className="template-option" onClick={() => choose(template)}>
              <strong>{template.name}</strong> <span className="badge">{template.language}</span> <span className="badge">{template.category}</span>
              <div className="muted" style={{ marginTop: 4 }}>{template.bodyText}</div>
            </button>
          ))}
        {chosen && (
          <>
            {params.map((value, index) => (
              <div className="field" key={index}>
                <label htmlFor={`param-${index}`}>Blank {index + 1}</label>
                <input
                  id={`param-${index}`}
                  className="input"
                  value={value}
                  onChange={(event) => setParams((current) => current.map((item, position) => (position === index ? event.target.value : item)))}
                />
              </div>
            ))}
            <div className="muted" style={{ fontSize: 12, marginBottom: 4 }}>The customer will receive:</div>
            <div className="preview-box">{preview}</div>
          </>
        )}
        <div className="actions">
          {chosen && (
            <button className="btn" onClick={() => setChosen(null)}>
              Back
            </button>
          )}
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          {chosen && (
            <button className="btn primary" onClick={send} disabled={!complete || busy}>
              {busy ? "Sending…" : "Send"}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
