import { useEffect, useState } from "react";
import { api, can, type Me } from "../api";
import { phone, rupees, when } from "../format";
import { useLive } from "../live";
import { Dialog, Notice, useLoad, useRun } from "../ui";
import { CHANNEL_LABEL, GST_STATES, PAYMENT_LABEL, STATUS_LABEL, STATUS_TONE, type CourierRate, type Invoice, type Order } from "../types";

// Orders: a list by what needs doing (left) and the open order with its next step (right).
// Hash routes: #orders/list/<filter> and #orders/<id>.

const FILTERS: { id: string; label: string }[] = [
  { id: "to_ship", label: "To pack & ship" },
  { id: "awaiting_confirmation", label: "COD to confirm" },
  { id: "open", label: "Carts" },
  { id: "shipped", label: "On the way" },
  { id: "done", label: "Done" },
  { id: "all", label: "All" },
];

function readHash(): { filter: string; orderId: string } {
  const parts = window.location.hash.replace(/^#\/?/, "").split("/");
  if (parts[1] === "list") return { filter: parts[2] || "to_ship", orderId: "" };
  return { filter: sessionStorage.getItem("orders-filter") || "to_ship", orderId: /^[0-9a-f]{24}$/.test(parts[1] || "") ? parts[1] : "" };
}

export function Orders({ me }: { me: Me }) {
  const [{ filter, orderId }, setRoute] = useState(readHash);
  const [q, setQ] = useState("");
  const [search, setSearch] = useState("");

  useEffect(() => {
    const onHash = () => setRoute(readHash());
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);
  useEffect(() => {
    try {
      sessionStorage.setItem("orders-filter", filter);
    } catch {
      /* private window */
    }
  }, [filter]);
  useEffect(() => {
    const timer = setTimeout(() => setSearch(q.trim()), 300);
    return () => clearTimeout(timer);
  }, [q]);

  const params = new URLSearchParams();
  if (filter !== "all") params.set("status", filter);
  if (search) params.set("q", search);
  const list = useLoad<{ prefix: string; orders: Order[] }>(`/api/orders?${params}`);
  const detail = useLoad<{ order: Order; invoices: Invoice[]; courierReady: boolean }>(orderId ? `/api/orders/${orderId}` : null);
  useLive(
    ["order"],
    (_type, data) => {
      list.reload();
      if (data.orderId === orderId) detail.reload();
    },
    () => {
      list.reload();
      detail.reload();
    },
  );
  const prefix = list.data?.prefix || "";

  return (
    <div className={`split${orderId ? " has-detail" : ""}`}>
      <section className="split-list" aria-label="Orders">
        <div className="filters">
          <div className="chips" role="tablist">
            {FILTERS.map((item) => (
              <a key={item.id} role="tab" aria-selected={filter === item.id} className={`chip${filter === item.id ? " on" : ""}`} href={`#orders/list/${item.id}`}>
                {item.label}
              </a>
            ))}
          </div>
          <input className="input" type="search" placeholder="Order number, phone or name" value={q} onChange={(event) => setQ(event.target.value)} aria-label="Search orders" />
        </div>
        <Notice>{list.error}</Notice>
        <div className="rows">
          {list.data?.orders.map((order) => (
            <a key={order._id} href={`#orders/${order._id}`} className={`order-row${order._id === orderId ? " active" : ""}`}>
              <div className="order-row-top">
                <strong>
                  {prefix}-{order.number}
                </strong>
                <span className={`badge ${STATUS_TONE[order.status] || ""}`}>{STATUS_LABEL[order.status]}</span>
              </div>
              <div className="order-row-mid">
                <span>{order.shipTo?.name || order.customer?.name || (order.channel === "store" ? "Walk-in" : phone(order.customer?.phone))}</span>
                <span>{rupees(order.totals.totalPaise)}</span>
              </div>
              <div className="muted small-text">
                {CHANNEL_LABEL[order.channel]} · {PAYMENT_LABEL[order.payment.method]} · {order.lines.reduce((total, line) => total + line.qty, 0)} pc · {when(order.createdAt)}
              </div>
            </a>
          ))}
          {list.data && !list.data.orders.length && <div className="empty">No orders here.</div>}
        </div>
      </section>
      <section className="split-detail" aria-label="Order">
        {!orderId && <div className="empty">Pick an order.</div>}
        {orderId && detail.error && <Notice>{detail.error}</Notice>}
        {orderId && detail.data && <OrderDetail me={me} prefix={prefix} order={detail.data.order} invoices={detail.data.invoices} courierReady={detail.data.courierReady} onChanged={() => (detail.reload(), list.reload())} />}
      </section>
    </div>
  );
}

type Ask = null | "cancel" | "ship" | "rto" | "return" | "book" | "cancel-courier";

function OrderDetail({ me, prefix, order, invoices, courierReady, onChanged }: { me: Me; prefix: string; order: Order; invoices: Invoice[]; courierReady: boolean; onChanged: () => void }) {
  const { busy, error, run } = useRun();
  const [ask, setAsk] = useState<Ask>(null);
  const pieces = order.lines.reduce((total, line) => total + line.qty, 0);
  const canWrite = can(me, "orders:write");
  const canFulfil = can(me, "orders:fulfil");

  const act = (action: string, body: Record<string, unknown> = {}) =>
    run(async () => {
      await api(`/api/orders/${order._id}/${action}`, { method: "POST", body });
      setAsk(null);
      onChanged();
    });

  return (
    <div className="page detail">
      <a className="btn small back-button" href="#orders">
        ← Orders
      </a>
      <div className="detail-head">
        <div>
          <h1>
            {prefix}-{order.number}
          </h1>
          <div className="muted">
            {CHANNEL_LABEL[order.channel]} · {when(order.createdAt)} · {pieces} piece{pieces > 1 ? "s" : ""}
          </div>
        </div>
        <span className={`badge big ${STATUS_TONE[order.status] || ""}`}>{STATUS_LABEL[order.status]}</span>
      </div>
      <Notice>{error}</Notice>

      <NextStep order={order} busy={busy} canWrite={canWrite} canFulfil={canFulfil} courierReady={courierReady} act={act} setAsk={setAsk} />

      <div className="cards">
        <div className="card">
          <h3>Items</h3>
          <table className="table plain">
            <tbody>
              {order.lines.map((line) => (
                <tr key={line.skuCode}>
                  <td>
                    {line.name}
                    <div className="muted small-text">
                      {line.skuCode} · size {line.size} · GST {line.gstRate}%
                    </div>
                  </td>
                  <td className="num">×{line.qty}</td>
                  <td className="num">{rupees(line.unitPaise * line.qty)}</td>
                </tr>
              ))}
              <tr>
                <td>
                  <strong>Total</strong> <span className="muted small-text">incl. GST</span>
                </td>
                <td />
                <td className="num">
                  <strong>{rupees(order.totals.totalPaise)}</strong>
                </td>
              </tr>
            </tbody>
          </table>
        </div>

        <div className="card">
          <h3>Customer</h3>
          <p>
            {order.shipTo?.name || order.customer.name || "—"}
            {order.customer.phone && (
              <>
                <br />
                <span className="muted">{phone(order.customer.phone)}</span>
              </>
            )}
          </p>
          {order.shipTo?.address && (
            <p className="pre">
              {order.shipTo.address}
              <br />
              <span className="muted">
                {order.shipTo.pincode} · {order.shipTo.state || "state not known"}
                {!order.shipTo.stateSure && " (check)"}
              </span>
            </p>
          )}
          {order.conversationId && can(me, "inbox:read") && (
            <a className="btn small" href={`#inbox/${order.conversationId}`}>
              Open chat
            </a>
          )}
        </div>

        <div className="card">
          <h3>Payment</h3>
          <p>
            {PAYMENT_LABEL[order.payment.method]} · {order.payment.status === "paid" ? "paid" : order.payment.status === "pending" ? "waiting" : order.payment.method === "cod" ? "collect at delivery" : "—"}
          </p>
          {order.payment.method === "cod" && order.cod.score !== null && (
            <div className={`risk ${order.cod.band}`}>
              <div>
                COD risk <strong>{order.cod.score.toFixed(2)}</strong> · {order.cod.band}
              </div>
              <div className="risk-bar" aria-hidden="true">
                <span style={{ width: `${Math.round(order.cod.score * 100)}%` }} />
              </div>
              <ul>
                {order.cod.reasons.map((reason) => (
                  <li key={reason}>{reason}</li>
                ))}
              </ul>
            </div>
          )}
          {order.payment.url && order.payment.status !== "paid" && (
            <p className="muted small-text">
              Payment link: <a href={order.payment.url} target="_blank" rel="noreferrer">{order.payment.url}</a>
            </p>
          )}
        </div>

        {(order.shipment.courier || order.shipment.providerOrderId || invoices.length > 0) && (
          <div className="card">
            <h3>Invoice and shipping</h3>
            {invoices.map((invoice) => (
              <p key={invoice._id}>
                <a href={`#invoice/${invoice._id}`} target="_blank" rel="noreferrer">
                  {invoice.kind === "invoice" ? "Invoice" : "Credit note"} {invoice.number}
                </a>{" "}
                <span className="muted">
                  {rupees(invoice.totals.totalPaise)} · {invoice.interState ? "IGST" : "CGST + SGST"}
                </span>
              </p>
            ))}
            {order.shipment.courier && <Shipment order={order} />}
          </div>
        )}
      </div>

      {order.history && (
        <div className="card">
          <h3>History</h3>
          <ol className="history">
            {[...order.history].reverse().map((entry, index) => (
              <li key={index}>
                <span className="muted small-text">{when(entry.at)}</span> <strong>{entry.event.replace(/_/g, " ")}</strong>
                {entry.note && <> · {entry.note}</>} <span className="muted small-text">by {entry.by}</span>
              </li>
            ))}
          </ol>
        </div>
      )}

      {ask === "cancel" && <AskDialog title="Cancel this order" label="Why?" placeholder="Customer called to cancel" busy={busy} onClose={() => setAsk(null)} onSubmit={(reason) => act("cancel", { reason })} note={order.invoiceId ? "Stock goes back on the shelf and a credit note is made. Refund an online payment in Razorpay." : "The held stock is released."} />}
      {ask === "return" && <AskDialog title="Mark returned" label="Why did it come back?" placeholder="Too small" busy={busy} onClose={() => setAsk(null)} onSubmit={(reason) => act("return", { reason })} note="The pieces go back into stock and a credit note is made. Refund the customer in Razorpay or by UPI." />}
      {ask === "rto" && <AskDialog title="Came back undelivered (RTO)" label="Note (optional)" placeholder="Customer refused" optional busy={busy} onClose={() => setAsk(null)} onSubmit={(note) => act("rto", { note })} note="Counts against the customer's and the pincode's COD record." />}
      {ask === "ship" && <ShipDialog busy={busy} onClose={() => setAsk(null)} onSubmit={(courier, awb) => act("ship", { courier, awb })} />}
      {ask === "book" && <BookCourierDialog order={order} onClose={() => setAsk(null)} onBooked={() => (setAsk(null), onChanged())} />}
      {ask === "cancel-courier" && (
        <Dialog title="Cancel the courier booking" onClose={() => setAsk(null)}>
          <p>
            {order.shipment.courier} · {order.shipment.awb} is cancelled at Shiprocket and the pickup is called off. The order stays packed, ready to book again.
          </p>
          <div className="actions">
            <button type="button" className="btn" onClick={() => setAsk(null)}>
              Back
            </button>
            <button className="btn danger" disabled={busy} onClick={() => act("cancel-courier")}>
              Cancel booking
            </button>
          </div>
        </Dialog>
      )}
    </div>
  );
}

function NextStep({ order, busy, canWrite, canFulfil, courierReady, act, setAsk }: { order: Order; busy: boolean; canWrite: boolean; canFulfil: boolean; courierReady: boolean; act: (action: string, body?: Record<string, unknown>) => void; setAsk: (value: Ask) => void }) {
  const [stateCode, setStateCode] = useState(order.shipTo?.stateCode || "");
  const booked = Boolean(order.shipment.providerOrderId);
  // A booked courier is cancelled first (the server refuses otherwise).
  const cancel = canWrite && !booked && !["shipped", "delivered", "rto", "returned", "cancelled"].includes(order.status) && (
    <button className="btn danger" disabled={busy} onClick={() => setAsk("cancel")}>
      Cancel order
    </button>
  );

  let main: React.ReactNode = null;
  let text = "";
  if (order.status === "draft") text = "Waiting for the customer to send the delivery address in the chat.";
  if (order.status === "awaiting_payment") text = `Waiting for the online payment${order.holdUntil ? `; the stock is held until ${when(order.holdUntil)}` : ""}.`;
  if (order.status === "awaiting_confirmation") {
    text = order.cod.band === "high" ? "High COD risk: the customer was asked to pay online. Confirm COD only if you have spoken to them." : "Medium COD risk: call or message the customer, then confirm.";
    main = canWrite && (
      <button className="btn primary" disabled={busy} onClick={() => act("confirm")}>
        Confirm cash on delivery
      </button>
    );
  }
  if (order.status === "confirmed" && !order.invoiceId) {
    text = "The pincode could belong to two states. Pick the delivery state so the GST invoice can be made.";
    main = canWrite && (
      <span className="inline-form">
        <select className="input" value={stateCode} onChange={(event) => setStateCode(event.target.value)} aria-label="Delivery state">
          <option value="">Choose state</option>
          {Object.entries(GST_STATES).map(([code, name]) => (
            <option key={code} value={code}>
              {name}
            </option>
          ))}
        </select>
        <button className="btn primary" disabled={busy || !stateCode} onClick={() => act("state", { stateCode })}>
          Set state and make invoice
        </button>
      </span>
    );
  } else if (order.status === "confirmed") {
    text = "Print the invoice, pack the pieces with it, then mark packed.";
    main = canFulfil && (
      <>
        <a className="btn" href={`#invoice/${order.invoiceId}`} target="_blank" rel="noreferrer">
          Print invoice
        </a>
        <button className="btn primary" disabled={busy} onClick={() => act("pack")}>
          Mark packed
        </button>
      </>
    );
  }
  if (order.status === "packed" && booked) {
    const { shipment } = order;
    text = shipment.awb
      ? `Courier booked: ${shipment.courier}, AWB ${shipment.awb}${shipment.pickupNote ? ` (${shipment.pickupNote})` : ""}. Print the label and stick it on the parcel. The order moves to Shipped by itself when the courier collects it.`
      : "The booking stopped half-way. Book again to finish it.";
    main = canFulfil && (
      <>
        {shipment.awb && shipment.labelUrl && (
          <a className="btn primary" href={shipment.labelUrl} target="_blank" rel="noreferrer">
            Print label
          </a>
        )}
        {shipment.awb && !shipment.labelUrl && (
          <button className="btn primary" disabled={busy} onClick={() => act("courier-label")}>
            Get label
          </button>
        )}
        {!shipment.awb && (
          <button className="btn primary" disabled={busy} onClick={() => setAsk("book")}>
            Book courier
          </button>
        )}
        {shipment.awb && (
          <button className="btn" disabled={busy} onClick={() => act("ship", { courier: shipment.courier, awb: shipment.awb })} title="Use this if the courier collected it and the tracking has not caught up yet">
            Handed to courier
          </button>
        )}
        <button className="btn danger" disabled={busy} onClick={() => setAsk("cancel-courier")}>
          Cancel booking
        </button>
      </>
    );
  } else if (order.status === "packed") {
    text = courierReady ? "Book the courier: pick one by price and speed, print the label, and the customer gets the tracking link on WhatsApp." : "Book the courier, then add the tracking number. The customer gets it on WhatsApp.";
    main = canFulfil && (
      <>
        {courierReady && (
          <button className="btn primary" disabled={busy} onClick={() => setAsk("book")}>
            Book courier
          </button>
        )}
        <button className={courierReady ? "btn" : "btn primary"} disabled={busy} onClick={() => setAsk("ship")}>
          {courierReady ? "Add tracking by hand" : "Add tracking and ship"}
        </button>
      </>
    );
  }
  if (order.status === "shipped") {
    text = order.shipment.rtoStartedAt
      ? "The courier is bringing it back (RTO). It is restocked when it arrives."
      : order.shipment.provider
        ? `On the way${order.shipment.trackingStatus ? `: ${order.shipment.trackingStatus.toLowerCase()}` : ""}. Delivery and returns are recorded from the courier's tracking.`
        : "On the way.";
    main = canFulfil && (
      <>
        <button className="btn primary" disabled={busy} onClick={() => act("deliver")}>
          Mark delivered
        </button>
        <button className="btn" disabled={busy} onClick={() => setAsk("rto")}>
          Came back (RTO)
        </button>
      </>
    );
  }
  if (order.status === "delivered" && order.channel !== "store") {
    text = "Delivered.";
    main = canWrite && (
      <button className="btn" disabled={busy} onClick={() => setAsk("return")}>
        Customer returned it
      </button>
    );
  }
  if (order.status === "delivered" && order.channel === "store") text = "Sold at the counter.";
  if (order.status === "cancelled") text = `Cancelled${order.cancelReason ? `: ${order.cancelReason}` : ""}.`;
  if (order.status === "rto") text = "Came back undelivered; the stock is back on the shelf.";
  if (order.status === "returned") text = "Returned; the stock is back on the shelf.";

  return (
    <div className="next-step">
      <p>{text}</p>
      <div className="row-actions">
        {main}
        {cancel}
      </div>
    </div>
  );
}

function AskDialog({ title, label, placeholder, note, optional = false, busy, onClose, onSubmit }: { title: string; label: string; placeholder: string; note: string; optional?: boolean; busy: boolean; onClose: () => void; onSubmit: (value: string) => void }) {
  const [value, setValue] = useState("");
  return (
    <Dialog title={title} onClose={onClose}>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          onSubmit(value.trim());
        }}
      >
        <div className="field">
          <label htmlFor="ask-value">{label}</label>
          <input id="ask-value" className="input" autoFocus value={value} placeholder={placeholder} onChange={(event) => setValue(event.target.value)} />
        </div>
        <p className="muted small-text">{note}</p>
        <div className="actions">
          <button type="button" className="btn" onClick={onClose}>
            Back
          </button>
          <button className="btn primary" disabled={busy || (!optional && value.trim().length < 2)}>
            {title.split(" ")[0] === "Cancel" ? "Cancel order" : "Save"}
          </button>
        </div>
      </form>
    </Dialog>
  );
}

const COURIERS = ["Delhivery", "Shiprocket", "Blue Dart", "DTDC", "Xpressbees", "India Post", "Ekart", "Local delivery"];

function ShipDialog({ busy, onClose, onSubmit }: { busy: boolean; onClose: () => void; onSubmit: (courier: string, awb: string) => void }) {
  const [courier, setCourier] = useState(() => {
    try {
      return localStorage.getItem("last-courier") || COURIERS[0];
    } catch {
      return COURIERS[0];
    }
  });
  const [awb, setAwb] = useState("");
  return (
    <Dialog title="Ship the order" onClose={onClose}>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          try {
            localStorage.setItem("last-courier", courier);
          } catch {
            /* private window */
          }
          onSubmit(courier, awb.trim());
        }}
      >
        <div className="field">
          <label htmlFor="courier">Courier</label>
          <input id="courier" className="input" list="couriers" value={courier} onChange={(event) => setCourier(event.target.value)} />
          <datalist id="couriers">
            {COURIERS.map((name) => (
              <option key={name} value={name} />
            ))}
          </datalist>
        </div>
        <div className="field">
          <label htmlFor="awb">Tracking (AWB) number</label>
          <input id="awb" className="input" autoFocus value={awb} onChange={(event) => setAwb(event.target.value)} />
        </div>
        <div className="actions">
          <button type="button" className="btn" onClick={onClose}>
            Back
          </button>
          <button className="btn primary" disabled={busy || courier.trim().length < 2 || awb.trim().length < 4}>
            Mark shipped
          </button>
        </div>
      </form>
    </Dialog>
  );
}

/** The courier, tracking number, label and the courier's latest scans. */
function Shipment({ order }: { order: Order }) {
  const { shipment } = order;
  const [all, setAll] = useState(false);
  const events = shipment.events || [];
  return (
    <div className="shipment">
      <p>
        {shipment.courier} · <strong>{shipment.awb}</strong>
        {shipment.provider === "shiprocket" && shipment.awb && (
          <>
            {" "}
            <a className="small-text" href={`https://shiprocket.co/tracking/${encodeURIComponent(shipment.awb)}`} target="_blank" rel="noreferrer">
              tracking page
            </a>
          </>
        )}
        <br />
        <span className="muted small-text">
          {shipment.shippedAt ? `shipped ${when(shipment.shippedAt)}` : shipment.bookedAt ? `booked ${when(shipment.bookedAt)}` : ""}
          {shipment.chargePaise ? ` · courier charge ${rupees(shipment.chargePaise)}` : ""}
          {shipment.weightGrams ? ` · ${(shipment.weightGrams / 1000).toFixed(2)} kg` : ""}
        </span>
      </p>
      {shipment.trackingStatus && shipment.provider && (
        <p className="small-text">
          Courier says: <strong>{shipment.trackingStatus}</strong>
          {shipment.trackedAt && <span className="muted"> · {when(shipment.trackedAt)}</span>}
        </p>
      )}
      {shipment.labelUrl && (
        <p className="small-text">
          <a href={shipment.labelUrl} target="_blank" rel="noreferrer">
            Shipping label (PDF)
          </a>
        </p>
      )}
      {events.length > 0 && (
        <>
          <ol className="scans">
            {(all ? events : events.slice(0, 3)).map((event, index) => (
              <li key={index}>
                <span className="muted small-text">{when(event.at)}</span> {event.activity || event.status}
                {event.location && <span className="muted small-text"> · {event.location}</span>}
              </li>
            ))}
          </ol>
          {events.length > 3 && (
            <button type="button" className="btn small" onClick={() => setAll(!all)}>
              {all ? "Fewer scans" : `All ${events.length} scans`}
            </button>
          )}
        </>
      )}
    </div>
  );
}

/** Rates from every courier that serves the pincode, for the parcel's weight; book one. */
function BookCourierDialog({ order, onClose, onBooked }: { order: Order; onClose: () => void; onBooked: () => void }) {
  const [grams, setGrams] = useState("");
  const [query, setQuery] = useState("");
  const rates = useLoad<{ rates: CourierRate[]; weightGrams: number; cod: boolean }>(`/api/orders/${order._id}/courier-rates${query}`);
  const [chosen, setChosen] = useState<number | null>(null);
  const { busy, error, run } = useRun();
  useEffect(() => {
    if (!rates.data) return;
    if (!grams) setGrams(String(rates.data.weightGrams));
    const list = rates.data.rates;
    if (!list.some((rate) => rate.courierId === chosen)) setChosen((list.find((rate) => rate.recommended) || list[0])?.courierId ?? null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rates.data]);
  const weightOk = Number(grams) >= 50 && Number(grams) <= 30000;
  const stale = rates.data && Number(grams) !== rates.data.weightGrams;

  const book = () =>
    run(async () => {
      await api(`/api/orders/${order._id}/book-courier`, { method: "POST", body: { courierId: chosen, weightGrams: Number(grams) } });
      onBooked();
    });

  return (
    <Dialog title="Book a courier" onClose={onClose} wide>
      <form onSubmit={(event) => (event.preventDefault(), weightOk && setQuery(`?weight=${Math.round(Number(grams))}`))} className="inline-form weight-row">
        <div className="field">
          <label htmlFor="weight">Parcel weight (grams, with the packing)</label>
          <input id="weight" className="input" type="number" min={50} max={30000} step={50} value={grams} onChange={(event) => setGrams(event.target.value)} />
        </div>
        <button className="btn" disabled={!weightOk || !stale}>
          Check rates
        </button>
      </form>
      <p className="muted small-text">
        To {order.shipTo.pincode} · {rates.data?.cod ? `cash on delivery: collect ${rupees(order.totals.totalPaise)}` : "prepaid"}
      </p>
      <Notice>{rates.error}</Notice>
      {!rates.data && !rates.error && <p className="muted">Asking the couriers…</p>}
      {rates.data && !rates.data.rates.length && <Notice tone="warn">No courier serves this pincode{rates.data.cod ? " for cash on delivery" : ""}. Ask the customer to pay online, or ship it another way and add the tracking by hand.</Notice>}
      {rates.data && rates.data.rates.length > 0 && (
        <div className="rates" role="radiogroup" aria-label="Courier">
          {rates.data.rates.map((rate) => (
            <label key={rate.courierId} className={`rate ${chosen === rate.courierId ? "chosen" : ""}`}>
              <input type="radio" name="courier" checked={chosen === rate.courierId} onChange={() => setChosen(rate.courierId)} />
              <span className="rate-name">
                {rate.name}
                {rate.recommended && <span className="badge ok">recommended</span>}
                <span className="muted small-text">
                  {rate.days ? `${rate.days} day${rate.days === "1" ? "" : "s"}` : "delivery time not given"}
                  {rate.rating !== null ? ` · rated ${rate.rating.toFixed(1)}` : ""}
                  {rate.surface ? " · surface" : " · air"}
                </span>
              </span>
              <span className="rate-price">
                {rupees(rate.ratePaise)}
                {rate.codChargePaise > 0 && <span className="muted small-text">incl. COD {rupees(rate.codChargePaise)}</span>}
              </span>
            </label>
          ))}
        </div>
      )}
      <Notice>{error}</Notice>
      {stale && <Notice tone="warn">The weight changed: check the rates again before booking.</Notice>}
      <div className="actions">
        <button type="button" className="btn" onClick={onClose}>
          Back
        </button>
        <button className="btn primary" disabled={busy || !chosen || Boolean(stale) || !rates.data?.rates.length} onClick={book}>
          {busy ? "Booking…" : "Book and get label"}
        </button>
      </div>
    </Dialog>
  );
}
