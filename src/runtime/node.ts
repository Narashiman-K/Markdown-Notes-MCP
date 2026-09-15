/**
 * Makes the browser-shaped converters run under Node.
 *
 * The files in `src/lib/convert/` are kept byte-identical to the copies in the
 * Windows and web apps, so that `npm run sync:check` can prove they have not
 * drifted. That means Node has to provide the few browser globals they use
 * rather than the files being edited to avoid them.
 *
 * The full list, established by grepping the converters, is short:
 *
 *   DOMParser            html.ts and office.ts, for XML and HTML parsing
 *   Blob                 ocr.ts — native in Node 20+, nothing to do
 *   createImageBitmap    ocr.ts, only for TIFF and BMP
 *   document             ocr.ts, only via the runtime hook now
 *
 * Call this before converting anything. A plain static import of the
 * converters is safe alongside it, because none of them touch a browser global
 * at module scope — every use is inside a function.
 */
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { JSDOM } from 'jsdom'
import { setConvertRuntime } from '../lib/convert/runtime'

const here = dirname(fileURLToPath(import.meta.url))

/**
 * Where the staged Tesseract engine and English model live.
 *
 * `scripts/stage-tesseract.mjs` copies them out of node_modules into `vendor/`
 * at build time, so the published package carries them and offline OCR needs
 * no network. If staging has not run, this returns the node_modules location,
 * which works in a development checkout.
 */
function tesseractDirectory(): string {
  /*
   * Searched upwards rather than resolved with a fixed number of '..' steps,
   * because this file sits at src/runtime/node.ts in the source tree but is
   * bundled to dist/server.js — two levels up in one layout, one in the other.
   * The first version hard-coded two and silently missed the staged copy, so
   * tesseract fell back to node_modules and failed looking for a worker that
   * lives in a different package.
   */
  for (let dir = here, i = 0; i < 4; i++, dir = dirname(dir)) {
    const staged = join(dir, 'vendor', 'tesseract')
    if (existsSync(staged)) return staged
  }

  const require = createRequire(import.meta.url)
  try {
    return dirname(require.resolve('tesseract.js-core/package.json'))
  } catch {
    // Falling back to an empty string makes tesseract.js use its own defaults,
    // which fetch from a CDN. ocr.ts already handles that path.
    return ''
  }
}

let installed = false

export function installNodeRuntime(): void {
  if (installed) return
  installed = true

  // A single throwaway document serves every parse. jsdom's DOMParser is
  // bound to a window, so one has to exist even though nothing renders.
  const dom = new JSDOM('<!doctype html><html><body></body></html>')
  const g = globalThis as Record<string, unknown>

  /*
   * Only DOMParser, deliberately.
   *
   * An earlier version also defined `document`, and that broke offline OCR:
   * tesseract.js sniffs for a DOM to decide whether it is in a browser, saw
   * one, took the browser path and then died on `window is not defined`.
   * Half a browser is worse than none — a library that detects it will pick
   * the wrong branch and fail somewhere further away from the cause.
   *
   * `document` turned out not to be needed anyway: the only converter that
   * used it was ocr.ts, for a canvas re-encode that is unreachable now that
   * createImageBitmap returns null under Node.
   */
  g.DOMParser ??= dom.window.DOMParser
  g.XMLSerializer ??= dom.window.XMLSerializer

  /**
   * Node has no canvas, and this is only used to re-encode TIFF and BMP, which
   * Tesseract often reads directly anyway. Returning null makes `ocr.ts` fall
   * through to passing the original bytes, which is a graceful degradation
   * rather than a crash — and crucially it keeps `ocr.ts` unmodified.
   */
  g.createImageBitmap ??= async (): Promise<null> => null

  const dir = tesseractDirectory()
  setConvertRuntime({
    // mammoth's Node unzip reads `buffer`; only its browser build understands
    // `arrayBuffer`, and the package swaps between them via the browser field.
    docxSource: (bytes) => ({ buffer: Buffer.from(bytes) }),
    // A Blob reaches tesseract's Node build as a truncated file; a Buffer is
    // what it actually decodes.
    ocrImageInput: (bytes) => Buffer.from(bytes),
    /*
     * No workerPath on purpose. tesseract.js has a Node worker of its own and
     * will use it when not told otherwise; the staged worker.min.js is the
     * browser build and dies on `addEventListener is not a function`.
     * Directory paths rather than URLs, because Node resolves these on disk.
     */
    tesseractPaths: () =>
      dir
        ? {
            corePath: join(dir, '/'),
            langPath: join(dir, '/'),
            // Without this tesseract.js writes the decompressed language data
            // into the current working directory — which, for a server the
            // host launches from wherever it pleases, means littering the
            // user's folders with a 10 MB file.
            cachePath: dir
          }
        : {}
  })
}
