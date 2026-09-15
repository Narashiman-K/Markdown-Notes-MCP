export interface ConvertOk {
  ok: true
  markdown: string
  meta?: Record<string, unknown>
}

export interface ConvertFail {
  ok: false
  error: string
  code?: string
}

export type ConvertResult = ConvertOk | ConvertFail

/**
 * Cloud OCR is injected rather than imported, so this whole module stays free
 * of platform code and ports to the web build unchanged. The desktop app wires
 * it to an IPC call that holds the API key in the main process.
 */
export type CloudOcr = (bytes: Uint8Array, mimeType: string) => Promise<string>

export interface ConvertOptions {
  /** 'cloud' uses the injected OCR; 'offline' uses bundled Tesseract. */
  ocrMode?: 'cloud' | 'offline'
  cloudOcr?: CloudOcr
  /** Injected for audio, which has no offline path. */
  transcribe?: (bytes: Uint8Array) => Promise<string>
  durationSeconds?: number
  /** Progress reports for slow work such as OCR and large PDFs. */
  onProgress?: (message: string, fraction?: number) => void
}

import { DOCUMENT_EXTS, TEXT_EXTS, IMAGE_EXTS, AUDIO_EXTS, CONVERTIBLE_EXTS } from '../../shared/formats'

export {
  extensionOf,
  needsOcr,
  needsTranscription,
  isConvertible as isSupported
} from '../../shared/formats'

export const FORMAT_GROUPS = {
  documents: DOCUMENT_EXTS,
  text: TEXT_EXTS,
  images: IMAGE_EXTS,
  audio: AUDIO_EXTS
}

export const ALL_FORMATS = CONVERTIBLE_EXTS
