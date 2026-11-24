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
import { Stock } from "./pages/Stock";
import { Templates } from "./pages/Templates";
import { SettingsPage } from "./pages/SettingsPage";
import { Team } from "./pages/Team";
import { Account } from "./pages/Account";
import { InvoicePrint } from "./pages/InvoicePrint";

type Page = "today" | "inbox" | "orders" | "counter" | "trial" | "catalogue" | "stock" | "templates" | "settings" | "team" | "account";
const PAGES: Page[] = ["today", "inbox", "orders", "counter", "trial", "catalogue", "stock", "templates", "settings", "team", "account"];

function readHash(): { page: Page; invoiceId: string } {
  const [first, second] = window.location.hash.replace(/^#\/?/, "").split("/");
  if (first === "invoice" && /^[0-9a-f]{24}$/.test(second || "")) return { page: "today", invoiceId: second };
  return { page: (PAGES.includes(first as Page) ? first : "today") as Page, invoiceId: "" };
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

  async function signOut() {
    await api("/api/auth/logout", { method: "POST", body: {} }).catch(() => undefined);
    setMe(null);
  }

  const links: { id: Page; label: string; show: boolean }[] = [
    { id: "today", label: "Today", show: can(me, "orders:read") },
    { id: "inbox", label: "Chats", show: can(me, "inbox:read") },
    { id: "orders", label: "Orders", show: can(me, "orders:read") },
    { id: "counter", label: "Counter", show: can(me, "orders:write") },
    { id: "trial", label: "Trial room", show: can(me, "catalog:read") },
    { id: "catalogue", label: "Catalogue", show: can(me, "catalog:read") },
    { id: "stock", label: "Stock", show: can(me, "stock:read") },
    { id: "templates", label: "Templates", show: can(me, "templates:read") },
    { id: "settings", label: "Settings", show: can(me, "settings:read") },
    { id: "team", label: "Team", show: can(me, "users:manage") },
    { id: "account", label: "My account", show: true },
  ];
  const visible = links.filter((link) => link.show);
  const current = visible.some((link) => link.id === route.page) ? route.page : visible[0].id;
  const fullHeight = current === "inbox" || current === "orders";

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
        {current === "stock" && <Stock me={me} />}
        {current === "templates" && <Templates me={me} />}
        {current === "settings" && <SettingsPage me={me} />}
        {current === "team" && <Team me={me} />}
        {current === "account" && <Account me={me} />}
      </main>
    </div>
  );
}
