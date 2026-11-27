import { useMemo, useState } from "react";
import { Dialog, Notice, useLoad } from "../ui";
import { DEFAULT_LOOK, printTags, tagPng, tagSvg, type TagItem, type TagLook } from "../tags";
import type { Settings } from "../types";

// Printing price tags: how many of each size, a preview, then either the computer's printer (the
// label printer on USB) or pictures for the 4Barcode phone app ("Pictures Printing").

export interface TagLine {
  item: TagItem;
  qty: number;
  stock?: number; // pieces on hand, offered as the count
}

const MAX_TAGS = 300;

export function useTagLook() {
  const settings = useLoad<{ settings: Settings }>("/api/settings");
  const look: TagLook = { ...DEFAULT_LOOK, ...(settings.data?.settings.tags || {}) };
  return { look, brandName: settings.data?.settings.brandName || "" };
}

export function TagPreview({ item, look, brandName }: { item: TagItem; look: TagLook; brandName: string }) {
  const svg = useMemo(() => tagSvg(item, look, brandName), [item, look, brandName]);
  return <div className="tag-preview" role="img" aria-label={`Price tag for ${item.code}`} dangerouslySetInnerHTML={{ __html: svg }} />;
}

export function TagDialog({ title, lines: initial, onClose }: { title: string; lines: TagLine[]; onClose: () => void }) {
  const { look, brandName } = useTagLook();
  const [lines, setLines] = useState(initial);
  const [error, setError] = useState("");
  const [files, setFiles] = useState<File[] | null>(null);
  const [making, setMaking] = useState(false);
  const total = lines.reduce((sum, line) => sum + line.qty, 0);
  const hasStock = lines.some((line) => line.stock !== undefined);
  const setQty = (code: string, qty: number) => (setFiles(null), setLines(lines.map((line) => (line.item.code === code ? { ...line, qty: Math.max(0, Math.min(500, Math.floor(qty) || 0)) } : line))));
  const svgs = () => lines.flatMap((line) => Array.from({ length: line.qty }, () => tagSvg(line.item, look, brandName)));

  function onPrint() {
    setError("");
    if (!total) return setError("Choose how many tags to print.");
    if (total > MAX_TAGS) return setError(`Print at most ${MAX_TAGS} tags at a time.`);
    printTags(svgs(), look);
  }

  async function makePictures() {
    setError("");
    if (!total) return setError("Choose how many tags to print.");
    if (total > 60) return setError("For pictures, make at most 60 tags at a time (or print from a computer).");
    setMaking(true);
    try {
      const made: File[] = [];
      for (const line of lines) {
        if (!line.qty) continue;
        const png = await tagPng(tagSvg(line.item, look, brandName), look);
        for (let copy = 1; copy <= line.qty; copy += 1) made.push(new File([png], `${line.item.code}${line.qty > 1 ? `-${copy}` : ""}.png`, { type: "image/png" }));
      }
      setFiles(made);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      setMaking(false);
    }
  }

  async function sharePictures() {
    if (!files) return;
    setError("");
    try {
      if (navigator.canShare?.({ files })) {
        await navigator.share({ files, title: "Price tags" });
        return;
      }
    } catch (failure) {
      if (failure instanceof DOMException && failure.name === "AbortError") return;
    }
    // No share sheet (a computer): save the pictures instead.
    for (const file of files) {
      const link = document.createElement("a");
      link.href = URL.createObjectURL(file);
      link.download = file.name;
      link.click();
      setTimeout(() => URL.revokeObjectURL(link.href), 10_000);
    }
  }

  return (
    <Dialog title={title} onClose={onClose} wide>
      {lines[0] && <TagPreview item={lines[0].item} look={look} brandName={brandName} />}
      <p className="muted small-text">
        The code under the barcode is what the scanner reads. If the scanner can't read a tag, type that code at the counter (with or without the dashes).
      </p>
      <table className="table plain tag-lines">
        <tbody>
          {lines.map((line) => (
            <tr key={line.item.code}>
              <td>
                <strong>{line.item.code}</strong> <span className="muted">{line.item.name}</span>
              </td>
              {hasStock && <td className="muted small-text num">{line.stock ?? 0} in stock</td>}
              <td className="num">
                <input className="input qty-input" type="number" min={0} max={500} value={line.qty} onChange={(event) => setQty(line.item.code, Number(event.target.value))} aria-label={`Tags for ${line.item.code}`} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="row-actions">
        {hasStock && (
          <button className="btn small" onClick={() => (setFiles(null), setLines(lines.map((line) => ({ ...line, qty: line.stock ?? 0 }))))}>
            One per piece in stock
          </button>
        )}
        <span className="muted small-text">
          {total} tag{total === 1 ? "" : "s"} · {look.widthMm} x {look.heightMm} mm
        </span>
      </div>
      <Notice>{error}</Notice>
      <div className="tag-actions">
        <div>
          <button className="btn primary" onClick={onPrint} disabled={!total}>
            Print
          </button>
          <span className="muted small-text">From a computer, with the label printer on USB. Set the paper to the label size and scale to 100%.</span>
        </div>
        <div>
          {files ? (
            <button className="btn primary" onClick={sharePictures}>
              Save / share {files.length} picture{files.length === 1 ? "" : "s"}
            </button>
          ) : (
            <button className="btn" onClick={makePictures} disabled={!total || making}>
              {making ? "Making…" : "Pictures for the 4Barcode app"}
            </button>
          )}
          <span className="muted small-text">On a phone: save the pictures, then in 4Barcode open Pictures Printing and pick them.</span>
        </div>
      </div>
    </Dialog>
  );
}
