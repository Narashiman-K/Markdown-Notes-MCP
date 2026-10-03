/**
 * Spreadsheets (xlsx, xlsm, xls, ods) to Markdown tables, and reading them
 * safely.
 *
 * SheetJS reads synchronously, and some damaged files make it loop forever.
 * Run on the main thread, that froze the whole host: the app window, the
 * browser tab, or the MCP server. So `convertSheetSafely` reads in a
 * background worker that can be stopped when it overruns its time limit
 * (Phase 1b). The worker is supplied by the host through runtime.ts: a Web
 * Worker in the apps (sheetWorker.ts), a worker thread in the MCP package.
 * Where none is available, the file is read here, as before.
 *
 * This file imports nothing heavier than SheetJS, so the worker loads quickly.
 *
 * Kept identical across the Windows app, the web app and the MCP package.
 */
import * as XLSX from 'xlsx'
import type { ConvertResult } from './types'
import { convertRuntime } from './runtime'
import { titleFrom, tidy, toTable } from './normalise'

/** How long a spreadsheet may take to read before it is treated as damaged. */
export const SHEET_TIME_LIMIT_MS = 30_000

/**
 * True for bytes that start like a ZIP archive but never finish.
 *
 * Every complete ZIP ends with an end-of-central-directory record, signature
 * `PK\x05\x06`, within the last 65,557 bytes (22 for the record, up to 65,535
 * of comment). A file that opens with `PK` and has none was cut off — an
 * interrupted download, a failed copy.
 *
 * This exists because SheetJS, in both 0.18.5 and 0.20.3, never returns from
 * `XLSX.read` on some such fragments: a 10-byte or a 30-to-120-byte prefix of
 * a real workbook spins forever. Because conversion is synchronous, that froze
 * the whole host — the app window, the browser tab, the MCP server, or VS
 * Code's shared extension host.
 *
 * The first line of defence: it answers the accidental case, the common one,
 * at once. A file *built* to hang the parser can carry a genuine end record
 * and get past it; that one is stopped by the worker's time limit in
 * convertSheetSafely below, since only stopping a worker can interrupt a
 * synchronous loop.
 */
function isTruncatedZip(bytes: Uint8Array): boolean {
  if (bytes.length < 2 || bytes[0] !== 0x50 || bytes[1] !== 0x4b) return false
  const floor = Math.max(0, bytes.length - 65557)
  for (let i = bytes.length - 22; i >= floor; i--) {
    if (bytes[i] === 0x50 && bytes[i + 1] === 0x4b && bytes[i + 2] === 0x05 && bytes[i + 3] === 0x06) return false
  }
  return true
}

export function convertSheet(bytes: Uint8Array, fileName: string): ConvertResult {
  if (isTruncatedZip(bytes)) {
    return {
      ok: false,
      code: 'CONVERT_FAILED',
      error: 'This spreadsheet is incomplete — the file appears to have been cut off, for example by an interrupted download.'
    }
  }
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

/**
 * Reads a spreadsheet in a background worker, stopped after `limitMs`.
 *
 * A file that is merely cut off is refused at once, without a worker. One that
 * gets past that check and still hangs the parser (a file built to, say) is
 * stopped at the limit and reported, and the app carries on. Large genuine
 * workbooks read well within it.
 */
export async function convertSheetSafely(
  bytes: Uint8Array,
  fileName: string,
  limitMs: number = SHEET_TIME_LIMIT_MS
): Promise<ConvertResult> {
  if (isTruncatedZip(bytes)) return convertSheet(bytes, fileName)
  const isolated = await convertRuntime().isolateSheet(bytes, fileName, limitMs)
  return isolated ?? convertSheet(bytes, fileName)
}
