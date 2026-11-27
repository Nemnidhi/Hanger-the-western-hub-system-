"use client";

import Link from "next/link";
import { useParams, useSearchParams } from "next/navigation";
import { Suspense, useCallback, useEffect, useState } from "react";
import { errorText, shop } from "@/lib/client";
import { rupees } from "@/lib/format";
import type { CustomerOrder } from "@/lib/types";

function OrderView() {
  const { id } = useParams<{ id: string }>();
  const placed = useSearchParams().get("placed") === "1";
  const [order, setOrder] = useState<CustomerOrder | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const load = useCallback(
    () =>
      shop<{ order: CustomerOrder }>(`/orders/${id}`)
        .then((result) => (setOrder(result.order), setError("")))
        .catch((failure) => setError(errorText(failure))),
    [id],
  );
  useEffect(() => {
    load();
  }, [load]);

  // Waiting for the payment link, or for the payment itself: check again every few seconds.
  useEffect(() => {
    if (!order || order.status !== "awaiting_payment") return;
    const timer = window.setInterval(load, order.payment.url ? 8000 : 2500);
    return () => window.clearInterval(timer);
  }, [order, load]);

  const act = async (action: "confirm-cod" | "pay-online" | "cancel") => {
    setBusy(true);
    setError("");
    try {
      const result = await shop<{ order: CustomerOrder }>(`/orders/${id}/${action}`, { method: "POST", body: {} });
      setOrder(result.order);
    } catch (failure) {
      setError(errorText(failure));
    } finally {
      setBusy(false);
    }
  };

  if (error && !order)
    return (
      <div className="wrap empty">
        <p>{error}</p>
        <Link className="btn dark" href="/account">
          Your account
        </Link>
      </div>
    );
  if (!order) return <div className="wrap empty">Loading your order…</div>;
  const waiting = ["awaiting_payment", "awaiting_confirmation"].includes(order.status);

  return (
    <div className="wrap narrow" style={{ paddingBottom: 70 }}>
      <div className="shop-head">
        <div className="eyebrow">Order {order.label}</div>
        <h1>{placed && order.status === "confirmed" ? <>Thank you. <em>It&apos;s yours.</em></> : order.statusWords}</h1>
      </div>
      <div style={{ display: "grid", gap: 20, marginTop: 22 }}>
        {order.status === "awaiting_payment" && (
          <section className="panel">
            <h2>Pay {rupees(order.totalPaise)}</h2>
            {order.payment.url ? (
              <>
                <p className="muted" style={{ margin: 0 }}>Your pieces are held for you while you pay. The same link is on your WhatsApp.</p>
                <a className="btn wine block" href={order.payment.url}>
                  Pay securely on Razorpay
                </a>
              </>
            ) : (
              <p className="muted" style={{ margin: 0 }}>Making your payment link…</p>
            )}
          </section>
        )}
        {order.cod?.needsConfirm && (
          <section className="panel">
            <h2>Confirm cash on delivery</h2>
            <p className="muted" style={{ margin: 0 }}>Please confirm you will be there to pay {rupees(order.totalPaise)} when it arrives. Or pay online now and it ships first.</p>
            <button className="btn wine block" disabled={busy} onClick={() => act("confirm-cod")}>
              Yes, confirm my order
            </button>
            <button className="btn ghost block" disabled={busy} onClick={() => act("pay-online")}>
              Pay online instead
            </button>
          </section>
        )}
        {order.cod?.prepayOnly && (
          <section className="panel">
            <h2>Pay online to complete</h2>
            <p className="muted" style={{ margin: 0 }}>Cash on delivery is not available for this order. Pay online and we ship it right away.</p>
            <button className="btn wine block" disabled={busy} onClick={() => act("pay-online")}>
              Pay online
            </button>
          </section>
        )}
        {order.status === "confirmed" && <div className="notice ok">Confirmed. We are packing it and will send the tracking link on WhatsApp.</div>}
        {order.shipment.awb && (
          <section className="panel">
            <h2>Tracking</h2>
            <p style={{ margin: 0 }}>
              {order.shipment.courier} · {order.shipment.awb}
            </p>
            {order.shipment.trackingUrl && (
              <a className="btn ghost" href={order.shipment.trackingUrl} target="_blank" rel="noopener">
                Track it
              </a>
            )}
          </section>
        )}
        {error && <div className="notice">{error}</div>}
        <section className="panel">
          <h2>What you ordered</h2>
          <div className="sum">
            {order.lines.map((line) => (
              <div key={line.skuCode}>
                <Link href={`/p/${line.slug}`}>
                  {line.name} · {line.size} × {line.qty}
                </Link>
                <span>{rupees(line.unitPaise * line.qty)}</span>
              </div>
            ))}
            {order.discount?.code && (
              <div className="off">
                <span>Code {order.discount.code}</span>
                <span>included</span>
              </div>
            )}
            {order.discount?.pointsUsed ? (
              <div className="off">
                <span>{order.discount.pointsUsed} points</span>
                <span>included</span>
              </div>
            ) : null}
            <div className="total">
              <span>{order.payment.method === "cod" ? "To pay on delivery" : "Total"}</span>
              <span>{rupees(order.totalPaise)}</span>
            </div>
          </div>
          <p className="small muted" style={{ margin: 0 }}>
            To {order.shipTo.name}, {order.shipTo.address} {order.shipTo.pincode}
          </p>
        </section>
        {waiting && (
          <button className="link small" disabled={busy} onClick={() => act("cancel")} style={{ justifySelf: "start" }}>
            Cancel this order
          </button>
        )}
        <Link className="btn ghost" href="/account">
          All your orders
        </Link>
      </div>
    </div>
  );
}

export default function OrderPage() {
  return (
    <Suspense fallback={<div className="wrap empty">Loading your order…</div>}>
      <OrderView />
    </Suspense>
  );
}
