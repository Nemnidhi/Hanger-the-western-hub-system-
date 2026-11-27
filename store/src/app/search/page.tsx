import type { Metadata } from "next";
import Link from "next/link";
import { search } from "@/lib/server";
import { ProductCard } from "@/components/ProductCard";

export const metadata: Metadata = { title: "Search", robots: { index: false } };

export default async function SearchPage({ searchParams }: { searchParams: Promise<{ q?: string }> }) {
  const { q = "" } = await searchParams;
  const result = q.trim() ? await search(q.trim()) : null;
  const styles = result?.styles || [];
  return (
    <div className="wrap">
      <div className="shop-head">
        <div className="eyebrow">Search</div>
        <h1>{q ? <>&ldquo;{q}&rdquo;</> : "Find a piece"}</h1>
      </div>
      <form action="/search" role="search" className="inline" style={{ margin: "22px 0 30px", maxWidth: 560 }}>
        <label className="visually-hidden" htmlFor="q">
          Search the collection
        </label>
        <input id="q" name="q" className="input" defaultValue={q} placeholder="Try: black dress, linen, party, co-ord" />
        <button className="btn dark">Search</button>
      </form>
      {q && !styles.length && (
        <div className="empty">
          <p>Nothing matches &ldquo;{q}&rdquo; right now.</p>
          <Link className="btn ghost" href="/shop">
            See everything
          </Link>
        </div>
      )}
      {styles.length > 0 && (
        <div className="grid" style={{ paddingBottom: 60 }}>
          {styles.map((style) => (
            <ProductCard key={style.code} style={style} />
          ))}
        </div>
      )}
    </div>
  );
}
