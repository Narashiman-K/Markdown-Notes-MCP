/**
 * PDF → Markdown using pdf.js (Mozilla's engine, the one Firefox ships).
 *
 * Text items carry position data, which pypdf did not expose. That is used to
 * rebuild line breaks and paragraph boundaries rather than emitting one
 * undifferentiated run of words, and to detect headings by relative font size.
 */
/*
 * Pinned to pdfjs-dist 4.x deliberately. Version 6 calls
 * `Uint8Array.prototype.toHex`, a very recent proposal method that Electron
 * 33's Chromium 130 does not implement, so PDFs fail with
 * "hashOriginal.toHex is not a function". Revisit when Electron is upgraded.
 */
import * as pdfjs from 'pdfjs-dist'
import workerUrl from 'pdfjs-dist/build/pdf.worker.mjs?url'
import type { ConvertResult } from './types'
import { titleFrom, tidy } from './normalise'
import { pageBreakLine, pageNumberLine, pageSizeLine } from './pageNotes'
import { tidyContents } from './contents'
import { canExtractImages, extractPageImages, type PageImage } from './pdfImages'

pdfjs.GlobalWorkerOptions.workerSrc = workerUrl

interface Item {
  text: string
  x: number
  y: number
  height: number
  width: number
}

/** One line of a page: its text, size, and where it sits (y measured down). */
interface Block {
  text: string
  size: number
  /** Top of the line. */
  y: number
  /** Baseline, and left and right edges, for matching the PDF's links. */
  base: number
  x0: number
  x1: number
}

/** A link inside the PDF: its area (y measured down) and the page it opens. */
interface PdfLink {
  x0: number
  x1: number
  top: number
  bottom: number
  page: number
}

/** Groups text items into lines by vertical position, then into paragraphs. */
function itemsToBlocks(items: Item[]): Block[] {
  if (!items.length) return []

  // Bucket by y, allowing a little jitter within a line.
  const lines: Item[][] = []
  let current: Item[] = []
  let lastY = items[0].y

  for (const item of items) {
    if (Math.abs(item.y - lastY) > Math.max(2, item.height * 0.5)) {
      if (current.length) lines.push(current)
      current = []
    }
    current.push(item)
    lastY = item.y
  }
  if (current.length) lines.push(current)

  return lines.map((line) => {
    const sorted = [...line].sort((a, b) => a.x - b.x)
    let text = ''
    let prevEnd = -1
    for (const item of sorted) {
      // Insert a space when there is a visible gap between runs.
      if (prevEnd >= 0 && item.x - prevEnd > 1 && !/\s$/.test(text)) text += ' '
      text += item.text
      prevEnd = item.x + item.text.length
    }
    return {
      text: text.replace(/\s+/g, ' ').trim(),
      size: Math.max(...line.map((i) => i.height)),
      // Top of the line, measured down the page: where pictures slot in.
      y: Math.min(...line.map((i) => i.y - i.height)),
      base: Math.max(...line.map((i) => i.y)),
      x0: Math.min(...line.map((i) => i.x)),
      x1: Math.max(...line.map((i) => i.x + i.width))
    }
  })
}

type PdfDoc = Awaited<ReturnType<typeof pdfjs.getDocument>['promise']>

/** The page number (1-based) a PDF destination points at, or null. */
async function destPage(doc: PdfDoc, dest: unknown): Promise<number | null> {
  try {
    const explicit = typeof dest === 'string' ? await doc.getDestination(dest) : dest
    if (!Array.isArray(explicit) || !explicit.length) return null
    const ref = explicit[0]
    if (typeof ref === 'number') return ref + 1
    if (ref && typeof ref === 'object') return (await doc.getPageIndex(ref as never)) + 1
  } catch {
    /* a broken link: left as plain text */
  }
  return null
}

/** The links on a page that open another page of the same PDF. */
async function pageLinks(doc: PdfDoc, page: Awaited<ReturnType<PdfDoc['getPage']>>): Promise<PdfLink[]> {
  const out: PdfLink[] = []
  const annots = (await page.getAnnotations().catch(() => [])) as Array<{ subtype?: string; dest?: unknown; rect?: number[] }>
  for (const a of annots) {
    if (a.subtype !== 'Link' || !a.dest || !a.rect) continue
    const target = await destPage(doc, a.dest)
    if (!target) continue
    const [x0, y0, x1, y1] = a.rect
    out.push({ x0: Math.min(x0, x1), x1: Math.max(x0, x1), top: -Math.max(y0, y1), bottom: -Math.min(y0, y1), page: target })
  }
  return out
}

/** The page a line links to: a link whose area holds the line's baseline and overlaps it. */
function linkFor(block: Block, links: PdfLink[]): number | null {
  for (const l of links) {
    const inY = block.base >= l.top - 2 && block.base <= l.bottom + 2
    const overlap = Math.min(block.x1, l.x1) - Math.max(block.x0, l.x0)
    if (inY && overlap > Math.min(20, (block.x1 - block.x0) * 0.3)) return l.page
  }
  return null
}

/** The PDF's bookmarks as a nested list of links to their pages. */
async function outlineList(doc: PdfDoc): Promise<string[]> {
  const outline = (await doc.getOutline().catch(() => null)) as Array<{ title: string; dest: unknown; items?: unknown[] }> | null
  if (!outline?.length) return []
  const lines: string[] = []
  const walk = async (items: Array<{ title: string; dest: unknown; items?: unknown[] }>, depth: number): Promise<void> => {
    for (const it of items) {
      const title = String(it.title ?? '').replace(/\s+/g, ' ').trim()
      if (!title) continue
      const page = await destPage(doc, it.dest)
      lines.push(`${'  '.repeat(depth)}- ${page ? `[${escapeLinkText(title)}](#page-${page})` : title}`)
      if (it.items?.length && depth < 3) await walk(it.items as typeof items, depth + 1)
    }
  }
  await walk(outline, 0)
  return lines
}

function escapeLinkText(t: string): string {
  return t.replace(/([[\]\\])/g, '\\$1')
}

/** A heading that starts a table of contents. */
const CONTENTS_HEADING = /^(table of )?contents$|^index$|^chapters$/i

/**
 * `images`: take the pictures out too, each placed where it sits on its page
 * (pdfImages.ts). On unless turned off, and only where there is a canvas.
 */
export async function convertPdf(bytes: Uint8Array, fileName: string, options: { images?: boolean } = {}): Promise<ConvertResult> {
  const withImages = options.images !== false && canExtractImages()
  const doc = await pdfjs.getDocument({ data: bytes, useWorkerFetch: false }).promise

  const parts: string[] = [`# ${titleFrom(fileName)}`]
  let emptyPages = 0
  const allSizes: number[] = []
  const pageBlocks: Block[][] = []
  const pageLinkSets: PdfLink[][] = []
  const pageImages: PageImage[][] = []
  let pageSize: { width: number; height: number } | null = null

  for (let n = 1; n <= doc.numPages; n++) {
    const page = await doc.getPage(n)
    // The first page's size stands for the document: page view shows every
    // sheet at it. The viewport at scale 1 is in points and allows for a
    // page stored rotated.
    if (!pageSize) {
      const v = page.getViewport({ scale: 1 })
      pageSize = { width: v.width, height: v.height }
    }
    const content = await page.getTextContent()

    const items: Item[] = content.items
      .filter((i): i is typeof i & { str: string; transform: number[] } => 'str' in i)
      .filter((i) => i.str.trim().length > 0)
      .map((i) => ({
        text: i.str,
        x: i.transform[4],
        y: -i.transform[5], // flip: PDF origin is bottom-left
        height: Math.abs(i.transform[3]) || 10,
        width: Number((i as { width?: number }).width) || i.str.length * 5
      }))

    const blocks = itemsToBlocks(items)
    pageBlocks.push(blocks)
    pageLinkSets.push(await pageLinks(doc, page))
    pageImages.push(withImages ? await extractPageImages(page).catch(() => []) : [])
    blocks.forEach((b) => allSizes.push(b.size))
    if (!blocks.length) emptyPages++
    page.cleanup()
  }

  if (emptyPages === doc.numPages) {
    await doc.cleanup()
    return {
      ok: false,
      code: 'SCANNED_PDF',
      error:
        'No selectable text found. This looks like a scanned PDF — it needs image OCR rather than text extraction.'
    }
  }

  // The same picture at the same place on three pages or more is a header
  // or footer logo, not content. The place matters: a document can reuse its
  // logo in the body too, and that one stays.
  const placeOf = (i: PageImage): string => `${i.fingerprint}@${Math.round(i.y / 20)}`
  const seen = new Map<string, number>()
  for (const imgs of pageImages) for (const f of new Set(imgs.map(placeOf))) seen.set(f, (seen.get(f) ?? 0) + 1)
  let pictures = 0

  // A line noticeably larger than the document's typical size is a heading.
  const sorted = [...allSizes].sort((a, b) => a - b)
  const bodySize = sorted[Math.floor(sorted.length / 2)] ?? 10

  if (pageSize) parts.push(pageSizeLine(pageSize.width, pageSize.height))

  // The PDF's own contents links, when it has them, become working links in
  // place. Without any, its bookmarks (if it has those) become a contents list
  // at the top. Either way each entry opens the page it points at.
  const hasLinks = pageLinkSets.some((l) => l.length > 0)
  if (!hasLinks && doc.numPages > 1) {
    const list = await outlineList(doc)
    if (list.length) parts.push('## Contents', list.join('\n'))
  }

  let firstPage = true
  pageBlocks.forEach((blocks, index) => {
    const images = pageImages[index].filter((i) => (seen.get(placeOf(i)) ?? 0) < 3)
    if (!blocks.length && !images.length) return
    // Where the original page ended: a sheet edge in page view, a page break
    // in print. It carries the next page's number, which links point at.
    if (!firstPage) parts.push(pageBreakLine(index + 1))
    firstPage = false
    const links = pageLinkSets[index]

    let paragraph: string[] = []
    const flush = (): void => {
      if (paragraph.length) {
        parts.push(paragraph.join(' '))
        paragraph = []
      }
    }
    // Under a "Contents" heading every line is its own entry, not one long
    // run-on paragraph.
    let inContents = false
    let list: string[] = []
    const flushList = (): void => {
      if (list.length) {
        parts.push(list.join('\n'))
        list = []
      }
    }

    // Pictures go in before the first line below their top edge.
    let next = 0
    const picturesAbove = (y: number): void => {
      while (next < images.length && images[next].y <= y) {
        flush()
        pictures++
        parts.push(`![Picture ${pictures}](${images[next].dataUrl})`)
        next++
      }
    }

    for (const block of blocks) {
      picturesAbove(block.y)
      if (!block.text) continue
      const target = links.length ? linkFor(block, links) : null
      if (block.size > bodySize * 1.25 && block.text.length < 120) {
        flush()
        flushList()
        inContents = CONTENTS_HEADING.test(block.text.replace(/[:.]$/, '').trim())
        parts.push(`### ${target ? `[${escapeLinkText(block.text)}](#page-${target})` : block.text}`)
        continue
      }
      // A line that links to another page is a contents entry of its own.
      if (target || inContents) {
        flush()
        list.push(`- ${target ? `[${escapeLinkText(block.text)}](#page-${target})` : block.text}`)
        continue
      }
      flushList()
      paragraph.push(block.text)
      // A line ending in sentence punctuation and clearly short ends a paragraph.
      if (/[.!?:]$/.test(block.text) && block.text.length < 60) flush()
    }
    picturesAbove(Infinity)
    flush()
    flushList()
    // The page's number at its foot, small and grey, like a footer.
    if (doc.numPages > 1) parts.push(pageNumberLine(index + 1))
  })

  const pages = doc.numPages
  await doc.cleanup()

  return {
    ok: true,
    // Contents entries without a PDF link still open their chapter, by name.
    markdown: tidyContents(tidy(parts)),
    meta: { pages, emptyPages, ...(pictures ? { pictures } : {}) }
  }
}
