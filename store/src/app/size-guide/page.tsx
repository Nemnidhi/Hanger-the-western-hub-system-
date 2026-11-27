import type { Metadata } from "next";
import { getInfo } from "@/lib/server";
import { SizeChartTable } from "@/components/SizeChartTable";

export const metadata: Metadata = { title: "Size guide", description: "Size charts for dresses, tops, co-ords, jeans and trousers, in inches.", alternates: { canonical: "/size-guide" } };
export const revalidate = 300;

export default async function SizeGuide() {
  const info = await getInfo();
  return (
    <div className="wrap narrow" style={{ paddingBottom: 60 }}>
      <div className="shop-head">
        <div className="eyebrow">Fit</div>
        <h1>
          Size <em>guide</em>
        </h1>
      </div>
      <p className="muted">Measure your body, not a garment, with a soft tape. Each product page also says when a style runs small or large.</p>
      <div style={{ display: "grid", gap: 28, marginTop: 24 }}>
        {(info?.sizeCharts || []).map((chart) => (
          <section key={chart.name} className="panel">
            <h2>{chart.name}</h2>
            <SizeChartTable chart={chart} />
          </section>
        ))}
      </div>
      <p className="small muted" style={{ marginTop: 24 }}>
        {info?.returnsNote}
      </p>
    </div>
  );
}
