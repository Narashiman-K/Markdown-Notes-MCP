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

pdfjs.GlobalWorkerOptions.workerSrc = workerUrl

interface Item {
  text: string
  x: number
  y: number
  height: number
}

/** Groups text items into lines by vertical position, then into paragraphs. */
function itemsToBlocks(items: Item[]): Array<{ text: string; size: number }> {
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
      size: Math.max(...line.map((i) => i.height))
    }
  })
}

export async function convertPdf(bytes: Uint8Array, fileName: string): Promise<ConvertResult> {
  const doc = await pdfjs.getDocument({ data: bytes, useWorkerFetch: false }).promise

  const parts: string[] = [`# ${titleFrom(fileName)}`]
  let emptyPages = 0
  const allSizes: number[] = []
  const pageBlocks: Array<Array<{ text: string; size: number }>> = []

  for (let n = 1; n <= doc.numPages; n++) {
    const page = await doc.getPage(n)
    const content = await page.getTextContent()

    const items: Item[] = content.items
      .filter((i): i is typeof i & { str: string; transform: number[] } => 'str' in i)
      .filter((i) => i.str.trim().length > 0)
      .map((i) => ({
        text: i.str,
        x: i.transform[4],
        y: -i.transform[5], // flip: PDF origin is bottom-left
        height: Math.abs(i.transform[3]) || 10
      }))

    const blocks = itemsToBlocks(items)
    pageBlocks.push(blocks)
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

  // A line noticeably larger than the document's typical size is a heading.
  const sorted = [...allSizes].sort((a, b) => a - b)
  const bodySize = sorted[Math.floor(sorted.length / 2)] ?? 10

  pageBlocks.forEach((blocks, index) => {
    if (!blocks.length) return
    if (doc.numPages > 1) parts.push(`## Page ${index + 1}`)

    let paragraph: string[] = []
    const flush = (): void => {
      if (paragraph.length) {
        parts.push(paragraph.join(' '))
        paragraph = []
      }
    }

    for (const block of blocks) {
      if (!block.text) continue
      if (block.size > bodySize * 1.25 && block.text.length < 120) {
        flush()
        parts.push(`### ${block.text}`)
        continue
      }
      paragraph.push(block.text)
      // A line ending in sentence punctuation and clearly short ends a paragraph.
      if (/[.!?:]$/.test(block.text) && block.text.length < 60) flush()
    }
    flush()
  })

  const pages = doc.numPages
  await doc.cleanup()

  return {
    ok: true,
    markdown: tidy(parts),
    meta: { pages, emptyPages }
  }
}
