/**
 * The two conversions that cannot run locally.
 *
 * Both are injected into the converters rather than imported by them, which is
 * why `src/lib/convert/` stays free of network code and identical to the app
 * copies. Both stay dormant until the corresponding key is present: the server
 * advertises the tools either way, and returns a clear instruction rather than
 * a failure when a key is missing.
 *
 * Keys are read from the environment, which is how every MCP host supplies
 * configuration. They are never written to disk and never logged.
 */

const GEMINI = 'https://generativelanguage.googleapis.com/v1beta/models'
const ASSEMBLY = 'https://api.assemblyai.com/v2'

/**
 * An unsubstituted `${user_config.x}` placeholder counts as unset.
 *
 * A host can pass the literal template through when its settings field is
 * empty, and treating that as a key produces a baffling authentication error
 * instead of the clear "no key configured" message the user needs.
 */
function key(name: string): string | undefined {
  const raw = process.env[name]?.trim()
  if (!raw || /^\$\{.*\}$/.test(raw)) return undefined
  return raw
}

export function geminiKey(): string | undefined {
  return key('GEMINI_API_KEY')
}

export function assemblyKey(): string | undefined {
  return key('ASSEMBLYAI_API_KEY')
}

function toBase64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64')
}

/**
 * Reads an image with Gemini. Unlike Tesseract this can describe layout,
 * charts and diagrams rather than only transcribing glyphs, which is usually
 * what makes a scanned page useful to a model downstream.
 */
export async function geminiOcr(bytes: Uint8Array, mimeType: string): Promise<string> {
  const key = geminiKey()
  if (!key) throw new Error('GEMINI_API_KEY is not set.')

  /*
   * Overridable, because Google retires model names on a schedule that has
   * nothing to do with this package's release cadence — gemini-2.0-flash was
   * already returning 404 by September 2026. The default is therefore the
   * `-latest` alias, which always resolves to a current model, and
   * GEMINI_OCR_MODEL pins a specific one when that matters.
   */
  const model = process.env.GEMINI_OCR_MODEL?.trim() || 'gemini-flash-latest'
  const prompt =
    'Transcribe this image as clean Markdown. Preserve headings, lists and ' +
    'tables. Describe charts or diagrams briefly in italics. Output only the ' +
    'Markdown, with no preamble and no code fence around the whole answer.'

  const r = await fetch(`${GEMINI}/${model}:generateContent?key=${encodeURIComponent(key)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{ parts: [{ text: prompt }, { inline_data: { mime_type: mimeType, data: toBase64(bytes) } }] }]
    })
  })

  if (!r.ok) throw new Error(`Gemini replied ${r.status}: ${(await r.text()).slice(0, 300)}`)

  const data = (await r.json()) as {
    candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>
  }
  const text = data.candidates?.[0]?.content?.parts?.map((p) => p.text ?? '').join('') ?? ''
  if (!text.trim()) throw new Error('Gemini returned no text for this image.')
  return text
}

/**
 * Transcribes audio with AssemblyAI: upload, then poll.
 *
 * This is the one conversion with no offline path at all, and the only one
 * where the user's file necessarily leaves the machine. The tool description
 * says so, so that a model relaying it to a user does not imply otherwise.
 */
export async function assemblyTranscribe(bytes: Uint8Array): Promise<string> {
  const key = assemblyKey()
  if (!key) throw new Error('ASSEMBLYAI_API_KEY is not set.')
  const headers = { authorization: key }

  const up = await fetch(`${ASSEMBLY}/upload`, {
    method: 'POST',
    headers: { ...headers, 'Content-Type': 'application/octet-stream' },
    body: bytes as unknown as BodyInit
  })
  if (!up.ok) throw new Error(`AssemblyAI upload failed: ${up.status}`)
  const { upload_url: uploadUrl } = (await up.json()) as { upload_url: string }

  const start = await fetch(`${ASSEMBLY}/transcript`, {
    method: 'POST',
    headers: { ...headers, 'Content-Type': 'application/json' },
    body: JSON.stringify({ audio_url: uploadUrl, punctuate: true, format_text: true })
  })
  if (!start.ok) throw new Error(`AssemblyAI rejected the job: ${start.status}`)
  const { id } = (await start.json()) as { id: string }

  // Polling rather than webhooks: an MCP server has no public URL to be called
  // back on. Capped so a stuck job cannot hang the host indefinitely.
  const deadline = Date.now() + 15 * 60 * 1000
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 3000))
    const poll = await fetch(`${ASSEMBLY}/transcript/${id}`, { headers })
    if (!poll.ok) throw new Error(`AssemblyAI polling failed: ${poll.status}`)
    const t = (await poll.json()) as { status: string; text?: string; error?: string }
    if (t.status === 'completed') return t.text ?? ''
    if (t.status === 'error') throw new Error(t.error ?? 'Transcription failed.')
  }
  throw new Error('Transcription timed out after 15 minutes.')
}
