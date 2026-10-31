/**
 * The pictures in a PDF page that has real text (scanned pages are a picture
 * whole and go through OCR instead, pdfOcr.ts).
 *
 * pdf.js lists what a page draws (its operator list). Each picture drawn is
 * taken out, and its place is worked out by following the drawing position
 * (the transformation matrix) up to it, so pdf.ts can put the picture between
 * the paragraphs above and below it. Pictures come out as JPEG data URLs on a
 * white background (a transparent PNG logo would otherwise turn black),
 * scaled down to at most 1600 px across.
 *
 * Left out: tiny ones (rules, bullets, specks: under 48 px or drawn under 24
 * pt), and image masks (shapes, not pictures). pdf.ts also drops a picture
 * that repeats on three pages or more, which is a header or footer logo.
 *
 * Browser only: it needs a canvas. Under Node (the MCP package)
 * `canExtractImages()` is false and PDFs are converted as text alone.
 *
 * Kept identical across the Windows app, the web app and the MCP package.
 */
import * as pdfjs from 'pdfjs-dist'

export interface PageImage {
  /** Top edge, in the same "down the page" units pdf.ts gives text lines. */
  y: number
  dataUrl: string
  /** For spotting the same picture repeated on several pages. */
  fingerprint: string
}

type Matrix = [number, number, number, number, number, number]

const MAX_WIDTH = 1600
const MIN_PIXELS = 48
const MIN_POINTS = 24

export function canExtractImages(): boolean {
  return typeof document !== 'undefined' && typeof createImageBitmap === 'function'
}

/** `outer` applied after `inner`, as canvas transform() composes them. */
function compose(outer: Matrix, inner: Matrix): Matrix {
  const [a, b, c, d, e, f] = outer
  const [g, h, i, j, k, l] = inner
  return [a * g + c * h, b * g + d * h, a * i + c * j, b * i + d * j, a * k + c * l + e, b * k + d * l + f]
}

interface ImageObject {
  width?: number
  height?: number
  kind?: number
  data?: Uint8ClampedArray | Uint8Array
  bitmap?: ImageBitmap
}

/** pdf.js decodes images itself; this asks for one by name once it is ready. */
function imageObject(page: pdfjs.PDFPageProxy, name: string): Promise<ImageObject | null> {
  const store = (name.startsWith('g_') ? page.commonObjs : page.objs) as unknown as {
    get: (id: string, cb: (obj: ImageObject) => void) => void
  }
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), 5000)
    try {
      store.get(name, (obj) => {
        clearTimeout(timer)
        resolve(obj ?? null)
      })
    } catch {
      clearTimeout(timer)
      resolve(null)
    }
  })
}

/** Raw pixels as pdf.js gives them (1-bit grey, RGB or RGBA) -> RGBA. */
function toRgba(obj: ImageObject): ImageData | null {
  const { width: w = 0, height: h = 0, data, kind } = obj
  if (!data || !w || !h) return null
  const out = new Uint8ClampedArray(w * h * 4)
  if (kind === 3) {
    out.set(data.subarray(0, out.length))
  } else if (kind === 2) {
    for (let p = 0, q = 0; p < w * h; p++, q += 3) {
      out[p * 4] = data[q]
      out[p * 4 + 1] = data[q + 1]
      out[p * 4 + 2] = data[q + 2]
      out[p * 4 + 3] = 255
    }
  } else if (kind === 1) {
    const rowBytes = (w + 7) >> 3
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const on = (data[y * rowBytes + (x >> 3)] >> (7 - (x & 7))) & 1
        const v = on ? 255 : 0
        const p = (y * w + x) * 4
        out[p] = out[p + 1] = out[p + 2] = v
        out[p + 3] = 255
      }
    }
  } else {
    return null
  }
  return new ImageData(out, w, h)
}

async function toDataUrl(obj: ImageObject): Promise<string | null> {
  let source: ImageBitmap | null = obj.bitmap ?? null
  let made = false
  if (!source) {
    const rgba = toRgba(obj)
    if (!rgba) return null
    source = await createImageBitmap(rgba)
    made = true
  }
  try {
    return bitmapToDataUrl(source)
  } finally {
    if (made) source.close()
  }
}

/**
 * A picture from a Word or PowerPoint file (bytes and MIME type) as a JPEG
 * data URL, sized and backed like the PDF ones; null for one the browser
 * cannot draw (EMF, WMF) or one too small to be a picture.
 */
export async function pictureDataUrl(bytes: Uint8Array, mime: string): Promise<string | null> {
  if (!canExtractImages() || /emf|wmf|tiff?/i.test(mime)) return null
  try {
    const bitmap = await createImageBitmap(new Blob([bytes as unknown as BlobPart], { type: mime }))
    try {
      return bitmapToDataUrl(bitmap)
    } finally {
      bitmap.close()
    }
  } catch {
    return null
  }
}

function bitmapToDataUrl(source: ImageBitmap): string | null {
  {
    if (source.width < MIN_PIXELS || source.height < MIN_PIXELS) return null
    const scale = Math.min(1, MAX_WIDTH / source.width)
    const canvas = document.createElement('canvas')
    canvas.width = Math.round(source.width * scale)
    canvas.height = Math.round(source.height * scale)
    const g = canvas.getContext('2d')
    if (!g) return null
    g.fillStyle = '#ffffff'
    g.fillRect(0, 0, canvas.width, canvas.height)
    g.imageSmoothingQuality = 'high'
    g.drawImage(source, 0, 0, canvas.width, canvas.height)
    const url = canvas.toDataURL('image/jpeg', 0.82)
    canvas.width = 0
    canvas.height = 0
    return url
  }
}

/** The pictures on one page, top to bottom. */
export async function extractPageImages(page: pdfjs.PDFPageProxy): Promise<PageImage[]> {
  const ops = await page.getOperatorList()
  const OPS = pdfjs.OPS as Record<string, number>
  const out: PageImage[] = []
  const stack: Matrix[] = []
  let ctm: Matrix = [1, 0, 0, 1, 0, 0]

  for (let i = 0; i < ops.fnArray.length && out.length < 200; i++) {
    const fn = ops.fnArray[i]
    const args = ops.argsArray[i] as unknown[]
    if (fn === OPS.save) stack.push(ctm)
    else if (fn === OPS.restore) ctm = stack.pop() ?? ctm
    else if (fn === OPS.transform) ctm = compose(ctm, args as Matrix)
    else if (fn === OPS.paintFormXObjectBegin) {
      stack.push(ctm)
      if (Array.isArray(args?.[0]) && (args[0] as number[]).length === 6) ctm = compose(ctm, args[0] as Matrix)
    } else if (fn === OPS.paintFormXObjectEnd) ctm = stack.pop() ?? ctm
    else if (fn === OPS.paintImageXObject || fn === OPS.paintInlineImageXObject || fn === OPS.paintImageXObjectRepeat) {
      // Drawn into the unit square, mapped through the current matrix.
      const ys = [ctm[5], ctm[3] + ctm[5], ctm[1] + ctm[5], ctm[1] + ctm[3] + ctm[5]]
      const xs = [ctm[4], ctm[2] + ctm[4], ctm[0] + ctm[4], ctm[0] + ctm[2] + ctm[4]]
      const height = Math.max(...ys) - Math.min(...ys)
      const width = Math.max(...xs) - Math.min(...xs)
      if (height < MIN_POINTS || width < MIN_POINTS) continue
      const obj = fn === OPS.paintInlineImageXObject ? (args[0] as ImageObject) : await imageObject(page, String(args[0]))
      if (!obj) continue
      const dataUrl = await toDataUrl(obj).catch(() => null)
      if (!dataUrl) continue
      out.push({
        // pdf.ts measures text going down the page as -y; the picture's top
        // edge is its highest point.
        y: -Math.max(...ys),
        dataUrl,
        fingerprint: `${dataUrl.length}:${dataUrl.slice(-48)}`
      })
    }
  }
  return out.sort((a, b) => a.y - b.y)
}
