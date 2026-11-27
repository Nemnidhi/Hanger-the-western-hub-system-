import Link from "next/link";
import type { CSSProperties } from "react";
import type { Style } from "@/lib/types";
import { backdrop, rupees, swatch } from "@/lib/format";

/** A style in a grid: photo on its backdrop, what is special about it, name, colour and price. */
export function ProductCard({ style, priority = false }: { style: Style; priority?: boolean }) {
  const left = style.sizes.filter((size) => size.inStock);
  const lastSize = left.length === 1 ? left[0].size : "";
  return (
    <Link className={`card${style.inStock ? "" : " out"}`} href={`/p/${style.slug}`} style={{ "--bg": backdrop(style.code) } as CSSProperties}>
      <div className="frame">
        {style.images[0] ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={style.images[0]} alt={style.imageAlt || style.name} loading={priority ? "eager" : "lazy"} />
        ) : (
          <span className="none" aria-hidden="true">
            {style.name.charAt(0)}
          </span>
        )}
        <div className="tags">
          {!style.inStock && <span className="tag">Sold out</span>}
          {style.offPct > 0 && <span className="tag wine">{style.offPct}% off</span>}
          {style.isNew && style.inStock && <span className="tag gold">New</span>}
        </div>
      </div>
      <div className="info">
        <div style={{ minWidth: 0 }}>
          <div className="name">{style.name}</div>
          <div className="sub">
            {style.colour && <span className="swatch" style={{ "--sw": swatch(style.colour) } as CSSProperties} />}
            <span>
              {style.colour || style.category}
              {lastSize && (
                <>
                  {" · "}
                  <span className="low">last {lastSize}</span>
                </>
              )}
            </span>
          </div>
        </div>
        <div className="price">
          {style.listPaise > 0 && <s>{rupees(style.listPaise)}</s>}
          {rupees(style.pricePaise)}
        </div>
      </div>
    </Link>
  );
}
