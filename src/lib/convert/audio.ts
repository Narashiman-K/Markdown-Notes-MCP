/**
 * Audio → Markdown transcript.
 *
 * Unlike every other converter in this folder, this one cannot work offline.
 * Speech recognition of usable quality needs either a cloud service or a
 * multi-gigabyte local model, so audio is a deliberate, clearly-labelled
 * exception: the user supplies their own key and is told before anything is
 * uploaded.
 *
 * The actual network call is injected, keeping this module free of platform
 * code like every other converter.
 */
import type { ConvertResult, ConvertOptions } from './types'
import { titleFrom, tidy } from './normalise'

export type CloudTranscribe = (bytes: Uint8Array) => Promise<string>

function formatDuration(seconds?: number): string {
  if (!seconds || !Number.isFinite(seconds)) return ''
  const m = Math.floor(seconds / 60)
  const s = Math.round(seconds % 60)
  return m ? `${m} min ${s} sec` : `${s} sec`
}

export async function convertAudio(
  bytes: Uint8Array,
  fileName: string,
  options: ConvertOptions & { transcribe?: CloudTranscribe; durationSeconds?: number } = {}
): Promise<ConvertResult> {
  if (!options.transcribe) {
    return {
      ok: false,
      code: 'NO_TRANSCRIBER',
      error: 'Audio transcription needs an AssemblyAI API key. This is the only feature that cannot run offline.'
    }
  }

  options.onProgress?.('Preparing the audio…', 0.05)
  try {
    const text = (await options.transcribe(bytes)).trim()
    if (!text) {
      return { ok: false, code: 'EMPTY', error: 'No speech was detected in this file.' }
    }

    // Break the single wall of text into readable paragraphs at sentence ends.
    const paragraphs: string[] = []
    let current: string[] = []
    for (const sentence of text.split(/(?<=[.!?])\s+/)) {
      current.push(sentence)
      if (current.length >= 4) {
        paragraphs.push(current.join(' '))
        current = []
      }
    }
    if (current.length) paragraphs.push(current.join(' '))

    const duration = formatDuration(options.durationSeconds)
    return {
      ok: true,
      markdown: tidy([
        `# ${titleFrom(fileName)} — transcript`,
        duration ? `*Audio length: ${duration}*` : '',
        ...paragraphs
      ]),
      meta: { engine: 'assemblyai', words: text.split(/\s+/).length }
    }
  } catch (err) {
    return { ok: false, code: 'TRANSCRIBE_FAILED', error: String((err as Error)?.message ?? err) }
  }
}
