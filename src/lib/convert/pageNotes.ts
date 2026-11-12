/**
 * The notes a converter writes about the original's pages: its size, where
 * each page ended, and the page's number. lib/pages.ts reads them back and
 * explains the format; they live here so the converters depend on nothing
 * outside this folder, which is shared with the MCP package.
 *
 * Kept identical to the copy in the Windows app. Change one, copy it across.
 */
export const PAGE_BREAK = '<!-- suprasuta:page-break -->'

/** A page break that also records the number of the page starting after it. */
export function pageBreakLine(nextPage: number): string {
  return `<!-- suprasuta:page-break page="${nextPage}" -->`
}

/**
 * The page's number, written at the end of its text like a footer: a small
 * plain line that any Markdown app shows as it is, and this app shows small,
 * grey and to the right ("Page 3 of 120").
 */
export function pageNumberLine(page: number): string {
  return `— ${page} —`
}

/** Matches a page-number line (the whole line); group 1 is the number. */
export const PAGE_NUMBER_LINE = /^— (\d{1,5}) —$/

/** Width and height in points (1/72 inch), as a PDF gives them. */
export function pageSizeLine(width: number, height: number): string {
  const r = (n: number): number => Math.round(n * 10) / 10
  return `<!-- suprasuta:page-size width="${r(width)}" height="${r(height)}" -->`
}
