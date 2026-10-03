/**
 * The languages offline OCR can read, and the user's choice among them.
 *
 * Tesseract reads only the scripts it has a model for. With English alone it
 * turned a Kannada scan into confident-looking Latin nonsense, so the reader
 * has to be told which language the pages are in. Several can be chosen
 * together (`kan+eng`) for documents that mix them, at some cost in speed.
 *
 * Built in: English, Kannada and Hindi, staged into the app by
 * scripts/tesseract-assets.mjs, whose LANGUAGES list must match this one
 * (tests/ocrLanguages.test.ts checks). Other languages are to come as a
 * one-off download.
 *
 * Lives in the converter folder, which is kept identical across the Windows
 * app, the web app and the MCP package (scripts/sync-converters.mjs there), so
 * that folder depends on nothing outside itself. lib/ocrLanguages.ts
 * re-exports it for the rest of the app.
 */
export interface OcrLanguage {
  /** Tesseract's code, which is also the model's file name. */
  code: string
  name: string
  /** The language's own name for itself, shown beside the English one. */
  native: string
}

export const BUILT_IN_OCR_LANGUAGES: readonly OcrLanguage[] = [
  { code: 'eng', name: 'English', native: 'English' },
  { code: 'kan', name: 'Kannada', native: 'ಕನ್ನಡ' },
  { code: 'hin', name: 'Hindi', native: 'हिन्दी' }
]

export const DEFAULT_OCR_LANGUAGES: readonly string[] = ['eng']

/**
 * Cleans a saved or passed-in choice: unknown codes dropped, order fixed to
 * the list above, never empty. A setting written by a later version that knew
 * more languages degrades to what this one can read rather than failing.
 */
export function normaliseOcrLanguages(value: unknown): string[] {
  const chosen = Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : []
  const known = BUILT_IN_OCR_LANGUAGES.map((l) => l.code).filter((code) => chosen.includes(code))
  return known.length ? known : [...DEFAULT_OCR_LANGUAGES]
}

/** "Kannada", "Kannada and English", "Kannada, Hindi and English". */
export function describeOcrLanguages(codes: readonly string[]): string {
  const names = codes.map((c) => BUILT_IN_OCR_LANGUAGES.find((l) => l.code === c)?.name ?? c)
  if (names.length <= 1) return names[0] ?? 'English'
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`
}

/**
 * Corrects one confusion Tesseract makes in Indian scripts: the anusvara (ಂ,
 * ं), a small circle written after a letter, read as the digit zero (೦, ०),
 * which looks the same. "ಬೆಂಗಳೂರು" came out as "ಬೆ೦ಗಳೂರು": it displays almost
 * identically, but no search for the word finds it. A zero straight after a
 * letter or vowel sign of the same script cannot be a digit there, so only
 * that case changes; a zero after a space or another digit is left alone.
 */
export function tidyOcrText(text: string): string {
  return text
    .replace(/(?<=[\u0C80-\u0CE3])\u0CE6/g, '\u0C82') // Kannada
    .replace(/(?<=[\u0900-\u0963])\u0966/g, '\u0902') // Devanagari (Hindi)
}

/**
 * Keeps the page's own line breaks in text read by OCR.
 *
 * Markdown joins the lines of a paragraph into one, so a scanned list such as
 * "Key figures: / Total revenue 4,820,000 / Operating margin 18 percent" ran
 * together into a single line, unlike the page it came from. Each line that
 * continues a paragraph now ends in a backslash, Markdown's hard line break,
 * which survives saving (trailing spaces, the other way, are stripped). Blank
 * lines between paragraphs stay as they are.
 */
export function keepOcrLineBreaks(text: string): string {
  return text
    .split(/\n{2,}/)
    .map((para) =>
      para
        .split('\n')
        .map((line) => line.trimEnd())
        .filter((line) => line.length > 0)
        .map((line, i, all) => (i < all.length - 1 && !line.endsWith('\\') ? `${line}\\` : line))
        .join('\n')
    )
    .filter((para) => para.length > 0)
    .join('\n\n')
}
