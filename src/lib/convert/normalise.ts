/**
 * Markdown normalisation for converted documents.
 *
 * TypeScript port of `normalise_markdown` from the original Python converter.
 *
 * Why this exists: Markdown treats any line starting with four spaces or a tab
 * as an *indented code block*, and HTML inside a code block is escaped rather
 * than rendered. Text extracted from PDFs, Word files and plain .txt is prose,
 * never code, but it frequently arrives indented — and that is what stops
 * annotation tags from rendering on converted documents. Fenced blocks
 * (``` or ~~~) are left untouched.
 */

const FENCE = /^\s*(```|~~~)/
const LIST_MARKER = /^([-*+]\s+|\d+[.)]\s+)/

export function normaliseMarkdown(text: string): string {
  const lines = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n')
  const out: string[] = []
  let inFence = false

  for (const line of lines) {
    if (FENCE.test(line)) {
      inFence = !inFence
      out.push(line)
      continue
    }
    if (inFence) {
      out.push(line)
      continue
    }

    const stripped = line.replace(/^[ \t]+/, '')
    if (!stripped) {
      out.push('')
      continue
    }

    const indent = line.slice(0, line.length - stripped.length)
    const width = indent.replace(/\t/g, '    ').length

    // Shallow indents are meaningful for nested lists; flatten anything deep
    // enough to be read as a code block.
    if (width >= 4) {
      out.push((LIST_MARKER.test(stripped) ? '  ' : '') + stripped)
    } else {
      out.push(line)
    }
  }

  return out.join('\n').replace(/\n{4,}/g, '\n\n\n').trim() + '\n'
}

/** Escapes a cell so it cannot break out of a Markdown table row. */
export function cell(value: unknown): string {
  return String(value ?? '')
    .replace(/\|/g, '\\|')
    .replace(/\r?\n/g, ' ')
    .trim()
}

/** Builds a Markdown table, using the first row as the header. */
export function toTable(rows: unknown[][]): string {
  const usable = rows.filter((r) => r.some((c) => cell(c).length > 0))
  if (!usable.length) return ''

  const width = Math.max(...usable.map((r) => r.length))
  const pad = (r: unknown[]): string[] => {
    const cells = r.map(cell)
    while (cells.length < width) cells.push('')
    return cells
  }

  const lines = [
    `| ${pad(usable[0]).join(' | ')} |`,
    `| ${Array(width).fill('---').join(' | ')} |`,
    ...usable.slice(1).map((r) => `| ${pad(r).join(' | ')} |`)
  ]
  return lines.join('\n')
}

/** Collapses runaway blank lines and trailing whitespace in assembled output. */
export function tidy(parts: string[]): string {
  return parts
    .filter((p) => p !== undefined && p !== null)
    .join('\n\n')
    .replace(/[ \t]+$/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

/** Document title derived from a file name, used as the top-level heading. */
export function titleFrom(fileName: string): string {
  return fileName.replace(/\.[^.]+$/, '').replace(/[_-]+/g, ' ').trim() || 'Document'
}
