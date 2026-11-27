"use client";

import { usePathname, useRouter, useSearchParams } from "next/navigation";

export function SortSelect({ value }: { value: string }) {
  const router = useRouter();
  const path = usePathname();
  const params = useSearchParams();
  return (
    <label className="small">
      <span className="visually-hidden">Sort</span>
      <select
        value={value}
        onChange={(event) => {
          const next = new URLSearchParams(params.toString());
          next.set("sort", event.target.value);
          router.push(`${path}?${next.toString()}`);
        }}
      >
        <option value="new">Newest first</option>
        <option value="price_low">Price: low to high</option>
        <option value="price_high">Price: high to low</option>
      </select>
    </label>
  );
}
