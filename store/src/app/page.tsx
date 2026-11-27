import Link from "next/link";
import type { CSSProperties } from "react";
import { getCatalog, getInfo } from "@/lib/server";
import { ProductCard } from "@/components/ProductCard";
import { HeroLight } from "@/components/HeroLight";
import { backdrop, occasionWords, rupees } from "@/lib/format";

export const revalidate = 60;

export default async function Home() {
  const [catalog, info] = await Promise.all([getCatalog({ sort: "new" }), getInfo()]);
  const styles = catalog?.styles || [];
  const inStock = styles.filter((style) => style.inStock);
  const rail = inStock.filter((style) => style.images[0]).slice(0, 3);
  const newIn = inStock.slice(0, 8);
  const onSale = inStock.filter((style) => style.listPaise > 0).slice(0, 4);
  const occasions = (catalog?.facets.occasions || []).slice(0, 8);
  const tiers = info?.loyalty.tiers || [];
  const brand = info?.brandName || "The Hanger";

  return (
    <>
      <HeroLight
        note={`${inStock.length} pieces on the rail`}
        text={
          <>
            <h1>
              <span className="line">
                <span>Dressed for</span>
              </span>
              <span className="line">
                <span>
                  <em>wherever tonight goes.</em>
                </span>
              </span>
            </h1>
            <p className="lead">Western wear picked piece by piece at our Indore store: dresses, co-ords, denim and the jacket that makes the outfit.</p>
            <div className="hero-ctas">
              <Link className="btn dark" href="/shop?sort=new">
                Shop new in <span aria-hidden="true">→</span>
              </Link>
              {occasions[0] && (
                <Link className="btn ghost" href="#moods">
                  Shop by mood
                </Link>
              )}
            </div>
            <div className="hero-meta">
              <span>
                <b>Free</b>delivery across India
              </span>
              <span>
                <b>7 days</b>size exchange
              </span>
              {info?.cod.enabled && (
                <span>
                  <b>COD</b>on most pincodes
                </span>
              )}
            </div>
          </>
        }
        rail={
          <div className="rail-stage" aria-label="On the rail now">
            <div className="rail" />
            <div className="rail-items">
              {rail.map((style) => (
                <Link key={style.code} className="rail-item" href={`/p/${style.slug}`} style={{ "--bg": backdrop(style.code) } as CSSProperties}>
                  <div className="hook" />
                  <div className="photo">
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img src={style.images[0]} alt={style.imageAlt || style.name} />
                  </div>
                </Link>
              ))}
            </div>
            {rail[0] && (
              <Link className="rail-tag" href={`/p/${rail[0].slug}`}>
                <span className="small muted">Just in</span>
                <b>{rail[0].name}</b>
                {rupees(rail[0].pricePaise)}
              </Link>
            )}
          </div>
        }
      />

      {occasions.length > 0 && (
        <section className="block moods" id="moods">
          <div className="wrap">
            <div className="sec-head">
              <div>
                <div className="eyebrow">Shop by mood</div>
                <h2>
                  Where are you <em>going?</em>
                </h2>
              </div>
            </div>
            <div className="mood-row">
              {occasions.map((occasion) => {
                const words = occasionWords(occasion);
                return (
                  <Link key={occasion} className="mood" href={`/shop?occasion=${encodeURIComponent(occasion)}`}>
                    <h3>{words.title}</h3>
                    <span>{words.line}</span>
                  </Link>
                );
              })}
            </div>
          </div>
        </section>
      )}

      <section className="block">
        <div className="wrap">
          <div className="sec-head">
            <div>
              <div className="eyebrow">This week</div>
              <h2>
                New on <em>the rail</em>
              </h2>
            </div>
            <Link className="btn ghost" href="/shop?sort=new">
              See everything
            </Link>
          </div>
          {newIn.length ? (
            <div className="grid">
              {newIn.map((style, index) => (
                <ProductCard key={style.code} style={style} priority={index < 4} />
              ))}
            </div>
          ) : (
            <p className="empty">The new collection is on its way. Come back soon.</p>
          )}
        </div>
      </section>

      {onSale.length > 0 && (
        <section className="block" style={{ paddingTop: 0 }}>
          <div className="wrap">
            <div className="sec-head">
              <div>
                <div className="eyebrow">Last pieces</div>
                <h2>
                  Marked <em>down</em>
                </h2>
              </div>
              <Link className="btn ghost" href="/shop?sale=1">
                The whole sale
              </Link>
            </div>
            <div className="grid">
              {onSale.map((style) => (
                <ProductCard key={style.code} style={style} />
              ))}
            </div>
          </div>
        </section>
      )}

      {info?.loyalty.enabled && (
        <section className="block" style={{ paddingTop: 0 }}>
          <div className="wrap">
            <div className="band">
              <div>
                <div className="eyebrow" style={{ color: "#bfb3b8" }}>
                  The members&apos; circle
                </div>
                <h2>
                  Points on every piece <em>you keep.</em>
                </h2>
                <p>Sign in with your WhatsApp number at checkout and you are a member: points on what you keep, members&apos; prices on some styles, and your friends get a first-order discount from your code.</p>
                <Link className="btn ghost" href="/account">
                  Join with your number
                </Link>
              </div>
              {tiers.length > 0 && (
                <div className="tiers">
                  {tiers.map((tier) => (
                    <div key={tier.name}>
                      <b>{tier.name}</b>
                      <span className="small" style={{ color: "#d9cfd3", textAlign: "right" }}>
                        {tier.minSpendPaise ? `from ${rupees(tier.minSpendPaise)} a year` : "from your first order"}
                        {tier.multiplier > 1 ? ` · ${tier.multiplier}× points` : ""}
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        </section>
      )}

      <section className="block" style={{ paddingTop: 0 }}>
        <div className="wrap center">
          <div className="eyebrow">Come and try it on</div>
          <h2 style={{ fontSize: "clamp(30px, 4vw, 48px)", margin: "10px 0" }}>
            {brand}, <em>Indore</em>
          </h2>
          {info?.address && <p className="muted">{info.address}</p>}
        </div>
      </section>
    </>
  );
}
