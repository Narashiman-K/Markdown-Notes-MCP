/**
 * Converts every sample file and reports what came back.
 *
 * Runs against the built bundle rather than the TypeScript sources, because the
 * failures that matter here are runtime ones — a browser global that was not
 * shimmed, or a library resolving a file relative to its own package — and
 * those only show up once bundled.
 */
import { readFile, readdir } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const { convertToMarkdown } = await import(pathToFileURL(join(root, 'dist', 'index.js')).href)

// .md files are this script's own output from previous runs, and make.py is
// the generator. Converting Markdown to Markdown proves nothing.
const files = (await readdir(join(root, 'samples'))).filter(
  (f) => f !== 'make.py' && !f.endsWith('.md')
)

let pass = 0
for (const name of files) {
  const bytes = new Uint8Array(await readFile(join(root, 'samples', name)))
  const started = Date.now()
  try {
    // Offline OCR explicitly: the library's own default is cloud, which would
    // fail here for want of a key and tell us nothing about the bundled engine.
    const r = await convertToMarkdown(bytes, name, { ocrMode: 'offline' })
    if (r.ok) {
      pass++
      console.log(`ok      ${name.padEnd(14)} ${String(r.markdown.length).padStart(6)} chars  ${Date.now() - started}ms`)
    } else {
      console.log(`FAILED  ${name.padEnd(14)} ${r.code}: ${r.error}`)
    }
  } catch (err) {
    console.log(`THREW   ${name.padEnd(14)} ${String(err?.message ?? err).split('\n')[0]}`)
  }
}

console.log(`\n${pass}/${files.length} converted`)
process.exit(pass === files.length ? 0 : 1)
