/**
 * A book's own table of contents, made usable: a contents block that came out
 * of a PDF as one run-on paragraph is split into one entry per line, and each
 * entry that names a heading in the document becomes a link to it.
 *
 * Used by the converters and by the app (when fixing an older converted file),
 * so it depends on nothing outside this folder. Kept identical to the copy in
 * the Windows app. Change one, copy it across.
 */

/** Must match lib/markdown.ts slugify, which gives headings their ids. */
export function slugifyHeading(text: string, used: Set<string>): string {
  const base =
    text
      .toLowerCase()
      .replace(/[^\w\s-]/g, '')
      .trim()
      .replace(/\s+/g, '-') || 'section'
  let slug = base
  let i = 2
  while (used.has(slug)) slug = `${base}-${i++}`
  used.add(slug)
  return slug
}

/** A heading that starts a table of contents. */
const CONTENTS = /^(?:table of )?contents$|^chapters$/i

/** Where one entry of a run-on contents paragraph starts. */
const ENTRY_START =
  /(?=\b(?:Chapter|Part|Section|Book|Lesson|Unit|Module|Step|Appendix)\s+(?:\d+|[IVXLC]+)\b|\b(?:Introduction|Conclusion|Preface|Prologue|Epilogue|Foreword|Afterword|Acknowledg(?:e)?ments|Bibliography|References|Glossary|About the Author)\b)/

const plain = (t: string): string => t.replace(/\[([^\]]*)\]\([^)]*\)/g, '$1').replace(/[*_`]/g, '')
/** For matching an entry to a heading: letters and digits only, no page number or dot leaders. */
const norm = (t: string): string =>
  plain(t)
    .replace(/[.\s·…_-]{3,}\s*\d+\s*$/, '')
    .replace(/\s+\d{1,4}\s*$/, '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '')

interface HeadingLine {
  line: number
  text: string
  slug: string
}

function headingsOf(lines: string[]): HeadingLine[] {
  const used = new Set<string>()
  const out: HeadingLine[] = []
  let fence = false
  lines.forEach((l, i) => {
    if (/^\s*(```|~~~)/.test(l)) fence = !fence
    if (fence) return
    const m = /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(l)
    if (!m) return
    const text = m[2].replace(/<[^>]+>/g, '').trim()
    out.push({ line: i, text, slug: slugifyHeading(text, used) })
  })
  return out
}

/** Splits run-on contents paragraphs and links entries to headings. */
export function tidyContents(markdown: string): string {
  let lines = markdown.split('\n')
  let heads = headingsOf(lines)
  const starts = heads.filter((h) => CONTENTS.test(plain(h.text).replace(/[:.]$/, '').trim()))
  if (!starts.length) return markdown

  // 1. Split: the first paragraph under a contents heading, if it is one long
  //    line naming several chapters, becomes one entry per line.
  for (const h of [...starts].reverse()) {
    let i = h.line + 1
    while (i < lines.length && !lines[i].trim()) i++
    const para = lines[i] ?? ''
    if (!para || /^\s*([-*+]|\d+\.)\s/.test(para) || /^#/.test(para)) continue
    const parts = para.split(ENTRY_START).map((p) => p.trim()).filter(Boolean)
    if (parts.length < 3) continue
    lines.splice(i, 1, ...parts.map((p) => `- ${p}`))
  }

  // 2. Link: entries without a link that name a heading point at it.
  heads = headingsOf(lines)
  const targets = heads.filter((h) => !CONTENTS.test(plain(h.text).replace(/[:.]$/, '').trim()))
  const find = (entry: string): HeadingLine | undefined => {
    const e = norm(entry)
    if (e.length < 4) return undefined
    return (
      targets.find((t) => norm(t.text) === e) ??
      targets.find((t) => {
        const n = norm(t.text)
        return n.length >= 12 && e.length >= 12 && (n.startsWith(e) || e.startsWith(n))
      })
    )
  }
  const contentsLines = new Set<number>()
  for (const h of heads.filter((x) => CONTENTS.test(plain(x.text).replace(/[:.]$/, '').trim()))) {
    for (let i = h.line + 1; i < lines.length && !/^#{1,6}\s/.test(lines[i]); i++) contentsLines.add(i)
  }
  lines = lines.map((l, i) => {
    if (!contentsLines.has(i)) return l
    const m = /^(\s*(?:[-*+]|\d+\.)\s+)(.+)$/.exec(l)
    if (!m || /\]\(#/.test(m[2])) return l
    const t = find(m[2])
    return t ? `${m[1]}[${m[2].replace(/([[\]\\])/g, '\\$1')}](#${t.slug})` : l
  })
  return lines.join('\n')
}
