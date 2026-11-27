import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { getInfo, getStyle, siteUrl } from "@/lib/server";
import { ProductCard } from "@/components/ProductCard";
import { Gallery } from "@/components/Gallery";
import { BuyBox } from "@/components/BuyBox";
import { rupees, titleCase } from "@/lib/format";

export const revalidate = 60;

type Props = { params: Promise<{ slug: string }>; searchParams: Promise<{ size?: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { slug } = await params;
  const data = await getStyle(slug);
  if (!data) return { title: "Not found" };
  const { style } = data;
  const description = (style.description || `${style.name} in ${style.colour || style.category}.`).slice(0, 160);
  return {
    title: style.name,
    description,
    alternates: { canonical: `/p/${style.slug}` },
    openGraph: { title: style.name, description, images: style.images.slice(0, 1), type: "website" },
  };
}

export default async function ProductPage({ params, searchParams }: Props) {
  const [{ slug }, query] = await Promise.all([params, searchParams]);
  const [data, info] = await Promise.all([getStyle(slug), getInfo()]);
  if (!data) notFound();
  const { style, pairs, sizeChart } = data;
  const brand = info?.brandName || "The Hanger";

  // Google's product data: one offer per size, in stock or not.
  const jsonLd = {
    "@context": "https://schema.org",
    "@type": "ProductGroup",
    name: style.name,
    description: style.description || style.name,
    productGroupID: style.code,
    brand: { "@type": "Brand", name: brand },
    variesBy: ["https://schema.org/size"],
    image: style.images,
    url: `${siteUrl()}/p/${style.slug}`,
    hasVariant: style.sizes.map((size) => ({
      "@type": "Product",
      sku: size.code,
      name: `${style.name} - ${size.size}`,
      size: size.size,
      color: style.colour || undefined,
      material: style.fabric || undefined,
      image: style.images[0],
      offers: {
        "@type": "Offer",
        url: `${siteUrl()}/p/${style.slug}?size=${encodeURIComponent(size.size)}`,
        priceCurrency: "INR",
        price: (size.pricePaise / 100).toFixed(2),
        availability: size.inStock ? "https://schema.org/InStock" : "https://schema.org/OutOfStock",
        itemCondition: "https://schema.org/NewCondition",
      },
    })),
  };

  return (
    <div className="wrap">
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd).replace(/</g, "\\u003c") }} />
      <nav className="small muted" style={{ paddingTop: 22 }} aria-label="Breadcrumb">
        <Link href="/shop">Shop</Link> / <Link href={`/shop?category=${encodeURIComponent(style.category)}`}>{titleCase(style.category)}</Link> / {style.name}
      </nav>
      <div className="pdp">
        <Gallery code={style.code} images={style.images} alt={style.imageAlt || style.name} name={style.name} />
        <div>
          <div className="eyebrow">
            {titleCase(style.category)}
            {style.isNew ? " · New" : ""}
          </div>
          <h1>{style.name}</h1>
          <div className="big-price">
            {rupees(style.pricePaise)}
            {style.listPaise > 0 && <s>{rupees(style.listPaise)}</s>}
            {style.offPct > 0 && <span className="tag wine">{style.offPct}% off</span>}
          </div>
          <div className="small muted">Price includes GST</div>
          <BuyBox style={style} sizeChart={sizeChart} startSize={query.size || ""} />
          <div className="notes">
            <div>
              <span aria-hidden="true">✦</span>
              <span>{info?.shippingNote}</span>
            </div>
            <div>
              <span aria-hidden="true">✦</span>
              <span>{info?.returnsNote}</span>
            </div>
            {info?.loyalty.enabled && (
              <div>
                <span aria-hidden="true">✦</span>
                <span>Members earn points on this piece. Sign in with your WhatsApp number at checkout.</span>
              </div>
            )}
          </div>
          {style.description && <p>{style.description}</p>}
          {style.highlights.length > 0 && (
            <ul className="highlights">
              {style.highlights.map((line) => (
                <li key={line}>{line}</li>
              ))}
            </ul>
          )}
          <p className="small muted">
            {[style.fabric && `Fabric: ${style.fabric}`, style.fit && `Fit: ${style.fit}`, style.pattern && `Pattern: ${style.pattern}`, `Style code ${style.code}`].filter(Boolean).join(" · ")}
          </p>
        </div>
      </div>
      {pairs.length > 0 && (
        <section className="block" style={{ paddingTop: 0 }}>
          <div className="sec-head">
            <div>
              <div className="eyebrow">Wear it with</div>
              <h2>
                Finish <em>the look</em>
              </h2>
            </div>
          </div>
          <div className="grid">
            {pairs.map((pair) => (
              <ProductCard key={pair.code} style={pair} />
            ))}
          </div>
        </section>
      )}
    </div>
  );
}
