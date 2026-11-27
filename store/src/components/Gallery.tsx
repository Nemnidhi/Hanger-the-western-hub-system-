"use client";

import { useState, type CSSProperties } from "react";
import { backdrop } from "@/lib/format";

export function Gallery({ code, images, alt, name }: { code: string; images: string[]; alt: string; name: string }) {
  const [index, setIndex] = useState(0);
  const style = { "--bg": backdrop(code) } as CSSProperties;
  return (
    <div className="gallery" style={style}>
      <div className="thumbs">
        {images.length > 1 &&
          images.map((image, i) => (
            <button key={image} className={`thumb${i === index ? " on" : ""}`} aria-label={`Photo ${i + 1}`} aria-pressed={i === index} onClick={() => setIndex(i)}>
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={image} alt="" loading="lazy" />
            </button>
          ))}
      </div>
      <div className="stage">
        {images[index] ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={images[index]} alt={index === 0 ? alt : `${name}, photo ${index + 1}`} />
        ) : (
          <div className="none" aria-hidden="true">
            {name.charAt(0)}
          </div>
        )}
      </div>
    </div>
  );
}
