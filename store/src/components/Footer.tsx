import Link from "next/link";
import type { ShopInfo } from "@/lib/types";

export function Footer({ info }: { info: ShopInfo | null }) {
  const brand = info?.brandName || "The Hanger";
  const wa = (info?.whatsapp || "").replace(/\D/g, "");
  return (
    <footer className="site">
      <div className="wrap foot-grid">
        <div>
          <h3>{brand}</h3>
          <p className="muted" style={{ maxWidth: 420 }}>
            Western wear picked in Indore, from dresses and co-ords to denim and jackets. Try it on at the store, or order here and on WhatsApp.
          </p>
          {info?.address && <p className="small muted">{info.address}</p>}
        </div>
        <div>
          <h3>Shop</h3>
          <ul>
            <li>
              <Link href="/shop?sort=new">New in</Link>
            </li>
            <li>
              <Link href="/shop">Shop all</Link>
            </li>
            <li>
              <Link href="/shop?sale=1">Sale</Link>
            </li>
            <li>
              <Link href="/size-guide">Size guide</Link>
            </li>
          </ul>
        </div>
        <div>
          <h3>Help</h3>
          <ul>
            <li>
              <Link href="/account">Your orders</Link>
            </li>
            {wa && (
              <li>
                <a href={`https://wa.me/${wa}`} target="_blank" rel="noopener">
                  WhatsApp us
                </a>
              </li>
            )}
            {info?.instagram && (
              <li>
                <a href={`https://instagram.com/${info.instagram.replace(/^@/, "")}`} target="_blank" rel="noopener">
                  Instagram
                </a>
              </li>
            )}
            <li className="muted small">{info?.returnsNote}</li>
          </ul>
        </div>
      </div>
      <div className="wrap small muted" style={{ marginTop: 28 }}>
        © {new Date().getFullYear()} {info?.legalName || brand}
        {info?.gstin ? ` · GSTIN ${info.gstin}` : ""}
      </div>
    </footer>
  );
}
