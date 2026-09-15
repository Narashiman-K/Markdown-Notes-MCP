/**
 * Which file formats the app can open or convert.
 *
 * Shared by the main process (file dialog filters, open-vs-convert decisions)
 * and the renderer (converter dispatch, UI listings) so the two can never
 * disagree about what is supported.
 */

/** Opened directly as Markdown, no conversion offered. */
export const NATIVE_EXTS = ['md', 'markdown', 'mdown', 'mkd', 'mdx']

/** Readable as text, so they can be opened directly, though conversion often reads better. */
export const TEXT_EXTS = [
  ...NATIVE_EXTS,
  'txt', 'text', 'log', 'csv', 'tsv', 'json', 'yaml', 'yml',
  'ini', 'cfg', 'conf', 'xml', 'html', 'htm', 'rtf', 'srt', 'vtt',
  'py', 'js', 'ts', 'java', 'c', 'cpp', 'cs', 'go', 'rs', 'sh', 'sql'
]

/** Binary documents that must be converted before they can be shown. */
export const DOCUMENT_EXTS = ['pdf', 'docx', 'xlsx', 'xlsm', 'xls', 'pptx', 'odt', 'ods', 'epub']

/** Images, converted by OCR (cloud or offline). */
export const IMAGE_EXTS = ['jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp', 'tif', 'tiff']

/**
 * Audio, transcribed by a cloud service. Deliberately separate: this is the one
 * format the app cannot handle offline, and the UI must say so before the user
 * commits to it.
 */
export const AUDIO_EXTS = ['mp3', 'wav', 'm4a', 'flac', 'ogg', 'aac', 'wma', 'mp4', 'webm']

export const CONVERTIBLE_EXTS = [...DOCUMENT_EXTS, ...TEXT_EXTS, ...IMAGE_EXTS, ...AUDIO_EXTS]

export function needsTranscription(fileName: string): boolean {
  return AUDIO_EXTS.includes(extensionOf(fileName))
}

export function extensionOf(fileName: string): string {
  const m = /\.([^.\\/]+)$/.exec(fileName)
  return m ? m[1].toLowerCase() : ''
}

export function isNative(fileName: string): boolean {
  return NATIVE_EXTS.includes(extensionOf(fileName))
}

export function isReadableText(fileName: string): boolean {
  return TEXT_EXTS.includes(extensionOf(fileName))
}

export function isConvertible(fileName: string): boolean {
  return CONVERTIBLE_EXTS.includes(extensionOf(fileName))
}

export function needsOcr(fileName: string): boolean {
  return IMAGE_EXTS.includes(extensionOf(fileName))
}
