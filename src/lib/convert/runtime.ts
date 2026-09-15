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
}

const browserDefaults: ConvertRuntime = {
  tesseractPaths: () => {
    const base = new URL('tesseract/', document.baseURI).href
    return { workerPath: `${base}worker.min.js`, corePath: base, langPath: base }
  },
  docxSource: (_bytes, arrayBuffer) => ({ arrayBuffer }),
  ocrImageInput: (_bytes, blob) => blob
}

let current: ConvertRuntime = browserDefaults

/** Called once at start-up by hosts that are not a browser. */
export function setConvertRuntime(overrides: Partial<ConvertRuntime>): void {
  current = { ...current, ...overrides }
}

export function convertRuntime(): ConvertRuntime {
  return current
}
