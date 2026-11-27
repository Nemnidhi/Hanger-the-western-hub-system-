export function rupees(paise: number | null | undefined): string {
  const value = (paise || 0) / 100;
  return `₹${value.toLocaleString("en-IN", { minimumFractionDigits: value % 1 ? 2 : 0, maximumFractionDigits: 2 })}`;
}

export const titleCase = (text: string) => text.replace(/(^|\s)\w/g, (letter) => letter.toUpperCase());

// Colour names from the catalogue, as a swatch. Unknown names get a neutral.
const COLOURS: Record<string, string> = {
  black: "#1f1a1e", white: "#f7f4ef", ivory: "#f3ecdf", cream: "#efe4cf", beige: "#dccbb0", camel: "#c39a6b", brown: "#7a5232", tan: "#b98a5e",
  grey: "#9b9a9c", gray: "#9b9a9c", navy: "#22304f", blue: "#4c6fa8", denim: "#5675a0", sky: "#9cc3e4", teal: "#2e7d7a", green: "#4f7a52",
  sage: "#9caf88", olive: "#7d7a45", mint: "#bfe0cc", yellow: "#e9c84c", mustard: "#c9a227", orange: "#e08a3c", rust: "#a8502d", red: "#b5302f",
  maroon: "#6d1f2c", wine: "#7a2e4f", burgundy: "#6a1d33", pink: "#e7a3b5", blush: "#f0c9c6", rose: "#d98a96", lilac: "#c6b2dd", lavender: "#c9bce6",
  purple: "#6f4a8e", gold: "#c9a45c", silver: "#c7c7cc", peach: "#f3c1a2", coral: "#ee7f6d", khaki: "#b7a77a",
};
export function swatch(colour: string): string {
  const words = colour.toLowerCase().split(/[\s/-]+/).reverse();
  for (const word of words) if (COLOURS[word]) return COLOURS[word];
  return "#cfc5bd";
}

// A soft backdrop per style, behind its photo (and in place of one not taken yet).
const BACKDROPS = ["#f3dcd9", "#ecdcc4", "#e4e8dc", "#e3e1ef", "#f6e3b4", "#efd9e2"];
export function backdrop(code: string): string {
  let sum = 0;
  for (const letter of code) sum += letter.charCodeAt(0);
  return BACKDROPS[sum % BACKDROPS.length];
}

export const OCCASION_WORDS: Record<string, { title: string; line: string }> = {
  party: { title: "Party", line: "Sequins, satin and the dress that gets asked about" },
  brunch: { title: "Brunch", line: "Linen, florals and easy co-ords for long Sundays" },
  work: { title: "Work", line: "Sharp shirts and trousers that go on to dinner" },
  office: { title: "Office", line: "Sharp shirts and trousers that go on to dinner" },
  vacation: { title: "Vacation", line: "Packs flat, photographs well" },
  date: { title: "Date night", line: "Soft, a little daring" },
  festive: { title: "Festive", line: "Fusion pieces for the season of everything" },
  casual: { title: "Every day", line: "Denim, tees and the jacket you live in" },
  college: { title: "College", line: "Easy layers for long days" },
  wedding: { title: "Wedding guest", line: "Dressy without the fuss" },
};
export const occasionWords = (key: string) => OCCASION_WORDS[key] || { title: titleCase(key), line: "Pieces picked for it" };
