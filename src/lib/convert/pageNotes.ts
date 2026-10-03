/**
 * The invisible notes a converter writes about the original's pages: its size
 * and where each page ended. lib/pages.ts reads them back and explains the
 * format; they live here so the converters depend on nothing outside this
 * folder, which is shared with the MCP package.
 *
 * Kept identical to the copy in the Windows app. Change one, copy it across.
 */
export const PAGE_BREAK = '<!-- suprasuta:page-break -->'

/** Width and height in points (1/72 inch), as a PDF gives them. */
export function pageSizeLine(width: number, height: number): string {
  const r = (n: number): number => Math.round(n * 10) / 10
  return `<!-- suprasuta:page-size width="${r(width)}" height="${r(height)}" -->`
}
