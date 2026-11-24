import { can, type Me } from "../api";
import { rupees } from "../format";
import { useLive } from "../live";
import { useLoad, Notice } from "../ui";
import type { Summary } from "../types";

// The day at a glance: what is waiting for someone, and today's sales.
export function Today({ me }: { me: Me }) {
  const { data, error, reload } = useLoad<Summary>("/api/summary");
  useLive(["order"], reload, reload);
  const count = (...statuses: (keyof Summary["byStatus"])[]) => statuses.reduce((total, status) => total + (data?.byStatus[status] || 0), 0);

  const todo = [
    { label: "COD orders to confirm", hint: "Medium-risk cash on delivery: call or message first", n: count("awaiting_confirmation"), href: "#orders/list/awaiting_confirmation", tone: "warn" },
    { label: "To pack", hint: "Confirmed and invoiced", n: count("confirmed"), href: "#orders/list/confirmed", tone: "accent" },
    { label: "Packed, to ship", hint: "Book the courier and add the tracking number", n: count("packed"), href: "#orders/list/packed", tone: "accent" },
    { label: "On the way", hint: "Mark delivered or came back", n: count("shipped"), href: "#orders/list/shipped", tone: "" },
    { label: "Carts waiting", hint: "Customer still to send address or pay", n: count("draft", "awaiting_payment"), href: "#orders/list/open", tone: "" },
  ];

  return (
    <div className="page">
      <h1>Today</h1>
      <Notice>{error}</Notice>
      {data && (
        <>
          <div className="stats">
            <div className="stat">
              <div className="muted">Store sales today</div>
              <div className="stat-value">{rupees(data.today.storePaise)}</div>
            </div>
            <div className="stat">
              <div className="muted">Online sales today</div>
              <div className="stat-value">{rupees(data.today.onlinePaise)}</div>
            </div>
            <div className="stat">
              <div className="muted">Returns and cancellations</div>
              <div className="stat-value">{rupees(data.today.returnsPaise)}</div>
            </div>
            <div className="stat">
              <div className="muted">Invoices today</div>
              <div className="stat-value">{data.today.invoices}</div>
            </div>
          </div>

          {data.needsState > 0 && (
            <Notice tone="warn">
              {data.needsState} confirmed order{data.needsState > 1 ? "s need" : " needs"} the delivery state checked before the invoice can be made.{" "}
              <a href="#orders/list/confirmed">Open orders</a>
            </Notice>
          )}

          <h2 className="section-title">Waiting for someone</h2>
          <div className="todo-grid">
            {todo.map((item) => (
              <a key={item.label} className={`todo ${item.n ? item.tone : "quiet"}`} href={item.href}>
                <span className="todo-n">{item.n}</span>
                <span>
                  <strong>{item.label}</strong>
                  <span className="muted small-text">{item.hint}</span>
                </span>
              </a>
            ))}
          </div>

          <div className="quick-links">
            {can(me, "orders:write") && (
              <a className="btn primary" href="#counter">
                New counter sale
              </a>
            )}
            {can(me, "stock:write") && (
              <a className="btn" href="#stock">
                Receive stock
              </a>
            )}
            {data.lowStock > 0 && can(me, "stock:read") && (
              <a className="btn" href="#catalogue/low">
                {data.lowStock} size{data.lowStock > 1 ? "s" : ""} down to the last piece
              </a>
            )}
          </div>
        </>
      )}
    </div>
  );
}
