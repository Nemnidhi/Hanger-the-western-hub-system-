import type { Metadata } from "next";
import Link from "next/link";
import { getCatalog } from "@/lib/server";
import { ProductCard } from "@/components/ProductCard";
import { SortSelect } from "@/components/SortSelect";
import { occasionWords, titleCase } from "@/lib/format";

export const revalidate = 60;

type Params = { category?: string; size?: string; occasion?: string; sale?: string; sort?: string };

export async function generateMetadata({ searchParams }: { searchParams: Promise<Params> }): Promise<Metadata> {
  const params = await searchParams;
  const title = params.sale ? "Sale" : params.category ? titleCase(params.category) : params.occasion ? `${occasionWords(params.occasion).title} outfits` : "Shop all";
  return { title, description: `${title}: western wear from The Hanger, Indore. Free delivery across India.`, alternates: { canonical: params.category ? `/shop?category=${params.category}` : "/shop" } };
}

export default async function Shop({ searchParams }: { searchParams: Promise<Params> }) {
  const params = await searchParams;
  const catalog = await getCatalog({ category: params.category, size: params.size, occasion: params.occasion, sale: params.sale, sort: params.sort });
  const styles = catalog?.styles || [];
  const facets = catalog?.facets;
  const link = (changes: Partial<Params>) => {
    const next = new URLSearchParams(Object.entries({ ...params, ...changes }).filter((entry): entry is [string, string] => Boolean(entry[1])));
    const text = next.toString();
    return text ? `/shop?${text}` : "/shop";
  };
  const heading = params.sale ? "Sale" : params.category ? titleCase(params.category) : params.occasion ? occasionWords(params.occasion).title : "Shop all";

  return (
    <div className="wrap">
      <div className="shop-head">
        <div className="eyebrow">{styles.length} pieces</div>
        <h1>{params.sale ? <em>{heading}</em> : heading}</h1>
      </div>
      <div className="filters" aria-label="Filters">
        <Link className={`chip${!params.category ? " on" : ""}`} href={link({ category: undefined })}>
          Everything
        </Link>
        {facets?.categories.map((category) => (
          <Link key={category} className={`chip${params.category === category ? " on" : ""}`} href={link({ category: params.category === category ? undefined : category })}>
            {titleCase(category)}
          </Link>
        ))}
        {facets?.sale && (
          <Link className={`chip${params.sale ? " on" : ""}`} href={link({ sale: params.sale ? undefined : "1" })}>
            Sale
          </Link>
        )}
      </div>
      <div className="filters">
        <span className="small muted">In my size:</span>
        {facets?.sizes.map((size) => (
          <Link key={size} className={`chip${params.size === size ? " on" : ""}`} href={link({ size: params.size === size ? undefined : size })}>
            {size}
          </Link>
        ))}
        {facets?.occasions.length ? <span className="small muted" style={{ marginLeft: 8 }}>For:</span> : null}
        {facets?.occasions.map((occasion) => (
          <Link key={occasion} className={`chip${params.occasion === occasion ? " on" : ""}`} href={link({ occasion: params.occasion === occasion ? undefined : occasion })}>
            {occasionWords(occasion).title}
          </Link>
        ))}
        <span className="spacer" />
        <SortSelect value={params.sort || "new"} />
      </div>
      {styles.length ? (
        <div className="grid" style={{ paddingBottom: 60 }}>
          {styles.map((style, index) => (
            <ProductCard key={style.code} style={style} priority={index < 4} />
          ))}
        </div>
      ) : (
        <div className="empty">
          <p>Nothing here in that combination right now.</p>
          <Link className="btn ghost" href="/shop">
            See everything
          </Link>
        </div>
      )}
    </div>
  );
}
