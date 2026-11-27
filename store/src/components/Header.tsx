"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { useBag } from "@/lib/bag";

const NAV = [
  { href: "/shop?sort=new", label: "New in" },
  { href: "/shop", label: "Shop all" },
  { href: "/shop?category=dresses", label: "Dresses" },
  { href: "/shop?sale=1", label: "Sale" },
];

export function Header({ brand }: { brand: string }) {
  const { count, ready } = useBag();
  const [menu, setMenu] = useState(false);
  const [searching, setSearching] = useState(false);
  const [q, setQ] = useState("");
  const router = useRouter();
  const path = usePathname();
  useEffect(() => {
    setMenu(false);
    setSearching(false);
  }, [path]);
  const [first, ...rest] = brand.split(" ");

  return (
    <header className="site">
      <div className="wrap head-row">
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <button className="icon-btn menu-btn" aria-label="Menu" aria-expanded={menu} onClick={() => setMenu(!menu)}>
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round">
              <path d={menu ? "M6 6l12 12M18 6L6 18" : "M4 7h16M4 12h16M4 17h16"} />
            </svg>
          </button>
          <nav className="nav" aria-label="Main">
            {NAV.map((item) => (
              <Link key={item.href} href={item.href}>
                {item.label}
              </Link>
            ))}
          </nav>
        </div>
        <Link className="logo" href="/" aria-label={`${brand} home`}>
          <div className="logo-word">
            {rest.length ? (
              <>
                {first} <em>{rest.join(" ")}</em>
              </>
            ) : (
              brand
            )}
            <small>Western wear · Indore</small>
          </div>
        </Link>
        <div className="head-tools">
          <button className="icon-btn" aria-label="Search" onClick={() => setSearching(!searching)}>
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round">
              <circle cx="11" cy="11" r="7" />
              <path d="M20 20l-3.5-3.5" />
            </svg>
          </button>
          <Link className="icon-btn" href="/account" aria-label="Your account">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round">
              <circle cx="12" cy="8" r="4" />
              <path d="M4 21c1.5-4 4.5-6 8-6s6.5 2 8 6" />
            </svg>
          </Link>
          <Link className="icon-btn" href="/bag" aria-label={`Bag, ${count} piece${count === 1 ? "" : "s"}`}>
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
              <path d="M5 8h14l-1 13H6L5 8z" />
              <path d="M9 8V6a3 3 0 016 0v2" />
            </svg>
            {ready && count > 0 && <span className="bag-count">{count}</span>}
          </Link>
        </div>
      </div>
      {searching && (
        <div className="search-bar">
          <form
            className="wrap"
            role="search"
            onSubmit={(event) => {
              event.preventDefault();
              if (q.trim()) router.push(`/search?q=${encodeURIComponent(q.trim())}`);
            }}
          >
            <label className="visually-hidden" htmlFor="site-search">
              Search the collection
            </label>
            <input id="site-search" className="input" autoFocus value={q} onChange={(event) => setQ(event.target.value)} placeholder="Try: black dress, linen, party, co-ord" />
            <button className="btn dark">Search</button>
          </form>
        </div>
      )}
      {menu && (
        <nav className="wrap mobile-nav" aria-label="Main">
          {NAV.map((item) => (
            <Link key={item.href} href={item.href}>
              {item.label}
            </Link>
          ))}
          <Link href="/account">Your account</Link>
        </nav>
      )}
    </header>
  );
}
