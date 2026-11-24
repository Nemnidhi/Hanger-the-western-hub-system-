import { useEffect, useMemo, useRef, useState } from "react";
import { api, ApiError, can, type Me } from "../api";
import { Notice, useLoad, useRun } from "../ui";
import type { Style, StudioCopy, StudioJob, StudioKind, StudioReady } from "../types";

// The photo studio: staff take a plain photo of a piece (hanger, flat, on a person), and the system
// makes the shop's photos (clean white, the brand backdrop, and on request an AI model or ghost
// mannequin) and writes the website description and Instagram caption. Staff check, pick, edit and
// apply it to a style.

const KIND_LABEL: Record<StudioKind, string> = { white: "Clean white", studio: "Brand backdrop", model: "On a model (AI)", ghost: "Ghost mannequin (AI)" };
const CATEGORIES = ["dresses", "tops", "shirts", "t-shirts", "trousers", "jeans", "skirts", "shorts", "co-ords", "jumpsuits", "jackets", "cardigans", "shrugs", "other"];
const LONG_SIDE = 2000;

/** Shrinks a phone photo to at most 2000 px on the long side as a JPEG, so uploads are quick and fit Claude's limits. */
async function shrink(file: File): Promise<Blob> {
  if (!["image/jpeg", "image/png", "image/webp"].includes(file.type)) throw new Error("Use a JPEG, PNG or WebP photo.");
  try {
    const bitmap = await createImageBitmap(file);
    const scale = Math.min(1, LONG_SIDE / Math.max(bitmap.width, bitmap.height));
    if (scale === 1 && file.size < 3 * 1024 * 1024) return file;
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(bitmap.width * scale);
    canvas.height = Math.round(bitmap.height * scale);
    canvas.getContext("2d")!.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/jpeg", 0.88));
    return blob || file;
  } catch {
    return file;
  }
}

async function uploadPhoto(file: File): Promise<string> {
  const body = await shrink(file);
  if (body.size > 8 * 1024 * 1024) throw new Error("That photo is over 8 MB.");
  const response = await fetch("/api/uploads", { method: "POST", credentials: "same-origin", headers: { "x-hanger-app": "1", "content-type": body.type || file.type }, body });
  const data = await response.json().catch(() => null);
  if (!response.ok) throw new ApiError(response.status, data?.error || "ERROR", data?.message || "Upload failed.");
  return data.url as string;
}

const ago = (iso: string) => {
  const minutes = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  if (minutes < 60 * 24) return `${Math.round(minutes / 60)} h ago`;
  return new Date(iso).toLocaleDateString("en-IN", { day: "numeric", month: "short" });
};

export function Studio({ me }: { me: Me }) {
  const list = useLoad<{ jobs: StudioJob[]; ready: StudioReady }>("/api/studio/jobs");
  const styles = useLoad<{ styles: Style[] }>("/api/styles");
  const [openId, setOpenId] = useState(() => window.location.hash.split("/")[1] || "");
  const canWrite = can(me, "catalog:write") || can(me, "studio:use");
  const canEditStyles = can(me, "catalog:write");
  const jobs = list.data?.jobs || [];
  const ready = list.data?.ready;
  const working = jobs.some((job) => job.status === "working");

  // Follow jobs while any part is still being made.
  useEffect(() => {
    if (!working) return;
    const timer = setInterval(list.reload, 2500);
    return () => clearInterval(timer);
  }, [working, list.reload]);

  const open = jobs.find((job) => job._id === openId) || null;
  const choose = (id: string) => {
    setOpenId(id);
    history.replaceState(null, "", id ? `#studio/${id}` : "#studio");
  };

  return (
    <div className="page studio">
      <div className="detail-head">
        <h1>Photo studio</h1>
        <span className="muted small-text">A plain photo in; shop photos and the write-up out.</span>
      </div>
      <Notice>{list.error}</Notice>
      {ready && !ready.images && <Notice tone="warn">Photos are not connected: the shop's photo service (Photoroom) needs its API key on the server. Write-ups still work.</Notice>}
      {ready && !ready.copy && <Notice tone="warn">Write-ups are not connected: Claude needs the brand's Anthropic API key on the server. Photos still work.</Notice>}
      {(ready?.images === "stand-in" || ready?.copy === "stand-in") && <Notice tone="warn">Demo mode: a stand-in returns the photo unchanged and a template write-up. Connect Photoroom and Claude for the real thing.</Notice>}

      <div className="studio-grid">
        <div className="studio-side">
          {canWrite && <NewPiece styles={styles.data?.styles || []} onStarted={(job) => (list.reload(), choose(job._id))} />}
          <section className="card">
            <h2>Recent</h2>
            {jobs.length === 0 && <p className="muted small-text">Nothing yet. Start with a photo of a piece.</p>}
            <ul className="studio-list">
              {jobs.map((job) => {
                const thumb = job.outputs.find((output) => output.kind === "white" && output.url)?.url || job.sources[0];
                return (
                  <li key={job._id}>
                    <button className={job._id === openId ? "on" : ""} onClick={() => choose(job._id)}>
                      <img src={thumb} alt="" />
                      <span>
                        <strong>{job.copy?.name || "New piece"}</strong>
                        <span className="muted small-text">
                          {ago(job.createdAt)} · {job.status === "working" ? "making…" : job.appliedTo ? "applied" : "ready to check"}
                        </span>
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          </section>
        </div>
        <div className="studio-main">
          {open ? <JobView key={open._id} job={open} styles={styles.data?.styles || []} canWrite={canWrite} canEditStyles={canEditStyles} onChanged={list.reload} /> : <div className="empty-card card muted">Upload a photo, or open a piece on the left.</div>}
        </div>
      </div>
    </div>
  );
}

function NewPiece({ styles, onStarted }: { styles: Style[]; onStarted: (job: StudioJob) => void }) {
  const [photos, setPhotos] = useState<string[]>([]);
  const [notes, setNotes] = useState("");
  const [styleId, setStyleId] = useState("");
  const [extras, setExtras] = useState({ model: false, ghost: false });
  const [uploading, setUploading] = useState(false);
  const { busy, error, run, setError } = useRun();
  const input = useRef<HTMLInputElement>(null);

  async function add(files: FileList | null) {
    if (!files?.length) return;
    setUploading(true);
    setError("");
    try {
      const urls: string[] = [];
      for (const file of [...files].slice(0, 4 - photos.length)) urls.push(await uploadPhoto(file));
      setPhotos((list) => [...list, ...urls].slice(0, 4));
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      setUploading(false);
      if (input.current) input.current.value = "";
    }
  }

  const start = () =>
    run(async () => {
      const { job } = await api<{ job: StudioJob }>("/api/studio/jobs", { method: "POST", body: { images: photos, notes: notes.trim(), extras, ...(styleId ? { styleId } : {}) } });
      setPhotos([]);
      setNotes("");
      setStyleId("");
      setExtras({ model: false, ghost: false });
      onStarted(job);
    });

  return (
    <section className="card">
      <h2>New piece</h2>
      <div className="shots">
        {photos.map((url) => (
          <figure key={url}>
            <img src={url} alt="" />
            <button className="btn small" onClick={() => setPhotos((list) => list.filter((item) => item !== url))} aria-label="Remove photo">
              ×
            </button>
          </figure>
        ))}
        {photos.length < 4 && (
          <label className="shot-add">
            <input ref={input} type="file" accept="image/jpeg,image/png,image/webp" capture="environment" multiple onChange={(event) => add(event.target.files)} />
            <span>{uploading ? "Uploading…" : photos.length ? "+ another angle" : "+ Take or add a photo"}</span>
          </label>
        )}
      </div>
      <p className="muted small-text">The first photo is the main one. Plain light, the whole piece in frame; a hanger or a flat surface is fine.</p>
      <div className="field">
        <label htmlFor="studio-notes">Notes for the write-up</label>
        <textarea id="studio-notes" className="input" rows={2} value={notes} onChange={(event) => setNotes(event.target.value)} placeholder="Fabric, lining, stretch, price, anything the photo can't show" maxLength={600} />
      </div>
      <div className="field">
        <label htmlFor="studio-style">For a style already in the catalogue (optional)</label>
        <select id="studio-style" className="input" value={styleId} onChange={(event) => setStyleId(event.target.value)}>
          <option value="">New piece</option>
          {styles.map((style) => (
            <option key={style._id} value={style._id}>
              {style.code} · {style.name}
            </option>
          ))}
        </select>
      </div>
      <label className="check">
        <input type="checkbox" checked={extras.model} onChange={(event) => setExtras({ ...extras, model: event.target.checked })} /> Also on a model (AI)
      </label>
      <label className="check">
        <input type="checkbox" checked={extras.ghost} onChange={(event) => setExtras({ ...extras, ghost: event.target.checked })} /> Also as a ghost mannequin (AI)
      </label>
      <Notice>{error}</Notice>
      <button className="btn primary" onClick={start} disabled={busy || uploading || !photos.length}>
        Make photos and write-up
      </button>
    </section>
  );
}

interface Draft {
  name: string;
  category: string;
  outfitPart: string;
  colour: string;
  fabric: string;
  pattern: string;
  fit: string;
  neckline: string;
  sleeve: string;
  occasion: string;
  description: string;
  highlights: string;
  caption: string;
  hashtags: string;
  altText: string;
}

function draftFrom(copy: StudioCopy | null, style?: Style): Draft {
  return {
    name: copy?.name || style?.name || "",
    category: copy?.category && copy.category !== "other" ? copy.category : style?.category || "dresses",
    outfitPart: copy?.outfitPart && copy.outfitPart !== "other" ? copy.outfitPart : style?.outfitPart || "",
    colour: copy?.colour || style?.attributes?.colour || "",
    fabric: style?.attributes?.fabric || copy?.fabricLooksLike || "",
    pattern: copy?.pattern || style?.attributes?.pattern || "",
    fit: copy?.fit || style?.attributes?.fit || "",
    neckline: copy?.neckline || style?.attributes?.neckline || "",
    sleeve: copy?.sleeve || style?.attributes?.sleeve || "",
    occasion: (copy?.occasion?.length ? copy.occasion : style?.attributes?.occasion || []).join(", "),
    description: copy?.websiteDescription || style?.description || "",
    highlights: (copy?.highlights || []).join("\n"),
    caption: copy?.instagramCaption || "",
    hashtags: (copy?.hashtags || []).map((tag) => `#${tag}`).join(" "),
    altText: copy?.altText || "",
  };
}

function JobView({ job, styles, canWrite, canEditStyles, onChanged }: { job: StudioJob; styles: Style[]; canWrite: boolean; canEditStyles: boolean; onChanged: () => void }) {
  const linked = styles.find((style) => style._id === job.styleId);
  const [draft, setDraft] = useState<Draft>(() => draftFrom(job.copy, linked));
  const [seenCopy, setSeenCopy] = useState(Boolean(job.copy));
  const [picked, setPicked] = useState<string[]>([]);
  const [target, setTarget] = useState<"existing" | "new">((job.appliedTo || job.styleId) && canEditStyles ? "existing" : "new");
  const [styleId, setStyleId] = useState(job.appliedTo || job.styleId || "");
  const [fresh, setFresh] = useState({ code: "", sizes: "S M L", price: "" });
  const [checked, setChecked] = useState(false);
  const [done, setDone] = useState("");
  const [copied, setCopied] = useState("");
  const { busy, error, run } = useRun();

  // The write-up arrives after the job opened: fill the form once.
  useEffect(() => {
    if (job.copy && !seenCopy) {
      setDraft(draftFrom(job.copy, linked));
      setSeenCopy(true);
    }
  }, [job.copy, seenCopy, linked]);

  // Pick the clean white and brand photos by default once they are made.
  const madeUrls = useMemo(() => job.outputs.filter((output) => output.status === "done" && !output.generated).map((output) => output.url), [job.outputs]);
  useEffect(() => {
    setPicked((list) => (list.length ? list : madeUrls));
  }, [madeUrls]);

  const set = (key: keyof Draft) => (event: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>) => setDraft({ ...draft, [key]: event.target.value });
  const toggle = (url: string) => setPicked((list) => (list.includes(url) ? list.filter((item) => item !== url) : [...list, url]));
  const toCheck = job.copy?.toCheck || [];
  const canRetry = job.outputs.some((output) => output.status === "failed" || output.status === "skipped") || job.copyStatus === "failed" || job.copyStatus === "skipped";
  const tags = draft.hashtags.split(/[\s,]+/).map((tag) => tag.replace(/^#/, "").trim()).filter(Boolean);

  async function copyText(label: string, text: string) {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(`${label} copied.`);
    } catch {
      setCopied("Copy did not work here: select the text and copy it.");
    }
  }

  const retry = () => run(async () => (await api(`/api/studio/jobs/${job._id}/retry`, { method: "POST", body: {} }), onChanged()));

  const apply = () =>
    run(async () => {
      if (toCheck.length && !checked) throw new Error("Tick that you checked the points above first.");
      const price = Number(fresh.price.replace(/[, ]/g, ""));
      if (target === "new" && !(price > 0)) throw new Error("Give the new style's selling price in rupees.");
      const body = {
        ...(target === "existing" ? { styleId } : { newStyle: { code: fresh.code.trim().toUpperCase(), sizes: fresh.sizes.split(/[\s,]+/).filter(Boolean), price } }),
        images: picked,
        name: draft.name.trim() || undefined,
        category: draft.category,
        description: draft.description.trim(),
        outfitPart: draft.outfitPart,
        highlights: draft.highlights.split("\n").map((line) => line.trim()).filter(Boolean).slice(0, 6),
        altText: draft.altText.trim(),
        instagramCaption: draft.caption.trim(),
        hashtags: tags.slice(0, 30),
        attributes: { colour: draft.colour.trim(), fabric: draft.fabric.trim(), pattern: draft.pattern.trim(), fit: draft.fit.trim(), neckline: draft.neckline.trim(), sleeve: draft.sleeve.trim(), occasion: draft.occasion.split(",").map((item) => item.trim()).filter(Boolean).slice(0, 6) },
      };
      const result = await api<{ style: { code: string; status: string } }>(`/api/studio/jobs/${job._id}/apply`, { method: "POST", body });
      setDone(`Applied to ${result.style.code}${result.style.status === "draft" ? " (a draft: add stock and put it live in the catalogue)" : ""}.`);
      onChanged();
    });

  const photos = [
    ...job.sources.map((url, index) => ({ key: url, url, label: index === 0 ? "Your photo" : `Your photo ${index + 1}`, status: "done" as const, generated: false, error: "" })),
    ...job.outputs.map((output) => ({ key: output.kind, url: output.url, label: KIND_LABEL[output.kind], status: output.status, generated: output.generated, error: output.error })),
  ];

  return (
    <div className="studio-job">
      <section className="card">
        <div className="detail-head">
          <h2>Photos</h2>
          <span className="muted small-text">Tick the ones to use, in order: the first ticked is the main photo.</span>
          {canWrite && canRetry && job.status === "ready" && (
            <button className="btn small" onClick={retry} disabled={busy}>
              Try failed parts again
            </button>
          )}
        </div>
        <div className="studio-photos">
          {photos.map((photo) => {
            const order = picked.indexOf(photo.url);
            return (
              <figure key={photo.key} className={order >= 0 ? "on" : ""}>
                <div className="frame">
                  {photo.status === "done" && photo.url ? <img src={photo.url} alt={photo.label} /> : <div className={`placeholder ${photo.status}`}>{photo.status === "queued" ? "Making…" : photo.status === "skipped" ? "Not connected" : "Failed"}</div>}
                  {order >= 0 && <span className="order">{order + 1}</span>}
                </div>
                <figcaption>
                  <strong>{photo.label}</strong>
                  {photo.generated && photo.status === "done" && <span className="badge warn">AI: check it matches the real piece</span>}
                  {photo.error && photo.status !== "done" && <span className="muted small-text">{photo.error}</span>}
                  {photo.status === "done" && photo.url && canWrite && (
                    <label className="check">
                      <input type="checkbox" checked={order >= 0} onChange={() => toggle(photo.url)} /> Use
                    </label>
                  )}
                </figcaption>
              </figure>
            );
          })}
        </div>
      </section>

      <section className="card">
        <div className="detail-head">
          <h2>Write-up</h2>
          <span className="muted small-text">{job.copyStatus === "queued" ? "Writing…" : job.copy ? `Written by ${job.copy.writtenBy}. Edit anything.` : ""}</span>
        </div>
        {job.copyStatus === "failed" && <Notice>{job.copyError}</Notice>}
        {job.copyStatus === "skipped" && <Notice tone="warn">{job.copyError}. Fill it in by hand, or connect Claude and try again.</Notice>}
        {toCheck.length > 0 && (
          <div className="notice warn" role="status">
            <strong>Check before it goes out:</strong>
            <ul>
              {toCheck.map((line) => (
                <li key={line}>{line}</li>
              ))}
            </ul>
            <label className="check">
              <input type="checkbox" checked={checked} onChange={(event) => setChecked(event.target.checked)} /> I checked these and fixed the words below
            </label>
          </div>
        )}
        <fieldset disabled={!canWrite || job.copyStatus === "queued"}>
          <div className="form-grid">
            <div className="field span-2">
              <label htmlFor="d-name">Name</label>
              <input id="d-name" className="input" value={draft.name} onChange={set("name")} />
            </div>
            <div className="field">
              <label htmlFor="d-cat">Category</label>
              <select id="d-cat" className="input" value={draft.category} onChange={set("category")}>
                {CATEGORIES.map((category) => (
                  <option key={category}>{category}</option>
                ))}
              </select>
            </div>
            <div className="field">
              <label htmlFor="d-colour">Colour</label>
              <input id="d-colour" className="input" value={draft.colour} onChange={set("colour")} />
            </div>
            <div className="field">
              <label htmlFor="d-fabric">Fabric (confirm it)</label>
              <input id="d-fabric" className="input" value={draft.fabric} onChange={set("fabric")} />
            </div>
            <div className="field">
              <label htmlFor="d-part">Part of an outfit</label>
              <select id="d-part" className="input" value={draft.outfitPart} onChange={set("outfitPart")}>
                <option value="">From the category</option>
                <option value="dress">Dress / co-ord</option>
                <option value="top">Top</option>
                <option value="bottom">Bottom</option>
                <option value="layer">Layer</option>
                <option value="other">Not in picks</option>
              </select>
            </div>
            <div className="field">
              <label htmlFor="d-pattern">Pattern</label>
              <input id="d-pattern" className="input" value={draft.pattern} onChange={set("pattern")} />
            </div>
            <div className="field">
              <label htmlFor="d-fit">Fit</label>
              <input id="d-fit" className="input" value={draft.fit} onChange={set("fit")} />
            </div>
            <div className="field">
              <label htmlFor="d-occ">Occasions</label>
              <input id="d-occ" className="input" value={draft.occasion} onChange={set("occasion")} />
            </div>
            <div className="field span-3">
              <label htmlFor="d-desc">Website description</label>
              <textarea id="d-desc" className="input" rows={4} value={draft.description} onChange={set("description")} />
            </div>
            <div className="field span-3">
              <label htmlFor="d-high">Selling points (one per line)</label>
              <textarea id="d-high" className="input" rows={3} value={draft.highlights} onChange={set("highlights")} />
            </div>
            <div className="field span-3">
              <label htmlFor="d-cap">Instagram caption</label>
              <textarea id="d-cap" className="input" rows={4} value={draft.caption} onChange={set("caption")} />
            </div>
            <div className="field span-3">
              <label htmlFor="d-tags">Hashtags</label>
              <input id="d-tags" className="input" value={draft.hashtags} onChange={set("hashtags")} />
            </div>
            <div className="field span-3">
              <label htmlFor="d-alt">Photo description for screen readers (alt text)</label>
              <input id="d-alt" className="input" value={draft.altText} onChange={set("altText")} />
            </div>
          </div>
        </fieldset>
        <div className="studio-copy-actions">
          <button className="btn small" onClick={() => copyText("Caption", `${draft.caption.trim()}\n\n${tags.map((tag) => `#${tag}`).join(" ")}`)} disabled={!draft.caption.trim()}>
            Copy Instagram caption
          </button>
          <button className="btn small" onClick={() => copyText("Description", draft.description.trim())} disabled={!draft.description.trim()}>
            Copy description
          </button>
          <span className="muted small-text">{copied}</span>
        </div>
      </section>

      {canWrite && (
        <section className="card">
          <h2>Apply</h2>
          {job.appliedTo && <Notice tone="ok">Already applied to a style {job.appliedAt ? ago(job.appliedAt) : ""}.{canEditStyles ? " Choose it below to update it." : ""}</Notice>}
          {canEditStyles ? (
            <div className="chips">
              <button className={`chip${target === "existing" ? " on" : ""}`} onClick={() => setTarget("existing")}>
                A style in the catalogue
              </button>
              <button className={`chip${target === "new" ? " on" : ""}`} onClick={() => setTarget("new")}>
                A new draft style
              </button>
            </div>
          ) : (
            <p className="muted small-text">This makes a new draft style. A manager checks it, adds stock and puts it live; to change a style already in the catalogue, ask a manager.</p>
          )}
          {target === "existing" ? (
            <div className="field">
              <label htmlFor="apply-style">Style</label>
              <select id="apply-style" className="input" value={styleId} onChange={(event) => setStyleId(event.target.value)}>
                <option value="">Choose a style</option>
                {styles.map((style) => (
                  <option key={style._id} value={style._id}>
                    {style.code} · {style.name}
                  </option>
                ))}
              </select>
            </div>
          ) : (
            <div className="form-grid">
              <div className="field">
                <label htmlFor="new-code">Style code</label>
                <input id="new-code" className="input" value={fresh.code} onChange={(event) => setFresh({ ...fresh, code: event.target.value })} placeholder="DRS-014" />
              </div>
              <div className="field">
                <label htmlFor="new-sizes">Sizes</label>
                <input id="new-sizes" className="input" value={fresh.sizes} onChange={(event) => setFresh({ ...fresh, sizes: event.target.value })} />
              </div>
              <div className="field">
                <label htmlFor="new-price">Selling price, Rs (GST included)</label>
                <input id="new-price" className="input" inputMode="decimal" value={fresh.price} onChange={(event) => setFresh({ ...fresh, price: event.target.value })} />
              </div>
            </div>
          )}
          <p className="muted small-text">{picked.length ? `${picked.length} photo${picked.length === 1 ? "" : "s"} chosen.` : "No photos chosen: only the words will change."}{" "}
            {target === "new" ? "The new style starts as a draft: nobody sees it until it has stock and is put live in the catalogue." : "The style stays as it is (draft or live); a live style's changes reach the WhatsApp and Instagram catalogue within minutes."}</p>
          <Notice>{error}</Notice>
          <Notice tone="ok">{done}</Notice>
          <button className="btn primary" onClick={apply} disabled={busy || job.status === "working" || (target === "existing" ? !styleId : !fresh.code.trim())}>
            Apply to {target === "existing" ? "this style" : "a new draft style"}
          </button>
        </section>
      )}
    </div>
  );
}
