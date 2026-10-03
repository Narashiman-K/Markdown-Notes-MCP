/**
 * Reading a scanned PDF: draw each page, then OCR the picture.
 *
 * A scanned PDF is a stack of photographs with no text layer, so pdf.ts finds
 * nothing to extract and reports SCANNED_PDF. Until now that report went
 * straight to the user as an error. Instead, each page is rendered to a canvas
 * at roughly 300 dpi — the resolution Tesseract is trained for — and read the
 * same way an image file is, through one engine loaded once for the whole
 * document.
 *
 * Browser-only, deliberately: rendering a page needs a canvas, which Node does
 * not have without a native module, and this project has none. `canOcrPdf`
 * says whether this environment can do it; where it cannot (the MCP server, the
 * VS Code extension) the SCANNED_PDF report stands as before.
 *
 * The engine follows the user's OCR choice: Gemini when cloud OCR is chosen
 * and a key is present, otherwise offline Tesseract, so a missing key degrades
 * to reading locally rather than to an error.
 */
import * as pdfjs from 'pdfjs-dist'
import type { ConvertResult, ConvertOptions } from './types'
import { titleFrom, tidy } from './normalise'
import { openOfflineReader, unreadableWarning, UNREADABLE_CONFIDENCE, type OfflineReader } from './ocr'
import { CloudCaller } from './cloudRetry'
import { normaliseOcrLanguages } from './ocrLanguages'
import { PAGE_BREAK, pageSizeLine } from './pageNotes'

/** Pixels across an A4 page at 300 dpi, the width pages are scaled towards. */
const TARGET_WIDTH = 2480
/**
 * Width of a kept page picture: about 135 dpi on A4. Sharp enough to read on
 * screen beside the text, and a JPEG of a text page at this size is roughly
 * 100–250 KB, where the 300 dpi image read by OCR would be several MB.
 */
const KEEP_WIDTH = 1120

export function canOcrPdf(): boolean {
  return typeof document !== 'undefined'
}

interface RenderedPage {
  /** For OCR: a lossless 300 dpi PNG. */
  image: Blob
  /** For keeping, when asked: a smaller JPEG as a data URL. */
  keep?: string
}

/** A downscaled copy of the page as a JPEG data URL. */
async function keepCopy(source: HTMLCanvasElement): Promise<string> {
  const scale = Math.min(1, KEEP_WIDTH / source.width)
  const small = document.createElement('canvas')
  small.width = Math.round(source.width * scale)
  small.height = Math.round(source.height * scale)
  const g = small.getContext('2d')
  if (!g) throw new Error('This system could not create a drawing surface for the page.')
  g.imageSmoothingQuality = 'high'
  g.drawImage(source, 0, 0, small.width, small.height)
  try {
    const blob = await new Promise<Blob>((resolve, reject) =>
      small.toBlob((b) => (b ? resolve(b) : reject(new Error('Could not keep the page image.'))), 'image/jpeg', 0.72)
    )
    return await new Promise<string>((resolve, reject) => {
      const reader = new FileReader()
      reader.onload = () => resolve(String(reader.result))
      reader.onerror = () => reject(reader.error ?? new Error('Could not keep the page image.'))
      reader.readAsDataURL(blob)
    })
  } finally {
    small.width = 0
    small.height = 0
  }
}

async function renderPage(page: pdfjs.PDFPageProxy, keep: boolean): Promise<RenderedPage> {
  const natural = page.getViewport({ scale: 1 })
  // Small pages are scaled up towards 300 dpi; no page is drawn larger than
  // 4x, which bounds memory on an unusually large sheet.
  const scale = Math.min(4, Math.max(2, TARGET_WIDTH / natural.width))
  const viewport = page.getViewport({ scale })

  const canvas = document.createElement('canvas')
  canvas.width = Math.ceil(viewport.width)
  canvas.height = Math.ceil(viewport.height)
  const context = canvas.getContext('2d')
  if (!context) throw new Error('This system could not create a drawing surface for the page.')
  // Scans with transparency would otherwise read as black-on-black.
  context.fillStyle = '#ffffff'
  context.fillRect(0, 0, canvas.width, canvas.height)

  try {
    /*
     * 'print' intent: pdf.js paces on-screen rendering with
     * requestAnimationFrame, which the browser suspends in a background tab.
     * Switching tabs during a long scan would freeze the OCR mid-page until the
     * tab was shown again. Print rendering draws the same page without waiting
     * for frames.
     */
    await page.render({ canvasContext: context, viewport, intent: 'print' }).promise
    const image = await new Promise<Blob>((resolve, reject) =>
      canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('Could not capture the page image.'))), 'image/png')
    )
    return { image, keep: keep ? await keepCopy(canvas) : undefined }
  } finally {
    // A rendered A4 page is ~35 MB of pixels; let it go before the next one.
    canvas.width = 0
    canvas.height = 0
  }
}

export async function ocrScannedPdf(
  bytes: Uint8Array,
  fileName: string,
  options: ConvertOptions = {}
): Promise<ConvertResult> {
  const { onProgress } = options
  const wantCloud = options.ocrMode === 'cloud' && !!options.cloudOcr

  const doc = await pdfjs.getDocument({ data: bytes, useWorkerFetch: false }).promise
  const pages = doc.numPages
  let reader: OfflineReader | null = null
  /** Set once the cloud has failed for good: every later page goes offline. */
  let cloudGaveUp: string | null = null
  const offlinePages: number[] = []
  const kept: Array<string | undefined> = []
  let pageSize: { width: number; height: number } | null = null

  const status = (n: number, f: number, extra = ''): void =>
    onProgress?.(`Scanned PDF — reading page ${n} of ${pages}…${extra}`, (n - 1 + f) / pages)

  const cloud = new CloudCaller({
    onWait: (seconds, attempt) =>
      onProgress?.(`Scanned PDF — the cloud service is busy; trying again in ${seconds} s (attempt ${attempt + 1})…`)
  })

  const readOffline = async (n: number, image: Blob): Promise<{ text: string; confidence: number }> => {
    reader ??= await openOfflineReader(onProgress, options.ocrLanguages)
    return reader.read(image, (f) => status(n, f, wantCloud ? ' (offline)' : ''))
  }

  try {
    const texts: string[] = []
    const confidences: number[] = []

    for (let n = 1; n <= pages; n++) {
      status(n, 0)
      const page = await doc.getPage(n)
      if (!pageSize) {
        const v = page.getViewport({ scale: 1 })
        pageSize = { width: v.width, height: v.height }
      }
      const { image, keep } = await renderPage(page, options.keepPageImages === true)
      kept.push(keep)
      page.cleanup()

      if (wantCloud && !cloudGaveUp) {
        try {
          const bytesOut = new Uint8Array(await image.arrayBuffer())
          const raw = await cloud.run(() => options.cloudOcr!(bytesOut, 'image/png'))
          texts.push(raw.trim().replace(/^```(?:markdown)?\s*\n?/i, '').replace(/\n?```\s*$/i, ''))
          continue
        } catch (err) {
          // Retries are spent, or the error is one retrying cannot fix. Rather
          // than lose the pages already read, carry on offline from here: a
          // service that has just refused us is unlikely to accept the next
          // page, and waiting out its backoff on every page would cost minutes.
          cloudGaveUp = String((err as Error)?.message ?? err)
        }
      }

      const { text, confidence } = await readOffline(n, image)
      texts.push(text)
      if (text) confidences.push(confidence)
      if (wantCloud) offlinePages.push(n)
    }

    if (!texts.some((t) => t.length > 0)) {
      return {
        ok: false,
        code: 'NO_TEXT',
        error:
          'This is a scanned PDF, and no text could be read from any of its pages. ' +
          (wantCloud && !cloudGaveUp ? 'The pages may be blank or unreadable.' : 'Offline OCR works best on clear, printed text — cloud OCR may do better.')
      }
    }

    const parts: string[] = [`# ${titleFrom(fileName)}`]
    if (pageSize) parts.push(pageSizeLine(pageSize.width, pageSize.height))
    texts.forEach((text, i) => {
      if (i > 0) parts.push(PAGE_BREAK)
      if (pages > 1) parts.push(`## Page ${i + 1}`)
      // The picture first: page view puts it on the left, the text beside it.
      if (kept[i]) parts.push(`![Original page ${i + 1}](${kept[i]} "suprasuta:scan")`)
      parts.push(text || '_No text could be read from this page._')
    })

    const confidence = confidences.length
      ? Math.round(confidences.reduce((a, b) => a + b, 0) / confidences.length)
      : undefined
    const allCloud = wantCloud && offlinePages.length === 0
    const allOffline = !wantCloud || offlinePages.length === pages
    const how = allCloud ? 'cloud' : allOffline ? 'offline' : 'cloud and offline'
    let note = `\n\n> Read from a scanned PDF by ${how} OCR. Check names and figures against the original.`
    if (wantCloud && offlinePages.length) {
      const which = offlinePages.length === pages ? 'Every page was' : `Page${offlinePages.length > 1 ? 's' : ''} ${offlinePages.join(', ')} ${offlinePages.length > 1 ? 'were' : 'was'}`
      note += ` ${which} read offline because the cloud service was unavailable (${cloudGaveUp ?? 'no reason given'}).`
    }
    const unreadable = confidence !== undefined && confidence < UNREADABLE_CONFIDENCE
    if (confidence !== undefined && confidence < 70 && !unreadable) {
      note += ' Offline OCR reported low confidence; cloud OCR would likely read it more accurately.'
    }

    return {
      ok: true,
      markdown: (unreadable ? unreadableWarning(confidence!, options.ocrLanguages) : '') + tidy(parts) + note,
      meta: {
        engine: allCloud ? 'gemini' : allOffline ? 'tesseract' : 'gemini+tesseract',
        pages,
        scanned: true,
        ...(offlinePages.length && wantCloud ? { offlinePages } : {}),
        ...(confidence !== undefined ? { confidence } : {}),
        ...(allCloud ? {} : { languages: normaliseOcrLanguages(options.ocrLanguages).join('+') })
      }
    }
  } finally {
    // Opened lazily inside readOffline, which TypeScript's flow analysis
    // cannot see, so it would otherwise narrow `reader` to null here.
    await (reader as OfflineReader | null)?.close()
    await doc.destroy()
  }
}
