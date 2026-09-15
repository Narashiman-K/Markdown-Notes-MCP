/**
 * Word, spreadsheets, PowerPoint, OpenDocument text and EPUB.
 *
 * The OOXML and OpenDocument formats are all zip archives of XML, so PPTX, ODT
 * and EPUB share one approach: unzip, parse, walk the parts in the order the
 * format defines.
 */
import mammoth from 'mammoth'
import * as XLSX from 'xlsx'
import JSZip from 'jszip'
import type { ConvertResult } from './types'
import { htmlToMarkdown, parseXml } from './html'
import { convertRuntime } from './runtime'
import { titleFrom, tidy, toTable } from './normalise'

/**
 * Prepares Word's table markup for Markdown.
 *
 * Two problems have to be fixed or the table is silently dropped:
 *   1. Word emits every row as plain `<tr><td>` with no `<thead>`, but a
 *      Markdown table must have a header row.
 *   2. Word wraps cell content in `<p>`. Markdown table cells can only hold
 *      inline content, so block-level children have to be flattened.
 */
export function promoteTableHeaders(html: string): string {
  const doc = new DOMParser().parseFromString(`<body>${html}</body>`, 'text/html')

  for (const table of Array.from(doc.querySelectorAll('table'))) {
    // Flatten block wrappers inside every cell.
    for (const cellEl of Array.from(table.querySelectorAll('td, th'))) {
      const blocks = Array.from(cellEl.children).filter((c) => /^(P|DIV)$/.test(c.tagName))
      if (blocks.length) {
        cellEl.innerHTML = blocks.map((b) => b.innerHTML.trim()).filter(Boolean).join('<br>')
      }
    }

    if (table.querySelector('thead')) continue
    const firstRow = table.querySelector('tr')
    if (!firstRow) continue

    for (const td of Array.from(firstRow.querySelectorAll('td'))) {
      const th = doc.createElement('th')
      th.innerHTML = td.innerHTML
      td.replaceWith(th)
    }

    const thead = doc.createElement('thead')
    firstRow.parentNode?.removeChild(firstRow)
    thead.appendChild(firstRow)
    table.insertBefore(thead, table.firstChild)
  }

  return doc.body.innerHTML
}

/* ------------------------------------------------------------------- Word */

export async function convertDocx(bytes: Uint8Array, fileName: string): Promise<ConvertResult> {
  const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer
  const result = await mammoth.convertToHtml(
    // Cast because the shape is chosen by the host: an ArrayBuffer in a
    // browser, a Buffer under Node. mammoth's own union cannot express
    // "whichever of these the environment supports".
    convertRuntime().docxSource(bytes, buffer) as unknown as Parameters<typeof mammoth.convertToHtml>[0],
    {
      styleMap: [
        "p[style-name='Title'] => h1:fresh",
        "p[style-name='Subtitle'] => h2:fresh",
        "p[style-name='Quote'] => blockquote:fresh",
        "p[style-name='Intense Quote'] => blockquote:fresh"
      ]
    }
  )

  const body = htmlToMarkdown(promoteTableHeaders(result.value)).trim()
  if (!body) return { ok: false, code: 'EMPTY', error: 'This Word document contains no readable text.' }

  // Only add our own title if the document does not already open with one.
  const hasTitle = /^#\s/.test(body)
  return {
    ok: true,
    markdown: tidy([hasTitle ? '' : `# ${titleFrom(fileName)}`, body]),
    meta: { warnings: result.messages.length }
  }
}

/* ------------------------------------------------------- spreadsheets/ODS */

export function convertSheet(bytes: Uint8Array, fileName: string): ConvertResult {
  const book = XLSX.read(bytes, { type: 'array', cellDates: true })
  const parts: string[] = [`# ${titleFrom(fileName)}`]
  let populated = 0

  for (const name of book.SheetNames) {
    const sheet = book.Sheets[name]
    if (!sheet) continue
    const rows = XLSX.utils.sheet_to_json<unknown[]>(sheet, { header: 1, blankrows: false, defval: '' })
    const table = toTable(rows as unknown[][])
    if (!table) continue
    populated++
    if (book.SheetNames.length > 1) parts.push(`## ${name}`)
    parts.push(table)
  }

  if (!populated) return { ok: false, code: 'EMPTY', error: 'This spreadsheet has no data in any sheet.' }
  return { ok: true, markdown: tidy(parts), meta: { sheets: book.SheetNames.length, populated } }
}

/* ------------------------------------------------------------- PowerPoint */

/** Sorts `slide2.xml` before `slide10.xml`, which a plain sort gets wrong. */
function byNumber(a: string, b: string): number {
  const n = (s: string): number => Number(/(\d+)\.xml$/.exec(s)?.[1] ?? 0)
  return n(a) - n(b)
}

export async function convertPptx(bytes: Uint8Array, fileName: string): Promise<ConvertResult> {
  const zip = await JSZip.loadAsync(bytes)
  const slides = Object.keys(zip.files).filter((p) => /^ppt\/slides\/slide\d+\.xml$/.test(p)).sort(byNumber)
  if (!slides.length) return { ok: false, code: 'EMPTY', error: 'No slides found in this presentation.' }

  const notes = Object.keys(zip.files)
    .filter((p) => /^ppt\/notesSlides\/notesSlide\d+\.xml$/.test(p))
    .sort(byNumber)

  const parts: string[] = [`# ${titleFrom(fileName)}`]

  for (let i = 0; i < slides.length; i++) {
    const xml = await zip.file(slides[i])!.async('string')
    const doc = parseXml(xml)

    // Each <a:p> is a paragraph; the <a:t> runs inside it form one line.
    const paragraphs = Array.from(doc.getElementsByTagName('a:p'))
      .map((p) =>
        Array.from(p.getElementsByTagName('a:t'))
          .map((t) => t.textContent ?? '')
          .join('')
          .trim()
      )
      .filter(Boolean)

    parts.push(`## Slide ${i + 1}`)
    if (paragraphs.length) {
      // The first paragraph is nearly always the slide title.
      const [title, ...rest] = paragraphs
      parts.push(`### ${title}`)
      if (rest.length) parts.push(rest.map((line) => `- ${line}`).join('\n'))
    } else {
      parts.push('*(no text on this slide)*')
    }

    const notePath = notes.find((p) => Number(/(\d+)\.xml$/.exec(p)?.[1]) === i + 1)
    if (notePath) {
      const noteXml = await zip.file(notePath)!.async('string')
      const noteText = Array.from(parseXml(noteXml).getElementsByTagName('a:t'))
        .map((t) => t.textContent ?? '')
        .join(' ')
        .replace(/\s+/g, ' ')
        .trim()
      // Slide numbers leak into the notes part; ignore a bare number.
      if (noteText && !/^\d+$/.test(noteText)) parts.push(`> **Speaker notes:** ${noteText}`)
    }
  }

  return { ok: true, markdown: tidy(parts), meta: { slides: slides.length } }
}

/* --------------------------------------------------------- OpenDocument text */

export async function convertOdt(bytes: Uint8Array, fileName: string): Promise<ConvertResult> {
  const zip = await JSZip.loadAsync(bytes)
  const file = zip.file('content.xml')
  if (!file) return { ok: false, code: 'BAD_FILE', error: 'This does not look like an OpenDocument file.' }

  const doc = parseXml(await file.async('string'))
  const body = doc.getElementsByTagName('office:text')[0] ?? doc.documentElement
  const parts: string[] = [`# ${titleFrom(fileName)}`]

  const walk = (node: Element, listDepth = 0): void => {
    for (const child of Array.from(node.children)) {
      const tag = child.tagName
      const text = (child.textContent ?? '').replace(/\s+/g, ' ').trim()

      if (tag === 'text:h') {
        const level = Math.min(Number(child.getAttribute('text:outline-level') ?? '1') + 1, 6)
        if (text) parts.push(`${'#'.repeat(level)} ${text}`)
      } else if (tag === 'text:p') {
        if (text) parts.push(listDepth > 0 ? `${'  '.repeat(listDepth - 1)}- ${text}` : text)
      } else if (tag === 'text:list') {
        walk(child, listDepth + 1)
      } else if (tag === 'text:list-item') {
        walk(child, listDepth)
      } else if (tag === 'table:table') {
        const rows = Array.from(child.getElementsByTagName('table:table-row')).map((row) =>
          Array.from(row.getElementsByTagName('table:table-cell')).map(
            (c) => (c.textContent ?? '').replace(/\s+/g, ' ').trim()
          )
        )
        const table = toTable(rows)
        if (table) parts.push(table)
      } else if (child.children.length) {
        walk(child, listDepth)
      }
    }
  }

  walk(body as Element)
  if (parts.length <= 1) return { ok: false, code: 'EMPTY', error: 'This document contains no readable text.' }
  return { ok: true, markdown: tidy(parts), meta: { blocks: parts.length - 1 } }
}

/* -------------------------------------------------------------------- EPUB */

export async function convertEpub(bytes: Uint8Array, fileName: string): Promise<ConvertResult> {
  const zip = await JSZip.loadAsync(bytes)

  // container.xml points at the OPF, which defines the real reading order.
  const containerFile = zip.file('META-INF/container.xml')
  if (!containerFile) return { ok: false, code: 'BAD_FILE', error: 'This does not look like an EPUB file.' }

  const container = parseXml(await containerFile.async('string'))
  const opfPath = container.querySelector('rootfile')?.getAttribute('full-path')
  if (!opfPath) return { ok: false, code: 'BAD_FILE', error: 'The EPUB index is missing or damaged.' }

  const opf = parseXml(await zip.file(opfPath)!.async('string'))
  const baseDir = opfPath.includes('/') ? opfPath.slice(0, opfPath.lastIndexOf('/') + 1) : ''

  const title = opf.getElementsByTagName('dc:title')[0]?.textContent?.trim() || titleFrom(fileName)
  const author = opf.getElementsByTagName('dc:creator')[0]?.textContent?.trim()

  const manifest = new Map<string, string>()
  for (const item of Array.from(opf.querySelectorAll('manifest > item'))) {
    const id = item.getAttribute('id')
    const href = item.getAttribute('href')
    if (id && href) manifest.set(id, href)
  }

  const spine = Array.from(opf.querySelectorAll('spine > itemref'))
    .map((ref) => manifest.get(ref.getAttribute('idref') ?? ''))
    .filter((href): href is string => !!href)

  if (!spine.length) return { ok: false, code: 'EMPTY', error: 'This EPUB has no readable chapters.' }

  const parts: string[] = [`# ${title}`]
  if (author) parts.push(`*by ${author}*`)

  let chapters = 0
  for (const href of spine) {
    const clean = decodeURIComponent(href.split('#')[0])
    const entry = zip.file(baseDir + clean) ?? zip.file(clean)
    if (!entry) continue
    const markdown = htmlToMarkdown(await entry.async('string')).trim()
    if (!markdown) continue
    parts.push(markdown)
    chapters++
  }

  if (!chapters) return { ok: false, code: 'EMPTY', error: 'No chapter text could be read from this EPUB.' }
  return { ok: true, markdown: tidy(parts), meta: { chapters } }
}
