/**
 * Reading text out of images.
 *
 * Two engines, chosen by the user per conversion:
 *
 *   cloud   — Google Gemini via an injected callback. Better accuracy, and it
 *             can describe charts and diagrams, not just transcribe text.
 *             Needs the user's own API key; the image is sent to Google.
 *   offline — Tesseract.js, with its engine and language model served from the
 *             app itself. No key, no network, nothing leaves the machine. Good
 *             on clean printed text, weak on anything else, and it cannot
 *             describe visual structure at all.
 *
 * Tesseract is imported lazily so its several megabytes of WASM only load if
 * the user actually chooses offline OCR.
 */
import type { ConvertResult, ConvertOptions } from './types'
import { extensionOf } from './types'
import { titleFrom, tidy } from './normalise'
import { normaliseOcrLanguages, describeOcrLanguages, tidyOcrText, keepOcrLineBreaks } from './ocrLanguages'
import { convertRuntime } from './runtime'

const MIME: Record<string, string> = {
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  gif: 'image/gif',
  webp: 'image/webp',
  bmp: 'image/bmp',
  tif: 'image/tiff',
  tiff: 'image/tiff'
}

export function mimeFor(fileName: string): string {
  return MIME[extensionOf(fileName)] ?? 'application/octet-stream'
}

/** Tesseract cannot read every format; convert awkward ones via a canvas. */
async function toPngIfNeeded(bytes: Uint8Array, fileName: string): Promise<Blob> {
  const ext = extensionOf(fileName)
  const blob = new Blob([bytes as unknown as BlobPart], { type: mimeFor(fileName) })
  if (!['tif', 'tiff', 'bmp'].includes(ext)) return blob

  const bitmap = await createImageBitmap(blob).catch(() => null)
  if (!bitmap) return blob
  const canvas = document.createElement('canvas')
  canvas.width = bitmap.width
  canvas.height = bitmap.height
  canvas.getContext('2d')?.drawImage(bitmap, 0, 0)
  bitmap.close()
  return new Promise((resolve) => canvas.toBlob((b) => resolve(b ?? blob), 'image/png'))
}

/**
 * Points tesseract.js at the copies of its worker, engine and language model
 * that `scripts/tesseract-assets.mjs` stages into the build.
 *
 * Left to its own devices, tesseract.js fetches all three from jsdelivr on
 * first use. That makes "offline" OCR fail with no signal — the exact case it
 * exists for — and puts a third party in the request path. These paths are
 * relative to the app's own origin, and on Android they resolve inside the APK.
 */
function localPaths(): { workerPath?: string; corePath?: string; langPath?: string; cachePath?: string; workerBlobURL: boolean } {
  return {
    // Where the files are depends on the host: the app's own origin in a
    // browser, the package's vendor folder under Node (see runtime.ts).
    ...convertRuntime().tesseractPaths(),
    /*
     * Start the worker straight from its URL rather than from a blob: wrapper.
     * The wrapper exists so a worker can be started from a cross-origin CDN
     * script, which these local paths never need. Under the Windows app's
     * Content-Security-Policy it was fatal: a blob: worker is refused, so
     * offline OCR there failed at "Failed to construct 'Worker'" on every
     * image. Node ignores the setting.
     */
    workerBlobURL: false
  }
}

/**
 * Below this, an offline OCR result is treated as unreadable, not merely rough.
 *
 * Measured, not chosen: clean English printed text reads at 95%, while Hindi
 * read with the English model came back at 33% and Kannada at 22%, both as
 * meaningless Latin letters. Real but blurry English scans land between 60 and
 * 75, and keep only the milder note. A result under this line has almost
 * always been read with the wrong language: the pages are in a script the
 * chosen models do not cover.
 */
export const UNREADABLE_CONFIDENCE = 60

/** Shown at the very top of a result that is very probably nonsense. */
export function unreadableWarning(confidence: number, languages?: readonly string[]): string {
  const read = describeOcrLanguages(normaliseOcrLanguages(languages))
  return (
    `> **This result is probably not readable.** Offline OCR was only ${confidence}% confident reading it as ${read}. ` +
    'That usually means the pages are in another language or script. Convert again with the ' +
    "document's language chosen for offline OCR (in the apps: **Text language** in Convert to Markdown), " +
    'or use **Cloud** OCR.\n\n'
  )
}

/** One loaded Tesseract engine, reusable across many images. */
export interface OfflineReader {
  /**
   * Reads one image. `onFraction` receives 0–1 progress for this image alone.
   * A Blob in a browser; under Node, whatever runtime.ts's ocrImageInput gives.
   */
  read(image: unknown, onFraction?: (fraction: number) => void): Promise<{ text: string; confidence: number }>
  close(): Promise<void>
}

/**
 * Loads the offline engine once, for one image or for every page of a scanned
 * PDF. Starting Tesseract — worker, WASM core, language model — costs a second
 * or more, so a forty-page scan must not pay it forty times.
 */
export async function openOfflineReader(
  onProgress?: ConvertOptions['onProgress'],
  languages?: readonly string[]
): Promise<OfflineReader> {
  // Several languages load together as `kan+eng`; each one is another model
  // to load and another to try on every line, so only the chosen ones load.
  const langs = normaliseOcrLanguages(languages)
  onProgress?.(`Loading the offline OCR engine (${describeOcrLanguages(langs)})…`, 0.05)
  const { createWorker } = await import('tesseract.js')

  let report: (fraction: number) => void = () => {}
  const logger = (m: { status?: string; progress?: number }): void => {
    if (m.status === 'recognizing text') report(m.progress ?? 0)
  }

  // Falls back to the library's own defaults if the bundled copies cannot be
  // loaded — a stale service worker cache, say, or a device that rejects the
  // WASM build. Degrading to a CDN fetch is better than refusing to work, and
  // the image still never leaves the device either way. (The Windows app's CSP
  // refuses that CDN, so there the fallback fails too, and the original error
  // is the one that matters.)
  let worker: Awaited<ReturnType<typeof createWorker>>
  try {
    worker = await createWorker(langs, 1, { ...localPaths(), logger })
  } catch (localErr) {
    console.warn('Bundled Tesseract engine unavailable, falling back to the CDN.', localErr)
    try {
      worker = await createWorker(langs, 1, { logger })
    } catch (cdnErr) {
      // Report both. The fallback's error alone is misleading: it describes
      // why the CDN copy failed, when the real question is why the bundled
      // one did — that was hidden this way once already.
      const why = (e: unknown): string => String((e as Error)?.message ?? e)
      throw new Error(
        `The offline OCR engine could not start (${why(localErr)}), and the online fallback failed too (${why(cdnErr)}).`
      )
    }
  }

  return {
    async read(image, onFraction) {
      report = onFraction ?? (() => {})
      try {
        const { data } = await worker.recognize(image as Parameters<typeof worker.recognize>[0])
        return {
          text: keepOcrLineBreaks(tidyOcrText(data.text ?? '')).trim(),
          confidence: Math.round(data.confidence ?? 0)
        }
      } finally {
        report = () => {}
      }
    },
    async close() {
      await worker.terminate()
    }
  }
}

async function offlineOcr(
  bytes: Uint8Array,
  fileName: string,
  onProgress?: ConvertOptions['onProgress'],
  languages?: readonly string[]
): Promise<ConvertResult> {
  const reader = await openOfflineReader(onProgress, languages)
  try {
    const image = convertRuntime().ocrImageInput(bytes, await toPngIfNeeded(bytes, fileName))
    const { text, confidence } = await reader.read(image, (f) =>
      onProgress?.('Reading text from the image…', 0.3 + f * 0.7)
    )

    if (!text) {
      return {
        ok: false,
        code: 'NO_TEXT',
        error:
          'No text could be read from this image. Offline OCR works best on clear, printed text — cloud OCR may do better.'
      }
    }

    const warning =
      confidence < 70
        ? '\n\n> **Note:** offline OCR reported low confidence on this image. Cloud OCR would likely read it more accurately.'
        : ''

    const top = confidence < UNREADABLE_CONFIDENCE ? unreadableWarning(confidence, languages) : ''
    return {
      ok: true,
      markdown: top + tidy([`# ${titleFrom(fileName)}`, text]) + (top ? '' : warning),
      meta: { engine: 'tesseract', confidence, languages: normaliseOcrLanguages(languages).join('+') }
    }
  } finally {
    await reader.close()
  }
}

export async function convertImage(
  bytes: Uint8Array,
  fileName: string,
  options: ConvertOptions = {}
): Promise<ConvertResult> {
  // Offline unless a caller asks for the cloud explicitly. Nothing should
  // reach a third party because an option was left unset.
  const mode = options.ocrMode ?? 'offline'

  if (mode === 'offline') {
    return offlineOcr(bytes, fileName, options.onProgress, options.ocrLanguages)
  }

  if (!options.cloudOcr) {
    return {
      ok: false,
      code: 'NO_CLOUD_OCR',
      error: 'Cloud OCR needs a Google Gemini API key, or switch to offline OCR.'
    }
  }

  options.onProgress?.('Sending the image for text extraction…', 0.3)
  try {
    const text = (await options.cloudOcr(bytes, mimeFor(fileName))).trim()
    if (!text) {
      return { ok: false, code: 'NO_TEXT', error: 'The service returned no text for this image.' }
    }
    // Models often wrap the whole answer in a fence; unwrap it.
    const unwrapped = text.replace(/^```(?:markdown)?\s*\n?/i, '').replace(/\n?```\s*$/i, '')
    const hasHeading = /^#\s/.test(unwrapped)
    return {
      ok: true,
      markdown: hasHeading ? unwrapped : tidy([`# ${titleFrom(fileName)}`, unwrapped]),
      meta: { engine: 'gemini' }
    }
  } catch (err) {
    return { ok: false, code: 'CLOUD_FAILED', error: String((err as Error)?.message ?? err) }
  }
}
