/**
 * Word, spreadsheets, PowerPoint, OpenDocument text and EPUB.
 *
 * The OOXML and OpenDocument formats are all zip archives of XML, so PPTX, ODT
 * and EPUB share one approach: unzip, parse, walk the parts in the order the
 * format defines.
 */
import mammoth from 'mammoth'
import JSZip from 'jszip'
import type { ConvertResult } from './types'
import { htmlToMarkdown, parseXml } from './html'
import { convertRuntime } from './runtime'
import { canExtractImages, pictureDataUrl } from './pdfImages'
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

/** data:<mime>;base64,<data> -> bytes and type. */
function decodeDataUrl(url: string): { bytes: Uint8Array; mime: string } | null {
  const m = /^data:([^;,]+);base64,(.*)$/s.exec(url)
  if (!m) return null
  const bin = atob(m[2])
  const bytes = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
  return { bytes, mime: m[1] }
}

/**
 * Word pictures, kept: each is shrunk to a JPEG of at most 1600 px across
 * (pdfImages.ts); one the browser cannot draw (EMF, WMF) is left to the
 * placeholder. A picture inside a heading paragraph (as Word allows) moves to
 * its own line just above it, so the heading stays a heading.
 */
async function keepWordPictures(html: string): Promise<string> {
  const doc = new DOMParser().parseFromString(`<body>${html}</body>`, 'text/html')
  for (const img of Array.from(doc.querySelectorAll('img'))) {
    const decoded = decodeDataUrl(img.getAttribute('src') ?? '')
    const url = decoded ? await pictureDataUrl(decoded.bytes, decoded.mime) : null
    if (url) img.setAttribute('src', url)
    const heading = img.closest('h1, h2, h3, h4, h5, h6')
    if (heading) {
      const p = doc.createElement('p')
      p.appendChild(img)
      heading.parentNode?.insertBefore(p, heading)
    }
  }
  return doc.body.innerHTML
}

export async function convertDocx(bytes: Uint8Array, fileName: string, options: { pictures?: boolean } = {}): Promise<ConvertResult> {
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

  const pictures = options.pictures !== false && canExtractImages()
  const html = pictures ? await keepWordPictures(result.value) : result.value
  const body = htmlToMarkdown(promoteTableHeaders(html), { keepDataImages: pictures }).trim()
  if (!body) return { ok: false, code: 'EMPTY', error: 'This Word document contains no readable text.' }

  // Only add our own title if the document does not already open with one.
  // A picture moved above the opening heading does not make it any less the title.
  const hasTitle = /^#\s/.test(body.replace(/^(?:!\[[^\]]*\]\([^)]*\)\s*)+/, ''))
  return {
    ok: true,
    markdown: tidy([hasTitle ? '' : `# ${titleFrom(fileName)}`, body]),
    meta: { warnings: result.messages.length }
  }
}

/* ------------------------------------------------------- spreadsheets/ODS */

// In sheet.ts, so a background worker can load the spreadsheet reader alone.
export { convertSheet } from './sheet'

/* ------------------------------------------------------------- PowerPoint */

/** Sorts `slide2.xml` before `slide10.xml`, which a plain sort gets wrong. */
function byNumber(a: string, b: string): number {
  const n = (s: string): number => Number(/(\d+)\.xml$/.exec(s)?.[1] ?? 0)
  return n(a) - n(b)
}

const PPT_MIME: Record<string, string> = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', bmp: 'image/bmp', webp: 'image/webp' }

/** A slide's pictures, in the order the slide draws them, as data URLs. */
async function slidePictures(zip: JSZip, slidePath: string, doc: Document): Promise<string[]> {
  const relsPath = slidePath.replace(/slides\/(slide\d+\.xml)$/, 'slides/_rels/$1.rels')
  const relsFile = zip.file(relsPath)
  if (!relsFile) return []
  const rels = parseXml(await relsFile.async('string'))
  const targets = new Map<string, string>()
  for (const r of Array.from(rels.getElementsByTagName('Relationship'))) {
    const id = r.getAttribute('Id')
    const target = r.getAttribute('Target')
    if (id && target) targets.set(id, target)
  }
  const out: string[] = []
  for (const blip of Array.from(doc.getElementsByTagName('a:blip'))) {
    const target = targets.get(blip.getAttribute('r:embed') ?? '')
    if (!target) continue
    // Targets are relative to ppt/slides/, usually "../media/image1.png".
    const path = `ppt/slides/${target}`.replace(/[^/]+\/\.\.\//g, '')
    const ext = path.split('.').pop()?.toLowerCase() ?? ''
    const file = zip.file(path)
    if (!file || !PPT_MIME[ext]) continue
    const url = await pictureDataUrl(await file.async('uint8array'), PPT_MIME[ext])
    if (url && !out.includes(url)) out.push(url)
  }
  return out
}

export async function convertPptx(bytes: Uint8Array, fileName: string, options: { pictures?: boolean } = {}): Promise<ConvertResult> {
  const withPictures = options.pictures !== false && canExtractImages()
  let pictureCount = 0
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

    // The slide's pictures, after its text ("Include pictures").
    if (withPictures) {
      for (const url of await slidePictures(zip, slides[i], doc)) {
        pictureCount++
        parts.push(`![Picture ${pictureCount}](${url})`)
      }
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

  return { ok: true, markdown: tidy(parts), meta: { slides: slides.length, ...(pictureCount ? { pictures: pictureCount } : {}) } }
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

/** Resolves an href inside the EPUB against the file it appears in. */
function resolveInBook(fromFile: string, href: string): { file: string; fragment: string } {
  const [rawPath, fragment = ''] = href.split('#')
  let path = rawPath ? decodeURIComponent(rawPath) : fromFile
  if (rawPath) {
    const dir = fromFile.includes('/') ? fromFile.slice(0, fromFile.lastIndexOf('/') + 1) : ''
    const parts: string[] = []
    for (const seg of (dir + path).split('/')) {
      if (seg === '..') parts.pop()
      else if (seg && seg !== '.') parts.push(seg)
    }
    path = parts.join('/')
  }
  return { file: path, fragment: decodeURIComponent(fragment) }
}

const BOOK_MIME: Record<string, string> = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml', bmp: 'image/bmp' }

/**
 * EPUB chapters are XHTML. Read as plain HTML, the empty page markers books
 * are full of (<a id="p12"/>) are not empty at all: each one opens a link that
 * swallows everything after it, which garbled whole chapters. So each is read
 * as XML, falling back to HTML only when it is not well formed.
 *
 * Links between chapters (contents, index, footnotes) point at files that do
 * not exist once the book is one Markdown document. Each target that some
 * link uses gets an anchor (<a id="epub-N">) where it is, and the links point
 * at those; a link whose target cannot be found keeps its text, without the
 * link. Pictures are kept like a Word file's ("Include pictures").
 */
export async function convertEpub(bytes: Uint8Array, fileName: string, options: { pictures?: boolean } = {}): Promise<ConvertResult> {
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

  // Read every chapter first: a link in one can point into any other.
  const chapterDocs: Array<{ path: string; body: Element }> = []
  for (const href of spine) {
    const path = resolveInBook(baseDir + 'x', href.split('#')[0]).file
    const entry = zip.file(path) ?? zip.file(decodeURIComponent(href.split('#')[0]))
    if (!entry) continue
    const text = await entry.async('string')
    let dom = new DOMParser().parseFromString(text, 'application/xhtml+xml')
    if (dom.getElementsByTagName('parsererror').length) dom = new DOMParser().parseFromString(text, 'text/html')
    // Some DOMs (the one under Node, for the MCP package) do not find a
    // namespaced <body> by tag name; look by local name, and failing that use
    // the whole page without its <head>, so the chapter's <title> does not
    // turn up as a stray line of text.
    let body: Element | undefined =
      dom.getElementsByTagName('body')[0] ?? Array.from(dom.getElementsByTagName('*')).find((e) => e.localName === 'body')
    if (!body && dom.documentElement) {
      body = dom.documentElement
      for (const head of Array.from(body.getElementsByTagName('*')).filter((e) => e.localName === 'head')) head.remove()
    }
    if (body) chapterDocs.push({ path, body })
  }

  // Links inside the book -> anchors in the one document.
  const anchorFor = new Map<string, string>()
  const links: Array<{ el: Element; key: string }> = []
  for (const { path, body } of chapterDocs) {
    for (const a of Array.from(body.getElementsByTagName('a'))) {
      const href = a.getAttribute('href')
      if (!href || /^[a-z][a-z0-9+.-]*:/i.test(href)) continue
      const { file, fragment } = resolveInBook(path, href)
      const key = `${file}#${fragment}`
      if (!anchorFor.has(key)) anchorFor.set(key, `epub-${anchorFor.size + 1}`)
      links.push({ el: a, key })
    }
  }
  const placed = new Set<string>()
  const anchorEl = (owner: Document, id: string): Element => {
    const el = owner.createElementNS('http://www.w3.org/1999/xhtml', 'a')
    el.setAttribute('id', id)
    return el
  }
  for (const { path, body } of chapterDocs) {
    const owner = body.ownerDocument
    const start = anchorFor.get(`${path}#`)
    if (start) {
      body.insertBefore(anchorEl(owner, start), body.firstChild)
      placed.add(start)
    }
    for (const el of Array.from(body.querySelectorAll('[id]'))) {
      const id = anchorFor.get(`${path}#${el.getAttribute('id')}`)
      if (id && !placed.has(id)) {
        el.parentNode?.insertBefore(anchorEl(owner, id), el)
        placed.add(id)
      }
    }
  }
  for (const { el, key } of links) {
    const id = anchorFor.get(key)!
    if (placed.has(id)) el.setAttribute('href', `#${id}`)
    else el.removeAttribute('href')
  }

  // Pictures, from the book itself.
  const pictures = options.pictures !== false && canExtractImages()
  for (const { path, body } of chapterDocs) {
    for (const img of Array.from(body.getElementsByTagName('img'))) {
      const src = img.getAttribute('src') ?? ''
      const { file } = resolveInBook(path, src)
      const ext = file.split('.').pop()?.toLowerCase() ?? ''
      const data = pictures && !/^[a-z]+:/i.test(src) ? zip.file(file) : null
      const url = data && BOOK_MIME[ext] ? await pictureDataUrl(await data.async('uint8array'), BOOK_MIME[ext]) : null
      if (url) img.setAttribute('src', url)
      else img.removeAttribute('src')
    }
  }

  // Into an HTML document for the Markdown converter: XHTML elements become
  // HTML ones, and empty elements are written out as such.
  let chapters = 0
  for (const { body } of chapterDocs) {
    const htmlDoc = new DOMParser().parseFromString('<!doctype html><html><body></body></html>', 'text/html')
    for (const child of Array.from(body.childNodes)) htmlDoc.body.appendChild(htmlDoc.importNode(child, true))
    const markdown = htmlToMarkdown(htmlDoc.body.innerHTML, { keepDataImages: pictures }).trim()
    if (!markdown) continue
    parts.push(markdown)
    chapters++
  }

  if (!chapters) return { ok: false, code: 'EMPTY', error: 'No chapter text could be read from this EPUB.' }
  return { ok: true, markdown: tidy(parts), meta: { chapters } }
}
