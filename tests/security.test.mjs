/**
 * Hostile-input tests for the converters.
 *
 * Every document this package reads comes from somewhere the user does not
 * control — an email attachment, a download, a shared drive — so the parsers
 * are the attack surface. These run against the built bundle, like the other
 * tests here, because that is what an MCP host actually executes.
 *
 * What they pin:
 *   - the spreadsheet library is the patched one (CVE-2023-30533 prototype
 *     pollution, and the 2024 ReDoS, are both fixed from 0.20.2), so a future
 *     `npm install xlsx` that silently pulls 0.18.5 from the npm registry fails
 *     here rather than shipping;
 *   - a workbook built to pollute Object.prototype leaves it untouched;
 *   - corrupt or misnamed files fail cleanly and quickly instead of throwing
 *     or hanging.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { readFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const require = createRequire(join(root, 'package.json'))
const XLSX = require('xlsx')
const { convertToMarkdown } = await import(pathToFileURL(join(root, 'dist', 'index.js')).href)

/** Fails the test if `work` has not settled within `ms`. */
async function within(ms, work) {
  let timer
  const limit = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`did not finish within ${ms} ms`)), ms)
  })
  try {
    return await Promise.race([work, limit])
  } finally {
    clearTimeout(timer)
  }
}

function newerOrEqual(version, floor) {
  const a = version.split('.').map(Number)
  const b = floor.split('.').map(Number)
  for (let i = 0; i < 3; i++) if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) > (b[i] ?? 0)
  return true
}

test('the spreadsheet library is a patched release, and is the one in the bundle', async () => {
  // Checked twice on purpose. SheetJS is bundled into dist (see
  // scripts/build.mjs), so the bundle is what users run — but the installed
  // copy is what the bundle is built from.
  const advice =
    '0.18.5 is the last version on the npm registry and is vulnerable; install from vendor/ ' +
    '(see the devDependency in package.json), never `npm install xlsx`.'
  assert.ok(newerOrEqual(XLSX.version, '0.20.2'), `installed xlsx is ${XLSX.version}. ${advice}`)

  for (const file of ['index.js', 'server.js']) {
    const body = await readFile(join(root, 'dist', file), 'utf8')
    assert.doesNotMatch(body, /from\s*["']xlsx["']|require\(["']xlsx["']\)/, `${file} imports xlsx instead of bundling it`)
    const bundled = /\bversion\s*=\s*"(0\.\d+\.\d+)"/.exec(body)?.[1]
    assert.ok(bundled, `no SheetJS version string found in ${file}`)
    assert.ok(newerOrEqual(bundled, '0.20.2'), `${file} bundles xlsx ${bundled}. ${advice}`)
  }

  const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))
  assert.equal(manifest.dependencies?.xlsx, undefined, 'xlsx must not be a runtime dependency: a published package cannot resolve a file: path')
})

test('a workbook built to pollute Object.prototype leaves it untouched', async () => {
  const book = XLSX.utils.book_new()
  const sheet = XLSX.utils.aoa_to_sheet([
    ['__proto__', 'constructor', 'prototype', 'polluted'],
    ['{"polluted":true}', 'x', 'y', 'z']
  ])
  XLSX.utils.book_append_sheet(book, sheet, '__proto__')
  const bytes = new Uint8Array(XLSX.write(book, { type: 'buffer', bookType: 'xlsx' }))

  const before = Object.getOwnPropertyNames(Object.prototype).sort()
  const r = await within(5000, convertToMarkdown(bytes, 'hostile.xlsx'))

  assert.equal(r.ok, true, r.ok ? '' : `${r.code}: ${r.error}`)
  assert.equal(({}).polluted, undefined, 'Object.prototype gained a "polluted" property')
  assert.deepEqual(Object.getOwnPropertyNames(Object.prototype).sort(), before)
  // The hostile names are still shown to the user as text — they are data,
  // and hiding them would hide what the file actually contains.
  assert.match(r.markdown, /__proto__/)
})

/*
 * A caveat that applies to everything below: `within` can only time out work
 * that yields. A parser stuck in a synchronous loop never gives the timer a
 * chance to fire, so the failure mode of a regression here is this file
 * hanging rather than failing. That is how the truncated-spreadsheet hang was
 * found in the first place.
 */
const realWorkbook = new Uint8Array(await readFile(join(root, 'samples', 'sample.xlsx')))

function endRecord(bytes) {
  for (let i = bytes.length - 22; i >= 0; i--) {
    if (bytes[i] === 0x50 && bytes[i + 1] === 0x4b && bytes[i + 2] === 5 && bytes[i + 3] === 6) return bytes.slice(i)
  }
  throw new Error('sample.xlsx has no end-of-central-directory record')
}

test('a spreadsheet cut off part-way fails at once instead of hanging', async (t) => {
  // These lengths are prefixes that made XLSX.read spin forever in both
  // 0.18.5 and 0.20.3. The guard in office.ts refuses them before parsing.
  for (const length of [10, 16, 30, 45, 120, realWorkbook.length >> 1]) {
    await t.test(`${length} bytes`, async () => {
      const r = await within(5000, convertToMarkdown(realWorkbook.slice(0, length), 'cut-off.xlsx'))
      assert.equal(r.ok, false)
      assert.match(r.error, /incomplete|cut off|Could not read/i)
    })
  }
})

test(
  'a fragment carrying a genuine end record does not hang the host',
  {
    skip:
      'KNOWN GAP — hangs today. SheetJS loops forever on e.g. a 10-byte prefix of a real ' +
      'workbook followed by its genuine end-of-central-directory record, and the truncation ' +
      'guard cannot see it because the record is present. Interrupting a synchronous loop ' +
      'needs the parse moved into a worker with a time limit. Remove this skip when that lands.'
  },
  async () => {
    const tail = endRecord(realWorkbook)
    const crafted = new Uint8Array(10 + tail.length)
    crafted.set(realWorkbook.slice(0, 10))
    crafted.set(tail, 10)
    const r = await within(5000, convertToMarkdown(crafted, 'crafted.xlsx'))
    assert.equal(r.ok, false)
  }
)

test('corrupt and misnamed files fail cleanly and quickly', async (t) => {
  const garbage = new Uint8Array(64 * 1024).map((_, i) => (i * 2654435761) >>> 24)
  const cases = [
    ['random bytes as .xlsx', garbage, 'junk.xlsx'],
    ['random bytes as .docx', garbage, 'junk.docx'],
    ['random bytes as .pptx', garbage, 'junk.pptx'],
    ['random bytes as .pdf', garbage, 'junk.pdf'],
    ['empty .xlsx', new Uint8Array(0), 'empty.xlsx']
  ]
  for (const [label, bytes, name] of cases) {
    await t.test(label, async () => {
      // Resolving with ok:false is the contract; throwing would crash a host
      // that does not wrap every call, and hanging would freeze it.
      const r = await within(10000, convertToMarkdown(bytes, name))
      assert.equal(typeof r.ok, 'boolean')
      if (r.ok) assert.equal(typeof r.markdown, 'string')
      else assert.ok(r.error, 'failed without saying why')
    })
  }
})
