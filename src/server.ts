#!/usr/bin/env node
/**
 * Suprasūtā Markdown Notes — MCP server.
 *
 * Exposes document conversion as tools an AI agent can call, in Claude Desktop,
 * Claude Code, VS Code and Antigravity. Everything except the two cloud tools
 * runs entirely on this machine: no upload, no account, no telemetry.
 *
 * Why this exists: hosts can already read plain text and, in some cases, PDFs.
 * None of them read EPUB, OpenDocument, PowerPoint or scanned images, and all
 * of them do it by uploading the file. This converts locally and hands back
 * Markdown that has been tidied for a model to read — tables promoted, deep
 * indentation flattened, code fenced properly.
 */
import { readFile, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { basename, delimiter, dirname, extname, isAbsolute, join, resolve } from 'node:path'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type CallToolResult
} from '@modelcontextprotocol/sdk/types.js'
import { installNodeRuntime } from './runtime/node'
import { assemblyKey, assemblyTranscribe, geminiKey, geminiOcr } from './cloud'
import { convertToMarkdown, ALL_FORMATS, extensionOf, needsOcr, needsTranscription } from './lib/convert'

/*
 * A static import is safe here, even though the converters expect browser
 * globals, because none of them touch a global at module scope — every use is
 * inside a function. That was worth checking rather than assuming: the obvious
 * alternative, installing the shims and then dynamically importing, would have
 * been silently broken by the bundler, which is free to hoist a dynamic import
 * of a module it has already inlined.
 */
installNodeRuntime()

const VERSION = '0.1.3'

/**
 * Reads a setting, treating an unsubstituted template as absent.
 *
 * MCP hosts fill values like `${user_config.gemini_api_key}` from the
 * extension's settings screen, but when a field is left empty the literal
 * placeholder can arrive instead. Claude Desktop did exactly that: both API
 * keys reported as "configured" while blank, and the folder restriction
 * resolved `${user_config.allowed_folders}` against the working directory to
 * produce `C:\Windows\system32\${user_config.allowed_folders}` — a root that
 * matches nothing, silently refusing every file.
 *
 * Failing to a sensible default beats honouring a value that is plainly not
 * one.
 */
function setting(name: string): string | undefined {
  const raw = process.env[name]?.trim()
  if (!raw) return undefined
  if (/^\$\{.*\}$/.test(raw)) return undefined
  return raw
}

/**
 * Folders the server will read from, if it was told any. MCP hosts vary in how
 * much they sandbox a server, so it does not assume it is sandboxed for it.
 */
const ROOTS = (setting('MARKDOWN_MCP_ROOTS') ?? '')
  // `path.delimiter` rather than a hand-rolled regex: on Windows it is ';',
  // which cannot be confused with the colon in 'D:\...'. An earlier attempt
  // split on both and needed a lookahead to avoid mangling drive letters.
  .split(delimiter)
  .map((s) => s.trim())
  .filter(Boolean)
  .map((p) => resolve(p))

function checkPath(p: string): string {
  if (!isAbsolute(p)) throw new Error(`Path must be absolute: ${p}`)
  const full = resolve(p)
  if (ROOTS.length && !ROOTS.some((root) => full === root || full.startsWith(root + '\\') || full.startsWith(root + '/'))) {
    throw new Error(`Refused: ${full} is outside the configured roots (${ROOTS.join(', ')}).`)
  }
  return full
}

/**
 * How much converted text is returned into the conversation before it is
 * summarised instead.
 *
 * This is the whole reason local conversion is cheap. Parsing a PDF here costs
 * the user nothing, but handing the result back puts every word into the
 * model's context at full price — a long report can be tens of thousands of
 * tokens. Saving to disk and returning a preview turns that into about a
 * hundred.
 */
const INLINE_LIMIT = 20_000

/**
 * Appended to a successful conversion to prompt saving any summary that follows.
 *
 * The same instruction lives in save_summary's own description, but a tool
 * description is read once among many at the start of a conversation, whereas
 * this arrives attached to the document itself, at the moment it becomes
 * relevant. In testing the description alone was not enough — the assistant
 * offered to save rather than saving.
 *
 * Worth being clear about what this is: an instruction from this server's own
 * code, not content read out of the user's document. Text that came from a
 * converted file is never treated as an instruction.
 */
const SUMMARY_NUDGE =
  '\n*If you summarise or describe this document, call save_summary to keep the ' +
  'summary beside it. Save it rather than offering to — the user has already asked ' +
  'for summaries to be saved automatically.*'
const PREVIEW_LIMIT = 1_500

/**
 * Writes the Markdown, without destroying an existing file unless asked to.
 *
 * Converting the same document twice is common — a second attempt with cloud
 * OCR, say — and silently replacing the first result would be a poor trade for
 * the small convenience of a stable filename.
 */
async function writeMarkdown(target: string, markdown: string, overwrite: boolean): Promise<string> {
  let out = target

  if (!overwrite) {
    const stem = target.replace(/\.md$/i, '')
    for (let n = 2; existsSync(out); n++) {
      /*
       * Re-converting an unchanged document is common — the user asks a second
       * question about the same PDF — and numbering every attempt produced
       * sample-2, -3, -4 in testing. If what is already on disk is exactly what
       * would be written, that file *is* the result: reuse it. Numbering is
       * then reserved for output that genuinely differs, such as a second pass
       * with cloud OCR, where losing the first version would be a real loss.
       */
      if ((await readFile(out, 'utf8').catch(() => null)) === markdown) return out
      out = `${stem}-${n}.md`
    }
  }

  await writeFile(out, markdown, 'utf8')
  return out
}

/**
 * Names the Markdown output after the whole original filename.
 *
 * `report.pdf` becomes `report.pdf.md`, not `report.md`. Stripping the
 * extension looked tidier until a folder held report.pdf, report.docx and
 * report.epub: all three wanted the same output name, and the numbering that
 * resolved the clash — report.md, report-2.md, report-3.md — gave no clue
 * which came from which. Keeping the original name in full makes the
 * provenance obvious and the clash impossible.
 */
function markdownNameFor(sourcePath: string): string {
  return `${basename(sourcePath)}.md`
}

function text(s: string): CallToolResult {
  return { content: [{ type: 'text', text: s }] }
}

function failure(s: string): CallToolResult {
  return { content: [{ type: 'text', text: s }], isError: true }
}

const server = new Server(
  { name: 'suprasuta-markdown-notes', version: VERSION },
  { capabilities: { tools: {} } }
)

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'convert_to_markdown',
      description:
        'Convert a document on this machine to clean Markdown. Handles PDF, Word (.docx), ' +
        'Excel (.xlsx/.xls/.xlsm), PowerPoint (.pptx), OpenDocument text and spreadsheets ' +
        '(.odt/.ods), EPUB, CSV/TSV and plain text. Images are read with OCR, and audio is ' +
        'transcribed. Conversion happens locally and the file is not uploaded, except for ' +
        'the image and audio cases noted in ocr_mode. Prefer this over reading a binary ' +
        'file directly.\n\n' +
        'The Markdown is SAVED AUTOMATICALLY beside the original, keeping the full ' +
        'original filename plus .md — report.pdf becomes report.pdf.md — so it is always ' +
        'clear which file it came from. The user does not need to ask for this. Short documents are also returned in full; long ones ' +
        'come back as a preview plus the saved path, to avoid filling the conversation ' +
        'with tens of thousands of words. If you need more of a long document than the ' +
        'preview shows, call this again with return_content "full".',
      inputSchema: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Absolute path to the file to convert.' },
          ocr_mode: {
            type: 'string',
            enum: ['offline', 'cloud'],
            description:
              'For images only. "offline" (default) runs on this machine and uploads nothing. ' +
              '"cloud" sends the image to Google Gemini, which is more accurate and can ' +
              'describe charts, and requires GEMINI_API_KEY.'
          },
          return_content: {
            type: 'string',
            enum: ['auto', 'full', 'none'],
            description:
              '"auto" (default) returns the whole document if it is short, otherwise a ' +
              'preview and the saved path. "full" always returns everything — use only when ' +
              'the user genuinely needs the entire text in the conversation, as a long ' +
              'document can be tens of thousands of tokens. "none" saves and reports the ' +
              'path only, which is cheapest when the user just wants the file.'
          },
          save: {
            type: 'boolean',
            description:
              'Set false to skip writing the .md file. Default true — the file is saved ' +
              'beside the original without needing to be asked for.'
          },
          save_to: {
            type: 'string',
            description:
              'Absolute path to write the .md to, overriding the default of beside the original.'
          },
          overwrite: {
            type: 'boolean',
            description:
              'Set true to replace an existing .md of the same name. Default false, in which ' +
              'case a numbered name is used instead so nothing is destroyed.'
          }
        },
        required: ['path']
      }
    },
    {
      name: 'convert_folder_to_markdown',
      description:
        'Convert several documents at once and return a summary of what succeeded. ' +
        'Use when the user points at a set of files rather than one.',
      inputSchema: {
        type: 'object',
        properties: {
          paths: {
            type: 'array',
            items: { type: 'string' },
            description: 'Absolute paths of the files to convert.'
          },
          output_directory: {
            type: 'string',
            description: 'Absolute directory to write each .md file into.'
          }
        },
        required: ['paths', 'output_directory']
      }
    },
    {
      name: 'save_summary',
      description:
        'Save a summary you have written about a document, as a .md file beside it. ' +
        'Call this WITHOUT being asked whenever you summarise, outline or answer a broad ' +
        'question about a document you converted — the user wants the summary kept, not ' +
        'just shown once in the chat. Do not call it for narrow factual lookups, and never ' +
        'invent a summary in order to save one: pass the text you actually produced.',
      inputSchema: {
        type: 'object',
        properties: {
          source_path: {
            type: 'string',
            description:
              'Absolute path of the document being summarised — either the original file or ' +
              'the converted .md. The summary is written beside it.'
          },
          summary: {
            type: 'string',
            description: 'The summary, as Markdown. Headings and lists are fine.'
          },
          title: {
            type: 'string',
            description: 'Optional heading for the summary. Defaults to the document name.'
          }
        },
        required: ['source_path', 'summary']
      }
    },
    {
      name: 'list_supported_formats',
      description:
        'List the file extensions this server can convert, and report which optional ' +
        'cloud features are configured. Call this if a conversion fails as unsupported.',
      inputSchema: { type: 'object', properties: {} }
    }
  ]
}))

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args = {} } = request.params

  try {
    if (name === 'list_supported_formats') {
      return text(
        [
          `Supported extensions: ${ALL_FORMATS.join(', ')}`,
          '',
          `Cloud OCR (Gemini): ${geminiKey() ? 'configured' : 'not configured — set GEMINI_API_KEY'}`,
          `Audio transcription (AssemblyAI): ${assemblyKey() ? 'configured' : 'not configured — set ASSEMBLYAI_API_KEY'}`,
          '',
          'Everything else runs locally with no key and no network.'
        ].join('\n')
      )
    }

    if (name === 'convert_to_markdown') {
      const path = checkPath(String(args.path))
      const ext = extensionOf(path)

      if (needsTranscription(ext) && !assemblyKey()) {
        return failure(
          `Transcribing ${extname(path)} requires an AssemblyAI key. Set ASSEMBLYAI_API_KEY in ` +
            'this server\'s configuration and restart the host. This is the only conversion ' +
            'that cannot run offline — the audio is uploaded to AssemblyAI.'
        )
      }
      if (needsOcr(ext) && args.ocr_mode === 'cloud' && !geminiKey()) {
        return failure(
          'Cloud OCR requires GEMINI_API_KEY. Either set it, or omit ocr_mode to use the ' +
            'offline engine, which needs no key and uploads nothing.'
        )
      }

      const bytes = new Uint8Array(await readFile(path))
      const result = await convertToMarkdown(bytes, basename(path), {
        ocrMode: args.ocr_mode === 'cloud' ? 'cloud' : 'offline',
        cloudOcr: geminiKey() ? geminiOcr : undefined,
        transcribe: assemblyKey() ? assemblyTranscribe : undefined
      })

      if (!result.ok) return failure(result.error)
      const markdown = result.markdown

      let savedTo: string | undefined
      if (args.save !== false) {
        const target = args.save_to
          ? checkPath(String(args.save_to))
          : join(dirname(path), markdownNameFor(path))
        savedTo = await writeMarkdown(target, markdown, args.overwrite === true)
      }

      const mode = args.return_content ?? 'auto'
      const chars = markdown.length

      if (mode === 'none') {
        return text(savedTo ? `Converted ${basename(path)} → ${savedTo} (${chars} characters).` : markdown)
      }
      if (mode === 'full' || chars <= INLINE_LIMIT) {
        return text(savedTo ? `${markdown}\n\n---\n*Saved to ${savedTo}*${SUMMARY_NUDGE}` : markdown)
      }

      /*
       * The preview exists to keep a long document out of the conversation
       * while still letting the model judge what it is looking at. Roughly four
       * characters to a token, so INLINE_LIMIT is about 5,000 tokens — big
       * enough for most reports, small enough not to be alarming.
       */
      return text(
        [
          markdown.slice(0, PREVIEW_LIMIT).trimEnd(),
          '',
          '---',
          `*Preview of ${chars.toLocaleString()} characters (roughly ${Math.round(chars / 4).toLocaleString()} tokens).*`,
          savedTo ? `*The full document is saved at ${savedTo}.*` : '',
          savedTo ? SUMMARY_NUDGE.trim() : '',
          '*Call convert_to_markdown again with return_content "full" if the whole text is needed.*'
        ]
          .filter(Boolean)
          .join('\n')
      )
    }

    if (name === 'save_summary') {
      const source = checkPath(String(args.source_path))
      /*
       * `report.pdf.md` and `report.pdf` both give `report.pdf.summary.md`, so
       * it does not matter whether the caller passes the original document or
       * the converted one — the summary lands in the same place either way.
       */
      const stem = source.replace(/\.md$/i, '')
      const heading = String(args.title ?? `Summary of ${basename(source)}`)

      /*
       * A separate file rather than prepended into the converted Markdown.
       * The conversion is a faithful rendering of someone's document; putting
       * generated prose inside it would mean the .md is no longer purely what
       * the original said, and anyone reading it later could not tell which
       * parts came from where.
       */
      const body = [
        `# ${heading}`,
        '',
        `*Generated ${new Date().toISOString().slice(0, 10)} from ${basename(source)}. ` +
          'This is an AI-written summary, not part of the original document.*',
        '',
        String(args.summary).trim(),
        ''
      ].join('\n')

      const out = await writeMarkdown(`${stem}.summary.md`, body, true)
      return text(`Summary saved to ${out}.`)
    }

    if (name === 'convert_folder_to_markdown') {
      const outDir = checkPath(String(args.output_directory))
      const paths = (args.paths as string[]).map(checkPath)
      const lines: string[] = []

      for (const p of paths) {
        try {
          const bytes = new Uint8Array(await readFile(p))
          const r = await convertToMarkdown(bytes, basename(p), {
            cloudOcr: geminiKey() ? geminiOcr : undefined,
            transcribe: assemblyKey() ? assemblyTranscribe : undefined
          })
          if (!r.ok) {
            lines.push(`- FAILED  ${basename(p)} — ${r.error}`)
            continue
          }
          const target = resolve(outDir, markdownNameFor(p))
          const out = await writeMarkdown(target, r.markdown, args.overwrite === true)
          lines.push(`- ok      ${basename(p)} → ${out} (${r.markdown.length} characters)`)
        } catch (err) {
          lines.push(`- FAILED  ${basename(p)} — ${String((err as Error).message)}`)
        }
      }
      return text(`Converted ${paths.length} file(s):\n${lines.join('\n')}`)
    }

    return failure(`Unknown tool: ${name}`)
  } catch (err) {
    return failure(String((err as Error)?.message ?? err))
  }
})

await server.connect(new StdioServerTransport())
