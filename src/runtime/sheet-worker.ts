/**
 * The Node worker thread that reads one spreadsheet (see lib/convert/sheet.ts).
 *
 * Built to dist/sheet-worker.js by scripts/build.mjs. Receives the bytes and
 * file name as workerData, posts back the ConvertResult. A file that hangs
 * SheetJS hangs only this thread, which the server stops at the time limit.
 */
import { parentPort, workerData } from 'node:worker_threads'
import { convertSheet } from '../lib/convert/sheet'
import type { ConvertResult } from '../lib/convert/types'

const { bytes, fileName } = workerData as { bytes: Uint8Array; fileName: string }
let result: ConvertResult
try {
  result = convertSheet(bytes, fileName)
} catch (err) {
  result = { ok: false, code: 'CONVERT_FAILED', error: `Could not read this file: ${String((err as Error)?.message ?? err)}` }
}
parentPort?.postMessage(result)
