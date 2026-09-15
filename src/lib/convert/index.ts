/**
 * Document → Markdown conversion, in pure TypeScript.
 *
 * Replaces the previous Python bridge. Everything here takes bytes and returns
 * a string, with no filesystem, Electron or Node dependency, so the same code
 * runs unchanged in the planned browser build.
 */
import type { ConvertResult, ConvertOptions } from './types'
import { extensionOf, FORMAT_GROUPS } from './types'
import { normaliseMarkdown } from './normalise'
import { convertPdf } from './pdf'
import { convertDocx, convertSheet, convertPptx, convertOdt, convertEpub } from './office'
import { convertText } from './text'
import { convertImage } from './ocr'
import { convertAudio } from './audio'

export * from './types'
export { normaliseMarkdown } from './normalise'

/**
 * Converts one file. `normalise` flattens deep indentation so that annotations
 * render on the result — see normalise.ts for why that matters.
 */
export async function convertToMarkdown(
  bytes: Uint8Array,
  fileName: string,
  options: ConvertOptions & { normalise?: boolean } = {}
): Promise<ConvertResult> {
  const ext = extensionOf(fileName)
  const { onProgress } = options

  let result: ConvertResult
  try {
    if (ext === 'pdf') {
      onProgress?.('Extracting text from the PDF…', 0.2)
      result = await convertPdf(bytes, fileName)
    } else if (ext === 'docx') {
      onProgress?.('Reading the Word document…', 0.3)
      result = await convertDocx(bytes, fileName)
    } else if (['xlsx', 'xlsm', 'xls', 'ods'].includes(ext)) {
      onProgress?.('Reading the spreadsheet…', 0.3)
      result = convertSheet(bytes, fileName)
    } else if (ext === 'pptx') {
      onProgress?.('Reading the presentation…', 0.3)
      result = await convertPptx(bytes, fileName)
    } else if (ext === 'odt') {
      onProgress?.('Reading the OpenDocument file…', 0.3)
      result = await convertOdt(bytes, fileName)
    } else if (ext === 'epub') {
      onProgress?.('Reading the e-book…', 0.3)
      result = await convertEpub(bytes, fileName)
    } else if (FORMAT_GROUPS.images.includes(ext)) {
      result = await convertImage(bytes, fileName, options)
    } else if (FORMAT_GROUPS.audio.includes(ext)) {
      result = await convertAudio(bytes, fileName, options)
    } else if (FORMAT_GROUPS.text.includes(ext)) {
      onProgress?.('Reading the file…', 0.5)
      result = convertText(bytes, fileName)
    } else {
      return {
        ok: false,
        code: 'UNSUPPORTED',
        error: `.${ext} files are not supported. Supported: ${[...FORMAT_GROUPS.documents, ...FORMAT_GROUPS.images].join(', ')} and common text formats.`
      }
    }
  } catch (err) {
    return {
      ok: false,
      code: 'CONVERT_FAILED',
      error: `Could not read this file: ${String((err as Error)?.message ?? err)}`
    }
  }

  if (!result.ok) return result

  onProgress?.('Tidying up the Markdown…', 0.95)
  const markdown = options.normalise === false ? result.markdown : normaliseMarkdown(result.markdown)

  if (!markdown.trim()) {
    return { ok: false, code: 'EMPTY', error: 'The conversion produced an empty document.' }
  }
  return { ok: true, markdown, meta: result.meta }
}
