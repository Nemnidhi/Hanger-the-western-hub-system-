import JsBarcode from "jsbarcode";
import QRCode from "qrcode";

// Price tags for the label printer (the 4Barcode rolls are 2 x 1 inch). One tag per piece: the
// brand, the piece's name, the size, MRP (GST included), a Code 128 barcode of the size code, and the
// size code in large type under it so staff can type it when the scanner does not read the tag.
// Drawn as SVG in millimetres; the bars are whole printer dots wide (0.125 mm at 203 dpi) so they
// stay sharp.

export interface TagItem {
  code: string; // size code, DRS-015-M: what the barcode carries
  name: string;
  size: string;
  pricePaise: number;
}

export interface TagLook {
  brandLine: string;
  qrUrl: string;
  footer: string;
  showName: boolean;
  widthMm: number;
  heightMm: number;
}

export const DEFAULT_LOOK: TagLook = { brandLine: "", qrUrl: "", footer: "", showName: true, widthMm: 50.8, heightMm: 25.4 };

export const TAG_SIZES = [
  { label: '2 x 1 inch (50 x 25 mm)', widthMm: 50.8, heightMm: 25.4 },
  { label: "50 x 30 mm", widthMm: 50, heightMm: 30 },
  { label: "40 x 30 mm", widthMm: 40, heightMm: 30 },
  { label: "60 x 40 mm", widthMm: 60, heightMm: 40 },
];

const DOT = 0.125; // mm per dot at 203 dpi
const esc = (text: string) => text.replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch] as string);
const fit = (text: string, max: number) => (text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text);
const price = (paise: number) => `MRP ₹${(paise / 100).toLocaleString("en-IN", { maximumFractionDigits: 2 })}`;

/** The bars of a Code 128 barcode as a string of 1s (bar) and 0s (space), one per module. */
export function code128(text: string): string {
  const out: { encodings?: { data: string }[] } = {};
  JsBarcode(out, text, { format: "CODE128" });
  return (out.encodings || []).map((part) => part.data).join("");
}

/** Filled runs of a row of modules, as SVG rects. */
function runs(bits: string, x0: number, y: number, unit: number, height: number): string {
  let svg = "";
  for (let start = 0; start < bits.length; ) {
    if (bits[start] !== "1") {
      start += 1;
      continue;
    }
    let end = start;
    while (bits[end] === "1") end += 1;
    svg += `<rect x="${(x0 + start * unit).toFixed(3)}" y="${y.toFixed(3)}" width="${((end - start) * unit).toFixed(3)}" height="${height.toFixed(3)}"/>`;
    start = end;
  }
  return svg;
}

function qrRects(text: string, x0: number, y0: number, sizeMm: number): string {
  const qr = QRCode.create(text, { errorCorrectionLevel: "M" });
  const count = qr.modules.size;
  const unit = sizeMm / count;
  let svg = "";
  for (let row = 0; row < count; row += 1) {
    let bits = "";
    for (let col = 0; col < count; col += 1) bits += qr.modules.get(row, col) ? "1" : "0";
    svg += runs(bits, x0, y0 + row * unit, unit, unit + 0.01);
  }
  return svg;
}

/** One tag as an SVG string, sized in millimetres. */
export function tagSvg(item: TagItem, look: TagLook, brandName: string): string {
  const W = look.widthMm;
  const H = look.heightMm;
  const k = Math.min(W / 50.8, H / 25.4); // type scale against the 2 x 1 inch layout
  const pad = 1.8 * k;
  const brand = (look.brandLine || brandName || "").toUpperCase();
  const qrUrl = look.qrUrl ? look.qrUrl.replace(/\{code\}/g, encodeURIComponent(item.code)) : "";
  const qrSize = qrUrl ? Math.min(12.5 * k, H * 0.5) : 0;
  const textWidth = W - pad * 2 - (qrSize ? qrSize + 1.5 : 13 * k);
  const chars = (size: number) => Math.max(6, Math.floor(textWidth / (size * 0.52)));

  // Bottom block: the barcode, then the code to type.
  const codeSize = 2.6 * k;
  const codeBase = H - pad * 0.6;
  const barBottom = codeBase - codeSize - 0.5 * k;
  const barHeight = Math.max(4.5, H * 0.22);
  const barTop = barBottom - barHeight;
  const bits = code128(item.code);
  const quiet = 10; // modules of white each side, so scanners find the start
  const room = W - pad * 2;
  let unit = Math.max(DOT, Math.floor(room / (bits.length + quiet * 2) / DOT) * DOT);
  if ((bits.length + quiet * 2) * unit > room) unit = room / (bits.length + quiet * 2); // very long code: fit it
  const barX = (W - bits.length * unit) / 2;

  // Top block: brand, name, size and price on the left; QR on the right.
  const lines: string[] = [];
  let y = pad + 2.6 * k;
  if (brand) {
    lines.push(`<text x="${pad}" y="${y}" font-size="${2.9 * k}" font-weight="700" letter-spacing="${0.45 * k}">${esc(fit(brand, chars(2.9 * k * 1.15)))}</text>`);
    y += 2.9 * k;
  }
  if (look.showName && item.name) {
    lines.push(`<text x="${pad}" y="${y}" font-size="${2.1 * k}">${esc(fit(item.name, chars(2.1 * k)))}</text>`);
    y += 3.1 * k;
  } else y += 0.6 * k;
  // The size: large in its own box on the right when there is no QR, else after the price.
  const sizeBox = !qrSize;
  lines.push(`<text x="${pad}" y="${y}" font-size="${3.1 * k}" font-weight="700">${esc(price(item.pricePaise))}${sizeBox ? "" : `<tspan font-size="${2.3 * k}" font-weight="700" dx="${1.4 * k}">Size ${esc(item.size)}</tspan>`}</text>`);
  y += 2.1 * k;
  lines.push(`<text x="${pad}" y="${y}" font-size="${1.55 * k}">(Incl. of all taxes)</text>`);
  if (sizeBox) {
    const boxW = Math.max(9 * k, Math.min(16 * k, (item.size.length * 3.6 + 3) * k));
    const boxH = Math.min(12 * k, barTop - pad * 0.8 - 1);
    const boxX = W - pad - boxW;
    const boxY = pad * 0.8;
    const big = Math.min(6.2 * k, (boxW - 2 * k) / Math.max(1, item.size.length * 0.62));
    lines.push(`<rect x="${boxX}" y="${boxY}" width="${boxW}" height="${boxH}" rx="${0.9 * k}" fill="none" stroke="#000" stroke-width="${0.3 * k}"/>`);
    lines.push(`<text x="${boxX + boxW / 2}" y="${boxY + 2.4 * k}" font-size="${1.5 * k}" text-anchor="middle" letter-spacing="${0.3 * k}">SIZE</text>`);
    lines.push(`<text x="${boxX + boxW / 2}" y="${boxY + boxH - 1.6 * k}" font-size="${big}" font-weight="700" text-anchor="middle">${esc(item.size)}</text>`);
  }

  const qr = qrSize ? qrRects(qrUrl, W - pad - qrSize, pad * 0.8, qrSize) : "";
  const footer = look.footer && qrSize ? `<text x="${W - pad - qrSize / 2}" y="${Math.min(pad * 0.8 + qrSize + 1.8 * k, barTop - 0.4)}" font-size="${1.45 * k}" text-anchor="middle">${esc(fit(look.footer, 22))}</text>` : look.footer ? `<text x="${W - pad}" y="${pad + 2.6 * k}" font-size="${1.6 * k}" text-anchor="end">${esc(fit(look.footer, 22))}</text>` : "";

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}mm" height="${H}mm" viewBox="0 0 ${W} ${H}" font-family="Arial, Helvetica, 'Noto Sans', sans-serif" fill="#000"><rect width="${W}" height="${H}" fill="#fff"/>${lines.join("")}${qr}${footer}<g>${runs(bits, barX, barTop, unit, barHeight)}</g><text x="${W / 2}" y="${codeBase}" font-size="${codeSize}" font-weight="700" text-anchor="middle" letter-spacing="${0.35 * k}">${esc(item.code)}</text></svg>`;
}

/** The tags as one printable page per tag, printed through a hidden frame (USB / desktop printer). */
export function printTags(svgs: string[], look: TagLook) {
  const frame = document.createElement("iframe");
  frame.setAttribute("aria-hidden", "true");
  Object.assign(frame.style, { position: "fixed", right: "0", bottom: "0", width: "0", height: "0", border: "0" });
  document.body.appendChild(frame);
  const doc = frame.contentDocument!;
  doc.open();
  doc.write(`<!doctype html><html><head><meta charset="utf-8"><title>Price tags</title><style>@page{size:${look.widthMm}mm ${look.heightMm}mm;margin:0}html,body{margin:0;padding:0}.tag{width:${look.widthMm}mm;height:${look.heightMm}mm;page-break-after:always;break-after:page;overflow:hidden}.tag:last-child{page-break-after:auto;break-after:auto}.tag svg{display:block}</style></head><body>${svgs.map((svg) => `<div class="tag">${svg}</div>`).join("")}</body></html>`);
  doc.close();
  setTimeout(() => {
    frame.contentWindow?.focus();
    frame.contentWindow?.print();
    setTimeout(() => frame.remove(), 60_000);
  }, 250);
}

/** One tag as a PNG for the 4Barcode app's picture printing (16 px per mm, about 400 dpi). */
export async function tagPng(svg: string, look: TagLook): Promise<Blob> {
  const scale = 16;
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(look.widthMm * scale);
  canvas.height = Math.round(look.heightMm * scale);
  // A data: URL, not a blob: one: the app's content security policy allows only 'self' and data: images.
  const image = new Image();
  image.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
  await image.decode();
  const context = canvas.getContext("2d")!;
  context.fillStyle = "#fff";
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.imageSmoothingEnabled = false;
  context.drawImage(image, 0, 0, canvas.width, canvas.height);
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/png"));
  if (!blob) throw new Error("Could not make the tag picture.");
  return blob;
}
