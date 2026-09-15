/**
 * Copies the Tesseract engine and English model into `vendor/tesseract`.
 *
 * Offline OCR is only honestly offline if the engine ships with the package.
 * Left to itself tesseract.js downloads its worker, WASM core and a ~3 MB
 * language model from a CDN on first use — which, in an MCP server a user
 * installed precisely so that nothing leaves their machine, would be a quiet
 * contradiction of the promise.
 *
 * `vendor/` is gitignored and rebuilt from node_modules on every build, so it
 * cannot drift from the installed version.
 */
import { copyFile, mkdir, stat } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const outDir = join(root, 'vendor', 'tesseract')

const packageDir = (name) => dirname(require.resolve(`${name}/package.json`))

/*
 * Only the SIMD LSTM core, at roughly 4 MB.
 *
 * Node has supported WebAssembly SIMD since v16 and this package requires v20,
 * so the non-SIMD core would double the download for a configuration that
 * cannot occur. If tesseract ever fails to load it, ocr.ts falls back to the
 * library's CDN default rather than breaking.
 */
const CORES = ['tesseract-core-simd-lstm.wasm.js']

const copied = []

async function take(from, name) {
  if (!existsSync(from)) throw new Error(`missing ${name} at ${from}`)
  await copyFile(from, join(outDir, name))
  copied.push(name)
}

await mkdir(outDir, { recursive: true })

/*
 * The browser worker is deliberately NOT staged. tesseract.js bundles a
 * separate Node worker and uses it automatically; handing it the browser one
 * fails on web-worker globals. Only the engine and language data are needed.
 */

const coreDir = packageDir('tesseract.js-core')
for (const c of CORES) await take(join(coreDir, c), c)

await take(
  join(packageDir('@tesseract.js-data/eng'), '4.0.0_best_int', 'eng.traineddata.gz'),
  'eng.traineddata.gz'
)

let total = 0
for (const n of copied) total += (await stat(join(outDir, n))).size
console.log(`tesseract: staged ${copied.length} files, ${(total / 1048576).toFixed(1)} MB → vendor/tesseract`)
