"use client";

import { useEffect, useState, type CSSProperties } from "react";
import { useBag } from "@/lib/bag";
import { swatch } from "@/lib/format";
import type { SizeChart, Style } from "@/lib/types";
import { SizeChartTable } from "./SizeChartTable";

const SIZING_WORDS: Record<string, string> = { runs_small: "Runs small: take one size up.", runs_large: "Runs large: take one size down." };

/** Pick a size (only sizes in stock online), see the size chart, add to the bag. */
export function BuyBox({ style, sizeChart, startSize }: { style: Style; sizeChart: SizeChart | null; startSize: string }) {
  const { add } = useBag();
  const startsIn = style.sizes.find((size) => size.size === startSize.toUpperCase() && size.inStock);
  const [chosen, setChosen] = useState(startsIn?.code || (style.sizes.filter((size) => size.inStock).length === 1 ? style.sizes.find((size) => size.inStock)!.code : ""));
  const [chart, setChart] = useState(false);
  const [nudge, setNudge] = useState(false);
  const size = style.sizes.find((row) => row.code === chosen);
  useEffect(() => setNudge(false), [chosen]);

  const addToBag = () => {
    if (!size) return setNudge(true);
    add({ skuCode: size.code, slug: style.slug, name: style.name, size: size.size, colour: style.colour, image: style.images[0] || "", pricePaise: size.pricePaise });
  };

  return (
    <div>
      {style.colour && (
        <div className="colour-row">
          <span className="swatch" style={{ "--sw": swatch(style.colour) } as CSSProperties} />
          <span>
            <b style={{ textTransform: "capitalize" }}>{style.colour}</b>
            {style.fabric ? ` · ${style.fabric}` : ""}
          </span>
        </div>
      )}
      <div className="size-head">
        <b>{size ? `Size ${size.size}` : "Choose your size"}</b>
        {sizeChart && (
          <button className="link small" onClick={() => setChart(true)}>
            Size chart
          </button>
        )}
      </div>
      <div className="sizes" role="radiogroup" aria-label="Size">
        {style.sizes.map((row) => (
          <button key={row.code} role="radio" aria-checked={row.code === chosen} className={`size${row.code === chosen ? " on" : ""}`} disabled={!row.inStock} onClick={() => setChosen(row.code)} title={row.inStock ? "" : "Sold out in this size"}>
            {row.size}
          </button>
        ))}
      </div>
      <div className="small" style={{ minHeight: 22 }}>
        {size?.few ? <span className="low">Only a few left in {size.size}</span> : SIZING_WORDS[style.sizing] ? <span className="muted">{SIZING_WORDS[style.sizing]}</span> : null}
        {nudge && <span className="low">Choose a size first.</span>}
      </div>
      <div style={{ display: "grid", gap: 10, marginTop: 12 }}>
        <button className="btn wine block" onClick={addToBag} disabled={!style.inStock}>
          {style.inStock ? "Add to bag" : "Sold out"}
        </button>
      </div>
      {chart && sizeChart && (
        <div className="dialog-back" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && setChart(false)}>
          <div className="dialog" role="dialog" aria-modal="true" aria-label="Size chart">
            <h2>Size chart</h2>
            <SizeChartTable chart={sizeChart} highlight={size?.size || ""} />
            <button className="btn ghost" style={{ marginTop: 16 }} onClick={() => setChart(false)}>
              Close
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
