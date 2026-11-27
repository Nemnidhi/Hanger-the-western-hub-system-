"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { errorText, shop } from "@/lib/client";
import { rupees } from "@/lib/format";
import type { Account, CustomerOrder } from "@/lib/types";
import { SignIn } from "@/components/SignIn";

const DONE = ["delivered", "returned"];

export default function AccountPage() {
  const [account, setAccount] = useState<Account | null | undefined>(undefined);
  const [orders, setOrders] = useState<CustomerOrder[]>([]);
  const [form, setForm] = useState({ name: "", usualSize: "", offers: false });
  const [saved, setSaved] = useState("");
  const [error, setError] = useState("");
  const [copied, setCopied] = useState("");

  useEffect(() => {
    shop<{ account: Account | null }>("/me").then((result) => setAccount(result.account)).catch(() => setAccount(null));
  }, []);
  useEffect(() => {
    if (!account) return;
    setForm({ name: account.name, usualSize: account.usualSize, offers: account.offers });
    shop<{ orders: CustomerOrder[] }>("/orders").then((result) => setOrders(result.orders)).catch(() => setOrders([]));
  }, [account]);

  if (account === undefined) return <div className="wrap empty">Loading…</div>;
  if (!account)
    return (
      <div className="wrap narrow" style={{ padding: "40px 16px 70px" }}>
        <SignIn onSignedIn={setAccount} title="Your account" />
      </div>
    );

  const save = async () => {
    setError("");
    try {
      const result = await shop<{ account: Account }>("/me", { method: "PATCH", body: form });
      setAccount(result.account);
      setSaved("Saved.");
    } catch (failure) {
      setError(errorText(failure));
    }
  };
  const signOut = async () => {
    await shop("/logout", { method: "POST", body: {} }).catch(() => undefined);
    setAccount(null);
  };
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(account.referralCode);
      setCopied("Copied.");
    } catch {
      setCopied("Select the code to copy it.");
    }
  };

  return (
    <div className="wrap">
      <div className="shop-head">
        <div className="eyebrow">Members&apos; circle · {account.tier.name}</div>
        <h1>
          Hello{account.name ? <>, <em>{account.name.split(" ")[0]}</em></> : ""}
        </h1>
      </div>
      <div className="two-col">
        <div style={{ display: "grid", gap: 20, minWidth: 0 }}>
          <section className="panel">
            <div className="stat-row">
              <div className="stat">
                <b>{account.points}</b>
                <span className="small muted">points · worth {rupees(account.points * account.pointValuePaise)}</span>
              </div>
              <div className="stat">
                <b>{account.tier.name}</b>
                <span className="small muted">{account.tier.next ? `${rupees(account.tier.next.needPaise)} more to ${account.tier.next.name}` : "the top tier"}</span>
              </div>
              <div className="stat">
                <b>{rupees(account.spendPaise)}</b>
                <span className="small muted">kept in 12 months</span>
              </div>
            </div>
            {account.tier.perk && <p className="small" style={{ margin: 0 }}>Your perk: {account.tier.perk}</p>}
          </section>

          <section className="panel">
            <h2>Your orders</h2>
            {!orders.length && <p className="muted">No orders yet.</p>}
            {orders.map((order) => (
              <Link key={order._id} className="order-row" href={`/account/orders/${order._id}`}>
                <span>
                  <b>{order.label}</b>
                  <br />
                  <span className="small muted">
                    {new Date(order.placedAt).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" })} · {order.lines.reduce((sum, line) => sum + line.qty, 0)} piece(s)
                  </span>
                </span>
                <span style={{ textAlign: "right" }}>
                  <span className={`status-pill${DONE.includes(order.status) ? " done" : ""}`}>{order.statusWords}</span>
                  <br />
                  <b>{rupees(order.totalPaise)}</b>
                </span>
              </Link>
            ))}
          </section>
        </div>

        <aside style={{ display: "grid", gap: 20, minWidth: 0 }}>
          {account.referralCode && (
            <section className="panel">
              <h2>Your code for friends</h2>
              <p className="small muted" style={{ margin: 0 }}>
                A friend gets a discount on her first order with it, and you get points when she keeps it.
              </p>
              <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
                <span className="code-box">{account.referralCode}</span>
                <button className="btn ghost small" onClick={copy}>
                  Copy
                </button>
                {copied && <span className="small muted">{copied}</span>}
              </div>
            </section>
          )}
          <form className="panel" onSubmit={(event) => (event.preventDefault(), save())}>
            <h2>About you</h2>
            <div className="field">
              <label htmlFor="name">Name</label>
              <input id="name" className="input" value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} />
            </div>
            <div className="field">
              <label htmlFor="size">Your usual size</label>
              <input id="size" className="input" value={form.usualSize} onChange={(event) => setForm({ ...form, usualSize: event.target.value.toUpperCase() })} placeholder="S, M, L…" maxLength={12} />
            </div>
            <label className="check">
              <input type="checkbox" checked={form.offers} onChange={(event) => setForm({ ...form, offers: event.target.checked })} />
              <span>New arrivals and members&apos; offers on WhatsApp</span>
            </label>
            <button className="btn dark">Save</button>
            {saved && <div className="notice ok">{saved}</div>}
            {error && <div className="notice">{error}</div>}
            <p className="small muted" style={{ margin: 0 }}>
              Signed in as +{account.phone}.{" "}
              <button type="button" className="link small" onClick={signOut}>
                Sign out
              </button>
            </p>
          </form>
        </aside>
      </div>
    </div>
  );
}
