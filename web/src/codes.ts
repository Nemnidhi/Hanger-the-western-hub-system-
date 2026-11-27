// Size codes typed by hand: "drs015m", "DRS 015 M" and "DRS-015-M" are the same code, so staff can
// type the code from the price tag when the scanner does not read it.

/** The code with only its letters and digits, upper-cased. */
export const squash = (text: string) => text.toUpperCase().replace(/[^A-Z0-9]/g, "");

/** True when what was scanned or typed is this size's code or its own barcode. */
export const sameCode = (term: string, code: string, barcode = "") => {
  const typed = squash(term);
  return Boolean(typed) && (squash(code) === typed || (Boolean(barcode) && squash(barcode) === typed));
};

/** True when the typed text is part of the code ("015" finds DRS-015-M). */
export const codeHas = (code: string, term: string) => {
  const typed = squash(term);
  return typed.length >= 2 && squash(code).includes(typed);
};
