/**
 * The browser's background worker for reading spreadsheets (see sheet.ts).
 *
 * Receives `{ bytes, fileName }`, answers with the ConvertResult. Anything the
 * reader throws is answered as a failed result, so the page never waits for a
 * reply that will not come; the only silence is a hang, which the page's
 * time limit ends by stopping this worker.
 *
 * Kept identical across the Windows app, the web app and the MCP package (the
 * MCP package uses a Node worker thread instead, src/runtime/sheet-worker.ts).
 */
import { convertSheet } from './sheet'
import type { ConvertResult } from './types'

interface WorkerScope {
  onmessage: ((e: { data: { bytes: Uint8Array; fileName: string } }) => void) | null
  postMessage(result: ConvertResult): void
}

const scope = self as unknown as WorkerScope

scope.onmessage = (e) => {
  let result: ConvertResult
  try {
    result = convertSheet(e.data.bytes, e.data.fileName)
  } catch (err) {
    result = {
      ok: false,
      code: 'CONVERT_FAILED',
      error: `Could not read this file: ${String((err as Error)?.message ?? err)}`
    }
  }
  scope.postMessage(result)
}
