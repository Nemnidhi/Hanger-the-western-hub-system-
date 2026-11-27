import { useCallback, useEffect, useState } from "react";
import { api, ApiError, can, type Me } from "./api";
import { roleLabel } from "./format";
import { SignIn } from "./pages/SignIn";
import { Today } from "./pages/Today";
import { Inbox } from "./pages/Inbox";
import { Orders } from "./pages/Orders";
import { Counter } from "./pages/Counter";
import { TrialRoom } from "./pages/TrialRoom";
import { Catalogue } from "./pages/Catalogue";
import { Studio } from "./pages/Studio";
import { Stock } from "./pages/Stock";
import { Reports } from "./pages/Reports";
import { Broadcasts } from "./pages/Broadcasts";
import { Customers } from "./pages/Customers";
import { Buying } from "./pages/Buying";
import { Templates } from "./pages/Templates";
import { SettingsPage } from "./pages/SettingsPage";
import { Team } from "./pages/Team";
import { Account } from "./pages/Account";
import { InvoicePrint } from "./pages/InvoicePrint";
import { Challan } from "./pages/Challan";
import { Ads } from "./pages/Ads";
import { Instagram } from "./pages/Instagram";

type Page = "today" | "inbox" | "instagram" | "orders" | "counter" | "trial" | "catalogue" | "studio" | "stock" | "reports" | "ads" | "buying" | "customers" | "broadcasts" | "templates" | "settings" | "team" | "account";
const PAGES: Page[] = ["today", "inbox", "instagram", "orders", "counter", "trial", "catalogue", "studio", "stock", "reports", "ads", "buying", "customers", "broadcasts", "templates", "settings", "team", "account"];

function readHash(): { page: Page; invoiceId: string; challanId: string } {
  const [first, second] = window.location.hash.replace(/^#\/?/, "").split("/");
  if (first === "invoice" && /^[0-9a-f]{24}$/.test(second || "")) return { page: "today", invoiceId: second, challanId: "" };
  if (first === "challan" && /^[0-9a-f]{24}$/.test(second || "")) return { page: "stock", invoiceId: "", challanId: second };
  return { page: (PAGES.includes(first as Page) ? first : "today") as Page, invoiceId: "", challanId: "" };
}

export function App() {
  const [me, setMe] = useState<Me | null>(null);
  const [loading, setLoading] = useState(true);
  const [route, setRoute] = useState(readHash);

  const loadMe = useCallback(async () => {
    try {
      setMe(await api<Me>("/api/auth/me"));
    } catch (error) {
      if (!(error instanceof ApiError) || error.status === 401) setMe(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadMe();
    const onHash = () => setRoute(readHash());
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, [loadMe]);

  // Any request answered "please sign in" (session ended elsewhere) returns to the sign-in screen.
  useEffect(() => {
    const onExpired = () => setMe(null);
    window.addEventListener("session-expired", onExpired);
    return () => window.removeEventListener("session-expired", onExpired);
  }, []);

  if (loading) return <div className="empty">Loading…</div>;
  if (!me || me.next) return <SignIn me={me} onSignedIn={setMe} />;
  if (route.invoiceId) return <InvoicePrint id={route.invoiceId} />;
  if (route.challanId) return <Challan id={route.challanId} me={me} />;

  async function signOut() {
    await api("/api/auth/logout", { method: "POST", body: {} }).catch(() => undefined);
    setMe(null);
  }

  const links: { id: Page; label: string; show: boolean }[] = [
    { id: "today", label: "Today", show: can(me, "orders:read") },
    { id: "inbox", label: "Chats", show: can(me, "inbox:read") },
    { id: "instagram", label: "Instagram", show: can(me, "inbox:read") },
    { id: "orders", label: "Orders", show: can(me, "orders:read") },
    { id: "counter", label: "Counter", show: can(me, "orders:write") },
    { id: "trial", label: "Trial room", show: can(me, "catalog:read") },
    { id: "catalogue", label: "Catalogue", show: can(me, "catalog:read") },
    { id: "studio", label: "Photo studio", show: can(me, "catalog:write") || can(me, "studio:use") },
    { id: "stock", label: "Stock", show: can(me, "stock:read") },
    { id: "reports", label: "Reports", show: can(me, "reports:read") },
    { id: "ads", label: "Ads", show: can(me, "reports:read") },
    { id: "buying", label: "Buying", show: can(me, "reports:read") },
    { id: "customers", label: "Customers", show: can(me, "orders:read") },
    { id: "broadcasts", label: "Broadcasts", show: can(me, "broadcasts:send") },
    { id: "templates", label: "Templates", show: can(me, "templates:read") },
    { id: "settings", label: "Settings", show: can(me, "settings:read") },
    { id: "team", label: "Team", show: can(me, "users:manage") },
    { id: "account", label: "My account", show: true },
  ];
  const visible = links.filter((link) => link.show);
  const current = visible.some((link) => link.id === route.page) ? route.page : visible[0].id;
  const fullHeight = current === "inbox" || current === "orders" || current === "instagram";

  return (
    <div className="shell">
      <nav className="nav" aria-label="Main">
        <div className="brand">
          The Hanger<span className="muted"> · staff</span>
        </div>
        {visible.map((link) => (
          <a key={link.id} href={`#${link.id}`} className={current === link.id ? "active" : ""} aria-current={current === link.id ? "page" : undefined}>
            {link.label}
          </a>
        ))}
        <div className="spacer" />
        <div className="who">
          <div>{me.user.name}</div>
          <div className="muted">{roleLabel[me.user.role]}</div>
        </div>
        <button className="btn small" onClick={signOut}>
          Sign out
        </button>
      </nav>
      <main style={{ minHeight: 0, overflow: fullHeight ? "hidden" : "auto" }}>
        {current === "today" && <Today me={me} />}
        {current === "inbox" && <Inbox me={me} />}
        {current === "orders" && <Orders me={me} />}
        {current === "counter" && <Counter />}
        {current === "trial" && <TrialRoom me={me} />}
        {current === "catalogue" && <Catalogue me={me} />}
        {current === "studio" && <Studio me={me} />}
        {current === "stock" && <Stock me={me} />}
        {current === "reports" && <Reports />}
        {current === "ads" && <Ads />}
        {current === "instagram" && <Instagram me={me} />}
        {current === "buying" && <Buying me={me} />}
        {current === "customers" && <Customers me={me} />}
        {current === "broadcasts" && <Broadcasts />}
        {current === "templates" && <Templates me={me} />}
        {current === "settings" && <SettingsPage me={me} />}
        {current === "team" && <Team me={me} />}
        {current === "account" && <Account me={me} />}
      </main>
    </div>
  );
}
