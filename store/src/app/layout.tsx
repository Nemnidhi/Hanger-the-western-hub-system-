import type { Metadata, Viewport } from "next";
import { Fraunces, Manrope } from "next/font/google";
import "./globals.css";
import { BagProvider } from "@/lib/bag";
import { Header } from "@/components/Header";
import { Footer } from "@/components/Footer";
import { AddedToast } from "@/components/AddedToast";
import { AttributionKeeper } from "@/components/Attribution";
import { getInfo, siteUrl } from "@/lib/server";

const serif = Fraunces({ subsets: ["latin"], variable: "--font-serif", style: ["normal", "italic"], display: "swap" });
const sans = Manrope({ subsets: ["latin"], variable: "--font-sans", display: "swap" });

export async function generateMetadata(): Promise<Metadata> {
  const info = await getInfo();
  const brand = info?.brandName || "The Hanger";
  return {
    metadataBase: new URL(siteUrl()),
    title: { default: `${brand} · Western wear, Indore`, template: `%s · ${brand}` },
    description: `${brand}: dresses, co-ords, tops, denim and jackets picked in Indore. Free delivery across India, cash on delivery, free size exchange.`,
    openGraph: { siteName: brand, type: "website", locale: "en_IN" },
    alternates: { canonical: "/" },
  };
}

export const viewport: Viewport = { width: "device-width", initialScale: 1, viewportFit: "cover", themeColor: "#fbf7f2" };

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const info = await getInfo();
  return (
    <html lang="en-IN" className={`${serif.variable} ${sans.variable}`}>
      <body>
        <BagProvider>
          <AttributionKeeper />
          <div className="ticker" aria-hidden="true">
            <div className="ticker-track">
              {[0, 1].map((copy) => (
                <span key={copy} style={{ display: "inline-flex", gap: 48 }}>
                  <span>{info?.shippingNote || "Free delivery across India"}</span>
                  <span>{info?.returnsNote || "Free size exchange"}</span>
                  <span>Members get points on every piece they keep</span>
                </span>
              ))}
            </div>
          </div>
          <Header brand={info?.brandName || "The Hanger"} />
          <main>{children}</main>
          <Footer info={info} />
          <AddedToast />
        </BagProvider>
      </body>
    </html>
  );
}
