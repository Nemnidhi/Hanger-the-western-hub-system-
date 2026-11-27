"use client";

import { useEffect, useState, type ReactNode } from "react";

// The hero's light follows the visitor's time of day: morning gold, evening rose, night wine.
function partOfDay(hour: number) {
  if (hour >= 5 && hour < 12) return { key: "day", words: "Good morning" };
  if (hour >= 12 && hour < 17) return { key: "day", words: "Good afternoon" };
  if (hour >= 17 && hour < 21) return { key: "evening", words: "Good evening" };
  return { key: "night", words: "Up late?" };
}

export function HeroLight({ text, rail, note }: { text: ReactNode; rail: ReactNode; note: string }) {
  const [part, setPart] = useState({ key: "day", words: "Hello" });
  useEffect(() => setPart(partOfDay(new Date().getHours())), []);
  return (
    <section className={`hero ${part.key}`}>
      <div className="wrap">
        <div className="hero-grid">
          <div>
            <span className="greet">
              <span className="dot" aria-hidden="true" />
              {part.words} · {note}
            </span>
            {text}
          </div>
          {rail}
        </div>
      </div>
    </section>
  );
}
