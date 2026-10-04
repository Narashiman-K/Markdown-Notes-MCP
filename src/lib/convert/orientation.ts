/**
 * Turning scanned pages and photos upright before they are read.
 *
 * A page fed into the scanner upside down, or a photo taken sideways, reaches
 * OCR as text the engine cannot recognise, and it does not fail: it returns
 * confident-looking nonsense (a real construction agreement, scanned upside
 * down, came out as "waladwon ayy Luo) asead fouedalosip"). So every picture
 * is checked first and turned before it is read, and the turned version is
 * also what is kept beside the text, so the original shows the right way up.
 *
 * How the turn is found: the engine's own confidence. Text the right way up
 * reads with high confidence; upside down or sideways it reads badly. A page
 * that already reads well is left alone, so an upright page costs nothing
 * extra. Only one that reads poorly is tried at the other three quarter turns,
 * on a smaller copy, and turned if one of them reads clearly better. Because
 * this asks the same engine, with the same languages, that will read the
 * page, it works for every language the user has chosen.
 *
 * Browser only: turning needs a canvas. Under Node (the MCP package) pages are
 * read as they come, as before.
 *
 * Kept identical across the Windows app, the web app and the MCP package.
 */
import type { OfflineReader } from './ocr'

export type Turn = 0 | 90 | 180 | 270

/** A page reading at least this well is taken to be the right way up. */
export const UPRIGHT_CONFIDENCE = 70
/** Another turn must read at least this much better to be chosen. */
const MARGIN = 10
/** Width of the copies tried at each turn: enough to read, quick to read. */
const PROBE_WIDTH = 1400

export function canTurn(): boolean {
  return typeof document !== 'undefined'
}

/**
 * The picture turned clockwise by `turn` degrees, on a new canvas, scaled
 * down to `maxWidth` (measured across the original) when given.
 */
export function turnCanvas(source: CanvasImageSource & { width: number; height: number }, turn: Turn, maxWidth = Infinity): HTMLCanvasElement {
  const scale = Math.min(1, maxWidth / source.width)
  const w = Math.max(1, Math.round(source.width * scale))
  const h = Math.max(1, Math.round(source.height * scale))
  const sideways = turn === 90 || turn === 270
  const out = document.createElement('canvas')
  out.width = sideways ? h : w
  out.height = sideways ? w : h
  const g = out.getContext('2d')
  if (!g) throw new Error('This system could not create a drawing surface for the page.')
  g.fillStyle = '#ffffff'
  g.fillRect(0, 0, out.width, out.height)
  g.imageSmoothingQuality = 'high'
  g.translate(out.width / 2, out.height / 2)
  g.rotate((turn * Math.PI) / 180)
  g.drawImage(source, -w / 2, -h / 2, w, h)
  return out
}

export function canvasBlob(canvas: HTMLCanvasElement, type = 'image/png', quality?: number): Promise<Blob> {
  return new Promise((resolve, reject) =>
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('Could not capture the page image.'))), type, quality)
  )
}

/** Draws an image file onto a canvas, honouring a photo's own EXIF rotation. */
export async function imageCanvas(blob: Blob): Promise<HTMLCanvasElement | null> {
  if (!canTurn() || typeof createImageBitmap === 'undefined') return null
  const bitmap = await createImageBitmap(blob, { imageOrientation: 'from-image' }).catch(() => null)
  if (!bitmap) return null
  try {
    return turnCanvas(bitmap, 0)
  } finally {
    bitmap.close()
  }
}

/**
 * Which way to turn a page so that it reads.
 *
 * `uprightConfidence`, when the page has already been read as it is, saves
 * reading it again. Returns 0 when the page is fine as it is, or when no other
 * turn reads clearly better.
 */
export async function findTurn(
  page: HTMLCanvasElement,
  reader: OfflineReader,
  uprightConfidence?: number
): Promise<{ turn: Turn; confidence: number }> {
  const probe = async (turn: Turn): Promise<number> => {
    const copy = turnCanvas(page, turn, PROBE_WIDTH)
    try {
      const { text, confidence } = await reader.read(await canvasBlob(copy))
      return text.trim() ? confidence : 0
    } finally {
      copy.width = 0
      copy.height = 0
    }
  }

  const upright = uprightConfidence ?? (await probe(0))
  if (upright >= UPRIGHT_CONFIDENCE) return { turn: 0, confidence: upright }

  let best: { turn: Turn; confidence: number } = { turn: 0, confidence: upright }
  // Upside down first: the commonest mistake at a scanner.
  for (const turn of [180, 90, 270] as const) {
    const confidence = await probe(turn)
    if (confidence > best.confidence) best = { turn, confidence }
    if (confidence >= UPRIGHT_CONFIDENCE + MARGIN) break
  }
  return best.turn !== 0 && best.confidence >= upright + MARGIN ? best : { turn: 0, confidence: upright }
}

/** "Page 1 was upside down", "Pages 2 and 3 were on their side". */
export function describeTurns(turned: Array<{ page: number; turn: Turn }>): string {
  const groups: Record<string, number[]> = {}
  for (const { page, turn } of turned) {
    const how = turn === 180 ? 'upside down' : 'on its side'
    ;(groups[how] ??= []).push(page)
  }
  return Object.entries(groups)
    .map(([how, pages]) => {
      const list = pages.length === 1 ? `${pages[0]}` : `${pages.slice(0, -1).join(', ')} and ${pages[pages.length - 1]}`
      const side = how === 'on its side' && pages.length > 1 ? 'on their side' : how
      return `Page${pages.length > 1 ? 's' : ''} ${list} ${pages.length > 1 ? 'were' : 'was'} ${side}`
    })
    .join('; ')
}
