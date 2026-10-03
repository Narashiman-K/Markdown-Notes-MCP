/**
 * The few places the converters need something only the host can answer.
 *
 * Everything else in this folder is pure: bytes in, Markdown out. This module
 * exists so that the handful of genuinely environment-specific values can be
 * supplied from outside rather than read from browser globals directly, which
 * is what lets the identical files run in a browser, in Electron and in a Node
 * MCP server.
 *
 * Defaults are the browser behaviour, so browser callers need do nothing.
 */
import type { ConvertResult } from './types'

export interface ConvertRuntime {
  /**
   * Where Tesseract should load its worker, WASM core and language data from.
   *
   * Returns the three separately rather than one base, because they are not
   * always siblings and are not always all needed. A browser must be told all
   * three, and they sit under the app's own origin. Node must be told only the
   * core and language paths: tesseract.js ships a Node-specific worker of its
   * own, and pointing it at the browser worker makes it fail on web-worker
   * globals that do not exist.
   *
   * Any path left undefined falls back to the library's default, which fetches
   * from a CDN.
   */
  tesseractPaths(): { workerPath?: string; corePath?: string; langPath?: string; cachePath?: string }

  /**
   * How to hand a .docx to mammoth.
   *
   * mammoth reads an `arrayBuffer` in browsers but only `path` or `buffer`
   * under Node — its package.json swaps the unzip implementation via the
   * `browser` field. Asking the host rather than sniffing for `process` keeps
   * this file free of environment checks.
   */
  docxSource(bytes: Uint8Array, arrayBuffer: ArrayBuffer): Record<string, unknown>

  /**
   * What this environment's Tesseract build accepts as an image.
   *
   * The browser build reads a Blob. The Node build does not — it reports
   * "truncated file" and fails to decode — and wants a Buffer instead.
   */
  ocrImageInput(bytes: Uint8Array, blob: Blob): unknown

  /**
   * Reads a spreadsheet in a background worker that is stopped after
   * `limitMs` (see sheet.ts). Resolves to null when this environment has no
   * worker to offer, or the worker could not start; the caller then reads the
   * file itself, as before.
   */
  isolateSheet(bytes: Uint8Array, fileName: string, limitMs: number): Promise<ConvertResult | null>
}

/** The result for a spreadsheet stopped at its time limit. */
export function sheetTimedOut(limitMs: number): ConvertResult {
  return {
    ok: false,
    code: 'CONVERT_FAILED',
    error:
      `This spreadsheet took longer than ${Math.round(limitMs / 1000)} seconds to read and was stopped. ` +
      'It may be damaged. If it opens in Excel, saving a fresh copy from there usually fixes it.'
  }
}

/**
 * The browser worker. Written out in full as `new Worker(new URL(...))` because
 * that exact shape is what Vite recognises and bundles as a separate worker
 * file. Under Node this is never called: the MCP package replaces it.
 */
function browserIsolateSheet(bytes: Uint8Array, fileName: string, limitMs: number): Promise<ConvertResult | null> {
  if (typeof Worker === 'undefined') return Promise.resolve(null)
  let worker: Worker
  try {
    worker = new Worker(new URL('./sheetWorker.ts', import.meta.url), { type: 'module' })
  } catch (err) {
    console.warn('Spreadsheet worker unavailable; reading on the page instead.', err)
    return Promise.resolve(null)
  }
  return new Promise((resolve) => {
    const finish = (result: ConvertResult | null): void => {
      clearTimeout(timer)
      worker.terminate()
      resolve(result)
    }
    const timer = setTimeout(() => finish(sheetTimedOut(limitMs)), limitMs)
    worker.onmessage = (e: MessageEvent<ConvertResult>) =>
      finish(e.data.ok ? { ...e.data, meta: { ...e.data.meta, isolated: true } } : e.data)
    // The worker failed to load, which is not the file's fault: read it on
    // the page rather than refuse it.
    worker.onerror = (e) => {
      e.preventDefault()
      console.warn('Spreadsheet worker failed to start; reading on the page instead.', e.message)
      finish(null)
    }
    // A copy, so the caller's bytes are not detached by the transfer.
    const copy = bytes.slice()
    worker.postMessage({ bytes: copy, fileName }, [copy.buffer])
  })
}

const browserDefaults: ConvertRuntime = {
  tesseractPaths: () => {
    const base = new URL('tesseract/', document.baseURI).href
    return { workerPath: `${base}worker.min.js`, corePath: base, langPath: base }
  },
  docxSource: (_bytes, arrayBuffer) => ({ arrayBuffer }),
  ocrImageInput: (_bytes, blob) => blob,
  isolateSheet: browserIsolateSheet
}

let current: ConvertRuntime = browserDefaults

/** Called once at start-up by hosts that are not a browser. */
export function setConvertRuntime(overrides: Partial<ConvertRuntime>): void {
  current = { ...current, ...overrides }
}

export function convertRuntime(): ConvertRuntime {
  return current
}
