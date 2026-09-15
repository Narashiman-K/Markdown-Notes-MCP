/**
 * Plain text, delimited data, and lightly-structured formats.
 */
import type { ConvertResult } from './types'
import { extensionOf } from './types'
import { htmlToMarkdown } from './html'
import { titleFrom, tidy, toTable } from './normalise'

/** Decodes bytes, honouring a BOM and falling back through common encodings. */
export function decodeText(bytes: Uint8Array): string {
  // UTF-8 BOM
  if (bytes.length > 2 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    return new TextDecoder('utf-8').decode(bytes.subarray(3))
  }
  // UTF-16 BOMs
  if (bytes.length > 1 && bytes[0] === 0xff && bytes[1] === 0xfe) {
    return new TextDecoder('utf-16le').decode(bytes.subarray(2))
  }
  if (bytes.length > 1 && bytes[0] === 0xfe && bytes[1] === 0xff) {
    return new TextDecoder('utf-16be').decode(bytes.subarray(2))
  }

  const strict = new TextDecoder('utf-8', { fatal: true })
  try {
    return strict.decode(bytes)
  } catch {
    // Not valid UTF-8 — almost always a Windows-1252 legacy file.
    return decodeCp1252(bytes)
  }
}

/**
 * Windows-1252 differs from Latin-1 only in 0x80–0x9F, and that range holds
 * exactly the characters Word-era documents are full of: curly quotes, em
 * dashes, ellipses. Runtimes disagree about whether TextDecoder maps this range
 * per the WHATWG spec, so the table is explicit rather than trusted.
 */
const CP1252_HIGH: Record<number, string> = {
  0x80: '€', 0x82: '‚', 0x83: 'ƒ', 0x84: '„', 0x85: '…', 0x86: '†', 0x87: '‡',
  0x88: 'ˆ', 0x89: '‰', 0x8a: 'Š', 0x8b: '‹', 0x8c: 'Œ', 0x8e: 'Ž',
  0x91: '‘', 0x92: '’', 0x93: '“', 0x94: '”', 0x95: '•', 0x96: '–', 0x97: '—',
  0x98: '˜', 0x99: '™', 0x9a: 'š', 0x9b: '›', 0x9c: 'œ', 0x9e: 'ž', 0x9f: 'Ÿ'
}

export function decodeCp1252(bytes: Uint8Array): string {
  let out = ''
  for (const byte of bytes) {
    out += byte >= 0x80 && byte <= 0x9f ? (CP1252_HIGH[byte] ?? String.fromCharCode(byte)) : String.fromCharCode(byte)
  }
  return out
}

/** Splits a CSV line, respecting quoted fields containing the delimiter. */
export function splitDelimited(line: string, delimiter: string): string[] {
  const out: string[] = []
  let field = ''
  let quoted = false

  for (let i = 0; i < line.length; i++) {
    const ch = line[i]
    if (quoted) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          field += '"'
          i++
        } else {
          quoted = false
        }
      } else {
        field += ch
      }
    } else if (ch === '"') {
      quoted = true
    } else if (ch === delimiter) {
      out.push(field)
      field = ''
    } else {
      field += ch
    }
  }
  out.push(field)
  return out.map((f) => f.trim())
}

/** Strips RTF control words, leaving readable text. */
function stripRtf(text: string): string {
  return text
    .replace(/\\'([0-9a-f]{2})/gi, (_m, hex) => String.fromCharCode(parseInt(hex, 16)))
    .replace(/\\par[d]?\b/g, '\n')
    .replace(/\\line\b/g, '\n')
    .replace(/\{\\\*[^{}]*\}/g, '')
    .replace(/\\[a-z]+-?\d*\s?/gi, '')
    .replace(/[{}]/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

export function convertText(bytes: Uint8Array, fileName: string): ConvertResult {
  const ext = extensionOf(fileName)
  const raw = decodeText(bytes)

  if (!raw.trim()) return { ok: false, code: 'EMPTY', error: 'This file is empty.' }

  // Markdown passes through untouched — converting it would be destructive.
  if (ext === 'md' || ext === 'markdown') {
    return { ok: true, markdown: raw, meta: { passthrough: true } }
  }

  if (ext === 'csv' || ext === 'tsv') {
    const delimiter = ext === 'tsv' ? '\t' : ','
    const rows = raw
      .split(/\r?\n/)
      .filter((l) => l.trim())
      .map((l) => splitDelimited(l, delimiter))
    const table = toTable(rows)
    if (table) return { ok: true, markdown: tidy([`# ${titleFrom(fileName)}`, table]), meta: { rows: rows.length } }
  }

  if (ext === 'html' || ext === 'htm') {
    const body = htmlToMarkdown(raw).trim()
    if (body) return { ok: true, markdown: tidy([/^#\s/.test(body) ? '' : `# ${titleFrom(fileName)}`, body]) }
  }

  if (ext === 'rtf') {
    const body = stripRtf(raw)
    if (body) return { ok: true, markdown: tidy([`# ${titleFrom(fileName)}`, body]) }
  }

  if (ext === 'srt' || ext === 'vtt') {
    // Drop cue numbers and timestamps, keep the spoken text.
    const body = raw
      .split(/\r?\n/)
      .filter((l) => !/^\d+$/.test(l.trim()))
      .filter((l) => !/-->/.test(l))
      .filter((l) => !/^WEBVTT/i.test(l.trim()))
      .join('\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim()
    if (body) return { ok: true, markdown: tidy([`# ${titleFrom(fileName)} — transcript`, body]) }
  }

  // Source code and config files read far better inside a fence.
  const CODE = ['py', 'js', 'ts', 'java', 'c', 'cpp', 'cs', 'go', 'rs', 'sh', 'sql', 'json', 'xml', 'yaml', 'yml', 'ini', 'cfg', 'conf']
  if (CODE.includes(ext)) {
    const lang = ext === 'yml' ? 'yaml' : ext === 'cfg' || ext === 'conf' ? 'ini' : ext
    return {
      ok: true,
      markdown: tidy([`# ${titleFrom(fileName)}`, '```' + lang + '\n' + raw.trimEnd() + '\n```']),
      meta: { language: lang }
    }
  }

  // Plain prose. Keep an existing heading structure if the file has one.
  const hasHeading = /^#{1,6}\s/m.test(raw)
  return {
    ok: true,
    markdown: hasHeading ? raw : tidy([`# ${titleFrom(fileName)}`, raw]),
    meta: { bytes: bytes.length }
  }
}
