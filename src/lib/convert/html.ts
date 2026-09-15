/**
 * Shared HTML → Markdown conversion.
 *
 * Word, EPUB and ODT all reach Markdown via HTML, so they share one configured
 * Turndown instance. GFM support adds tables, strikethrough and task lists,
 * which Word and EPUB documents use heavily.
 */
import TurndownService from 'turndown'
// The GFM plugin ships without types.
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore
import { gfm } from 'turndown-plugin-gfm'

let service: TurndownService | null = null

function build(): TurndownService {
  const td = new TurndownService({
    headingStyle: 'atx',
    hr: '---',
    bulletListMarker: '-',
    codeBlockStyle: 'fenced',
    emDelimiter: '*',
    strongDelimiter: '**',
    linkStyle: 'inlined'
  })

  td.use(gfm)

  // Drop chrome that carries no meaning once the document is Markdown.
  td.remove(['script', 'style', 'meta', 'link', 'head'])

  // Word and EPUB emit empty paragraphs constantly; they become blank clutter.
  td.addRule('dropEmptyParagraphs', {
    filter: (node) =>
      node.nodeName === 'P' && !node.textContent?.trim() && !node.querySelector('img'),
    replacement: () => ''
  })

  // Keep images but discard base64 payloads, which would bloat the file
  // enormously and are unreadable as Markdown anyway.
  td.addRule('images', {
    filter: 'img',
    replacement: (_content, node) => {
      const el = node as HTMLImageElement
      const alt = el.getAttribute('alt') || 'image'
      const src = el.getAttribute('src') || ''
      if (!src || src.startsWith('data:')) return `*[embedded image: ${alt}]*`
      return `![${alt}](${src})`
    }
  })

  return td
}

export function htmlToMarkdown(html: string): string {
  if (!service) service = build()
  return service.turndown(html)
}

/** Parses an XML/XHTML string with the browser's parser. */
export function parseXml(text: string, type: DOMParserSupportedType = 'application/xml'): Document {
  return new DOMParser().parseFromString(text, type)
}

/** Collects text from every matching element, in document order. */
export function textOf(node: Element | Document, selector: string): string[] {
  return Array.from(node.querySelectorAll(selector))
    .map((el) => el.textContent?.trim() ?? '')
    .filter(Boolean)
}
