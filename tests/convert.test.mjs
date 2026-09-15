/**
 * Tests against the built bundle, not the sources.
 *
 * Every bug found while porting this package was a runtime one that a type
 * check could not have caught: a browser global that was shimmed too
 * enthusiastically, a library resolving a file relative to its own package, a
 * path that was correct in the source tree and wrong once bundled. So these
 * assert on real files going through the real output.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const samples = join(root, 'samples')
const { convertToMarkdown, ALL_FORMATS } = await import(
  pathToFileURL(join(root, 'dist', 'index.js')).href
)

const convert = async (name, options = {}) =>
  convertToMarkdown(new Uint8Array(await readFile(join(samples, name))), name, options)

test('every document format converts', async (t) => {
  for (const name of ['sample.pdf', 'sample.docx', 'sample.xlsx', 'sample.pptx', 'sample.odt', 'sample.epub', 'sample.csv', 'sample.txt']) {
    await t.test(name, async () => {
      const r = await convert(name)
      assert.equal(r.ok, true, r.ok ? '' : `${r.code}: ${r.error}`)
      assert.ok(r.markdown.trim().length > 0, 'produced empty Markdown')
    })
  }
})

test('Word tables survive as Markdown tables', async () => {
  // Regression: Word tables were silently dropped because the HTML had no
  // <thead> and the cells were wrapped in <p>.
  const r = await convert('sample.docx')
  assert.equal(r.ok, true)
  assert.match(r.markdown, /\|.*\|/, 'no table pipes in the output')
  assert.match(r.markdown, /\|\s*-+/, 'no table header separator')
})

test('offline OCR runs locally and reads the image', async () => {
  // Regression: this failed three different ways under Node — a shimmed
  // `document` made tesseract take the browser path, the staged engine was
  // looked for at the wrong depth once bundled, and its Node build cannot
  // decode a Blob. Each produced a different error a long way from the cause.
  const r = await convert('sample.bmp', { ocrMode: 'offline' })
  assert.equal(r.ok, true, r.ok ? '' : `${r.code}: ${r.error}`)
  assert.ok(r.markdown.length > 100, 'suspiciously little text from the image')
  assert.equal(r.meta?.engine, 'tesseract')
})

test('cloud OCR refuses clearly rather than failing obscurely', async () => {
  const r = await convert('sample.bmp', { ocrMode: 'cloud' })
  assert.equal(r.ok, false)
  assert.equal(r.code, 'NO_CLOUD_OCR')
  assert.match(r.error, /key/i)
})

test('audio without a key explains itself', async () => {
  const r = await convert('sample.wav')
  assert.equal(r.ok, false)
  assert.equal(r.code, 'NO_TRANSCRIBER')
})

test('an unsupported extension names what is supported', async () => {
  const r = await convertToMarkdown(new Uint8Array([1, 2, 3]), 'thing.xyz')
  assert.equal(r.ok, false)
  assert.equal(r.code, 'UNSUPPORTED')
  assert.match(r.error, /pdf/)
})

test('the advertised format list is not empty and includes the obvious ones', () => {
  for (const ext of ['pdf', 'docx', 'xlsx', 'pptx', 'epub', 'odt', 'csv']) {
    assert.ok(ALL_FORMATS.includes(ext), `${ext} missing from ALL_FORMATS`)
  }
})
