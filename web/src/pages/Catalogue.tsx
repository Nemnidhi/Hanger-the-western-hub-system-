import { useMemo, useState } from "react";
import { api, ApiError, can, type Me } from "../api";
import { rupees } from "../format";
import { Dialog, Notice, toPaise, useLoad, useRun } from "../ui";
import type { Location, Style, Supplier } from "../types";

// The catalogue: every style with its sizes and stock at each location. A style is a draft until it
// has a photo and is put live; live styles go to the WhatsApp / Instagram catalogue.

const CATEGORIES = ["dresses", "tops", "shirts", "t-shirts", "jeans", "trousers", "skirts", "co-ords", "jumpsuits", "jackets", "knitwear", "accessories"];
const SIZE_SETS: Record<string, string[]> = { "XS-XL": ["XS", "S", "M", "L", "XL"], "S-XXL": ["S", "M", "L", "XL", "XXL"], Free: ["FREE"], "26-34": ["26", "28", "30", "32", "34"] };

export function Catalogue({ me }: { me: Me }) {
  const lowOnly = window.location.hash.includes("/low");
  const [status, setStatus] = useState<"" | "draft" | "live" | "archived">("");
  const [q, setQ] = useState("");
  const [editing, setEditing] = useState<Style | "new" | null>(null);
  const styles = useLoad<{ styles: Style[] }>(`/api/styles${status ? `?status=${status}` : ""}`);
  const locations = useLoad<{ locations: Location[] }>("/api/locations");
  const suppliers = useLoad<{ suppliers: Supplier[] }>("/api/suppliers");
  const canWrite = can(me, "catalog:write");
  const locs = locations.data?.locations || [];

  const shown = useMemo(() => {
    const term = q.trim().toLowerCase();
    return (styles.data?.styles || []).filter((style) => {
      if (term && !`${style.code} ${style.name} ${style.category} ${style.attributes?.colour || ""}`.toLowerCase().includes(term)) return false;
      if (lowOnly) return style.sizes.some((size) => size.stock.some((row) => row.onHand > 0 && row.available <= 1));
      return true;
    });
  }, [styles.data, q, lowOnly]);

  return (
    <div className="page">
      <div className="detail-head">
        <h1>{lowOnly ? "Down to the last piece" : "Catalogue"}</h1>
        {canWrite && (
          <button className="btn primary" onClick={() => setEditing("new")}>
            Add style
          </button>
        )}
      </div>
      <div className="toolbar">
        <input className="input" type="search" placeholder="Search code, name, colour" value={q} onChange={(event) => setQ(event.target.value)} aria-label="Search styles" />
        <select className="input auto" value={status} onChange={(event) => setStatus(event.target.value as typeof status)} aria-label="Status">
          <option value="">All</option>
          <option value="live">Live</option>
          <option value="draft">Draft</option>
          <option value="archived">Archived</option>
        </select>
        {lowOnly && (
          <a className="btn" href="#catalogue">
            Show all
          </a>
        )}
      </div>
      <Notice>{styles.error}</Notice>
      <div className="style-grid">
        {shown.map((style) => {
          const total = style.sizes.reduce((sum, size) => sum + size.stock.reduce((inner, row) => inner + row.onHand, 0), 0);
          return (
            <article key={style._id} className="style-card">
              <button className="style-photo" onClick={() => canWrite && setEditing(style)} aria-label={`Edit ${style.name}`} disabled={!canWrite}>
                {style.images[0] ? <img src={style.images[0]} alt="" loading="lazy" /> : <span>No photo</span>}
                <span className={`badge ${style.status === "live" ? "accent" : style.status === "draft" ? "warn" : ""}`}>{style.status}</span>
              </button>
              <div className="style-body">
                <div className="order-row-top">
                  <strong>{style.name}</strong>
                  <span>{rupees(style.pricePaise)}</span>
                </div>
                <div className="muted small-text">
                  {style.code} · {style.category}
                  {style.attributes?.colour ? ` · ${style.attributes.colour}` : ""} · {total} pc
                </div>
                <table className="size-table">
                  <thead>
                    <tr>
                      <th>Size</th>
                      {locs.map((location) => (
                        <th key={location._id} title={location.name}>
                          {location.code}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {style.sizes.map((size) => (
                      <tr key={size.code}>
                        <td>{size.size}</td>
                        {locs.map((location) => {
                          const row = size.stock.find((item) => item.locationId === location._id);
                          return (
                            <td key={location._id} className={row && row.onHand > 0 && row.available <= 1 ? "low" : ""} title={row?.reserved ? `${row.reserved} held in carts` : ""}>
                              {row?.available ?? 0}
                              {row?.reserved ? <span className="muted">+{row.reserved}</span> : null}
                            </td>
                          );
                        })}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </article>
          );
        })}
      </div>
      {styles.data && !shown.length && <div className="empty">No styles here yet.</div>}
      {editing && <StyleDialog style={editing === "new" ? null : editing} suppliers={suppliers.data?.suppliers || []} onClose={() => setEditing(null)} onSaved={() => (setEditing(null), styles.reload())} />}
    </div>
  );
}

async function uploadPhoto(file: File): Promise<string> {
  if (!["image/jpeg", "image/png", "image/webp"].includes(file.type)) throw new Error("Use a JPEG, PNG or WebP photo.");
  if (file.size > 8 * 1024 * 1024) throw new Error("That photo is over 8 MB.");
  const response = await fetch("/api/uploads", { method: "POST", credentials: "same-origin", headers: { "x-hanger-app": "1", "content-type": file.type }, body: file });
  const data = await response.json().catch(() => null);
  if (!response.ok) throw new ApiError(response.status, data?.error || "ERROR", data?.message || "Upload failed.");
  return data.url as string;
}

function StyleDialog({ style, suppliers, onClose, onSaved }: { style: Style | null; suppliers: Supplier[]; onClose: () => void; onSaved: () => void }) {
  const { busy, error, run } = useRun();
  const [form, setForm] = useState(() => ({
    code: style?.code || "",
    name: style?.name || "",
    category: style?.category || "dresses",
    price: style ? String(style.pricePaise / 100) : "",
    cost: style?.costPaise ? String(style.costPaise / 100) : "",
    description: style?.description || "",
    colour: style?.attributes?.colour || "",
    fabric: style?.attributes?.fabric || "",
    fit: style?.attributes?.fit || "",
    pattern: style?.attributes?.pattern || "",
    occasion: (style?.attributes?.occasion || []).join(", "),
    outfitPart: style?.outfitPart || "",
    sizing: style?.sizing || "true",
    pairsWith: (style?.pairsWith || []).join(", "),
    supplierId: style?.supplierId || "",
    supplierStyleRef: style?.supplierStyleRef || "",
    hsn: style?.hsn || "",
    sizes: style ? "" : SIZE_SETS["XS-XL"].join(" "),
    images: style?.images || [],
  }));
  const [barcodes, setBarcodes] = useState<Record<string, string>>(() => Object.fromEntries((style?.sizes || []).map((size) => [size.code, size.barcode])));
  const [uploading, setUploading] = useState(false);
  const set = (key: keyof typeof form) => (event: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) => setForm({ ...form, [key]: event.target.value });
  const sizes = form.sizes.split(/[\s,]+/).map((size) => size.trim().toUpperCase()).filter(Boolean);

  function body() {
    const price = toPaise(form.price);
    if (!(price >= 100)) throw new Error("Enter the selling price in rupees (GST included).");
    const cost = form.cost ? toPaise(form.cost) : undefined;
    return {
      name: form.name.trim(),
      category: form.category.trim().toLowerCase(),
      description: form.description.trim(),
      price: price / 100,
      ...(cost !== undefined && cost >= 0 ? { cost: cost / 100 } : {}),
      attributes: { colour: form.colour.trim(), fabric: form.fabric.trim(), fit: form.fit.trim(), pattern: form.pattern.trim(), occasion: form.occasion.split(",").map((item) => item.trim()).filter(Boolean) },
      images: form.images,
      outfitPart: form.outfitPart,
      sizing: form.sizing,
      pairsWith: form.pairsWith.split(/[\s,]+/).map((code) => code.trim().toUpperCase()).filter(Boolean).slice(0, 12),
      ...(form.supplierId ? { supplierId: form.supplierId } : {}),
      supplierStyleRef: form.supplierStyleRef.trim(),
      ...(form.hsn.trim() ? { hsn: form.hsn.trim() } : {}),
    };
  }

  const save = (status?: Style["status"]) =>
    run(async () => {
      if (style) {
        await api(`/api/styles/${style._id}`, { method: "PATCH", body: { ...body(), ...(status ? { status } : {}), ...(sizes.length ? { addSizes: sizes } : {}) } });
        for (const size of style.sizes) {
          const barcode = (barcodes[size.code] || "").trim();
          if (barcode && barcode !== size.barcode) await api(`/api/skus/${size.code}`, { method: "PATCH", body: { barcode } });
        }
      } else {
        if (!sizes.length) throw new Error("Give at least one size.");
        const created = await api<{ style: { _id: string } }>("/api/styles", { method: "POST", body: { code: form.code.trim().toUpperCase(), sizes, ...body() } });
        if (status === "live") await api(`/api/styles/${created.style._id}`, { method: "PATCH", body: { status: "live" } });
      }
      onSaved();
    });

  async function onFiles(files: FileList | null) {
    if (!files?.length) return;
    setUploading(true);
    await run(async () => {
      const urls: string[] = [];
      for (const file of Array.from(files).slice(0, 10)) urls.push(await uploadPhoto(file));
      setForm((current) => ({ ...current, images: [...current.images, ...urls].slice(0, 20) }));
    });
    setUploading(false);
  }

  return (
    <Dialog title={style ? `${style.code} · ${style.name}` : "Add a style"} onClose={onClose} wide>
      <form onSubmit={(event) => (event.preventDefault(), save())}>
        <div className="photos">
          {form.images.map((url, index) => (
            <div key={url} className="photo">
              <img src={url} alt={`Photo ${index + 1}`} />
              <div className="photo-actions">
                {index > 0 && (
                  <button type="button" className="btn small" onClick={() => setForm({ ...form, images: [url, ...form.images.filter((item) => item !== url)] })} title="Make this the main photo">
                    Main
                  </button>
                )}
                <button type="button" className="btn small danger" onClick={() => setForm({ ...form, images: form.images.filter((item) => item !== url) })} aria-label="Remove photo">
                  ×
                </button>
              </div>
            </div>
          ))}
          <label className="photo add">
            <input type="file" accept="image/jpeg,image/png,image/webp" multiple hidden onChange={(event) => onFiles(event.target.files)} />
            {uploading ? "Uploading…" : "+ Photo"}
          </label>
        </div>

        <div className="form-grid">
          {!style && (
            <div className="field">
              <label htmlFor="code">Style code</label>
              <input id="code" className="input" required value={form.code} onChange={set("code")} placeholder="DRS-001" pattern="[A-Za-z0-9][A-Za-z0-9\-]{2,23}" />
            </div>
          )}
          <div className="field span-2">
            <label htmlFor="name">Name</label>
            <input id="name" className="input" required minLength={2} value={form.name} onChange={set("name")} placeholder="Linen midi dress" />
          </div>
          <div className="field">
            <label htmlFor="category">Category</label>
            <input id="category" className="input" list="categories" required value={form.category} onChange={set("category")} />
            <datalist id="categories">
              {CATEGORIES.map((name) => (
                <option key={name} value={name} />
              ))}
            </datalist>
          </div>
          <div className="field">
            <label htmlFor="price">Price, Rs (incl. GST)</label>
            <input id="price" className="input" required inputMode="decimal" value={form.price} onChange={set("price")} placeholder="1999" />
          </div>
          <div className="field">
            <label htmlFor="cost">Buying cost, Rs</label>
            <input id="cost" className="input" inputMode="decimal" value={form.cost} onChange={set("cost")} placeholder="optional" />
          </div>
          <div className="field">
            <label htmlFor="colour">Colour</label>
            <input id="colour" className="input" value={form.colour} onChange={set("colour")} />
          </div>
          <div className="field">
            <label htmlFor="fabric">Fabric</label>
            <input id="fabric" className="input" value={form.fabric} onChange={set("fabric")} />
          </div>
          <div className="field">
            <label htmlFor="fit">Fit</label>
            <input id="fit" className="input" value={form.fit} onChange={set("fit")} placeholder="relaxed, bodycon…" />
          </div>
          <div className="field">
            <label htmlFor="pattern">Pattern</label>
            <input id="pattern" className="input" value={form.pattern} onChange={set("pattern")} placeholder="solid, floral…" />
          </div>
          <div className="field span-2">
            <label htmlFor="occasion">Occasions</label>
            <input id="occasion" className="input" value={form.occasion} onChange={set("occasion")} placeholder="brunch, office, party" />
          </div>
          <div className="field">
            <label htmlFor="part">Part of an outfit</label>
            <select id="part" className="input" value={form.outfitPart} onChange={set("outfitPart")}>
              <option value="">From the category</option>
              <option value="dress">Dress / co-ord (whole look)</option>
              <option value="top">Top</option>
              <option value="bottom">Bottom</option>
              <option value="layer">Layer (jacket, shrug)</option>
              <option value="other">Not in picks</option>
            </select>
          </div>
          <div className="field">
            <label htmlFor="sizing">Sizing</label>
            <select id="sizing" className="input" value={form.sizing} onChange={set("sizing")}>
              <option value="true">True to size</option>
              <option value="runs_small">Runs small</option>
              <option value="runs_large">Runs large</option>
            </select>
          </div>
          <div className="field span-2">
            <label htmlFor="pairs">Goes with (style codes, for outfit picks)</label>
            <input id="pairs" className="input" value={form.pairsWith} onChange={set("pairsWith")} placeholder="BTM-012, JKT-010" />
          </div>
          <div className="field">
            <label htmlFor="supplier">Supplier</label>
            <select id="supplier" className="input" value={form.supplierId} onChange={set("supplierId")}>
              <option value="">—</option>
              {suppliers.map((supplier) => (
                <option key={supplier._id} value={supplier._id}>
                  {supplier.name}
                </option>
              ))}
            </select>
          </div>
          <div className="field">
            <label htmlFor="ref">Supplier's style no.</label>
            <input id="ref" className="input" value={form.supplierStyleRef} onChange={set("supplierStyleRef")} />
          </div>
          <div className="field">
            <label htmlFor="hsn">HSN</label>
            <input id="hsn" className="input" value={form.hsn} onChange={set("hsn")} placeholder="default 6204" inputMode="numeric" />
          </div>
          <div className="field span-3">
            <label htmlFor="description">Description</label>
            <textarea id="description" className="input" rows={3} value={form.description} onChange={set("description")} />
          </div>
          <div className="field span-3">
            <label htmlFor="sizes">{style ? "Add sizes" : "Sizes"}</label>
            <input id="sizes" className="input" value={form.sizes} onChange={set("sizes")} placeholder={style ? "e.g. XXL" : "XS S M L XL"} />
            {!style && (
              <div className="chips">
                {Object.entries(SIZE_SETS).map(([label, list]) => (
                  <button type="button" key={label} className="chip" onClick={() => setForm({ ...form, sizes: list.join(" ") })}>
                    {label}
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>

        {style && style.sizes.length > 0 && (
          <div className="field">
            <label>Barcodes (scan into each box)</label>
            <div className="barcodes">
              {style.sizes.map((size) => (
                <label key={size.code} className="barcode">
                  <span>{size.size}</span>
                  <input className="input" value={barcodes[size.code] || ""} onChange={(event) => setBarcodes({ ...barcodes, [size.code]: event.target.value })} onKeyDown={(event) => event.key === "Enter" && event.preventDefault()} aria-label={`Barcode for ${size.code}`} />
                </label>
              ))}
            </div>
          </div>
        )}

        <Notice>{error}</Notice>
        <div className="actions">
          {style?.status === "live" && (
            <button type="button" className="btn" disabled={busy} onClick={() => save("archived")}>
              Archive
            </button>
          )}
          <button type="button" className="btn" onClick={onClose}>
            Close
          </button>
          <button className="btn" disabled={busy || uploading}>
            {style ? "Save" : "Save as draft"}
          </button>
          {style?.status !== "live" && (
            <button type="button" className="btn primary" disabled={busy || uploading || !form.images.length} onClick={() => save("live")} title={form.images.length ? "" : "Add a photo first"}>
              Save and put live
            </button>
          )}
        </div>
      </form>
    </Dialog>
  );
}
