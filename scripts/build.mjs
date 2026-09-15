/**
 * Bundles the server.
 *
 * esbuild rather than `tsc` for two reasons. It resolves the extensionless
 * relative imports the app copies use, so `src/lib/convert/` can stay
 * byte-identical to the Windows and web versions instead of being rewritten
 * with `.js` suffixes for Node's resolver. And it lets the `?url` import below
 * be handled here rather than by editing a shared file.
 */
import { build } from 'esbuild'
import { createRequire } from 'node:module'
import { chmod, readFile, writeFile } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'

const require = createRequire(import.meta.url)

/**
 * Vite lets a module be imported for its URL with a `?url` suffix. Node has no
 * such concept, and `pdf.ts` uses it to locate the pdf.js worker.
 *
 * It resolves to the worker's absolute path here. In practice pdf.js detects
 * Node and runs on the main thread regardless of what `workerSrc` is set to, so
 * this value is never actually fetched — but an honest path is better than a
 * placeholder that would mislead anyone debugging it.
 */
const urlImports = {
  name: 'url-imports',
  setup(b) {
    b.onResolve({ filter: /\?url$/ }, (args) => ({
      path: args.path.replace(/\?url$/, ''),
      namespace: 'url-import'
    }))
    b.onLoad({ filter: /.*/, namespace: 'url-import' }, (args) => {
      let resolved
      try {
        resolved = require.resolve(args.path)
      } catch {
        resolved = args.path
      }
      // A bare Windows path such as D:\\... is not a URL, and Node's ESM
      // loader rejects it with "protocol 'd:'". pdf.js import()s this value.
      const href = pathToFileURL(resolved).href
      return { contents: `export default ${JSON.stringify(href)}`, loader: 'js' }
    })
  }
}

await build({
  entryPoints: ['src/server.ts', 'src/index.ts'],
  outdir: 'dist',
  bundle: true,
  platform: 'node',
  target: 'node20',
  format: 'esm',
  // Dependencies stay in node_modules: jsdom, pdf.js and tesseract.js all load
  // files relative to their own package at runtime, which bundling breaks.
  packages: 'external',
  /*
   * pdf.js prints "Please use the legacy build in Node.js environments" and
   * then trips over modern syntax its main build assumes. Rewriting the
   * specifier here keeps pdf.ts identical to the app copies, which import the
   * plain package name as a browser build should.
   */
  alias: { 'pdfjs-dist': 'pdfjs-dist/legacy/build/pdf.mjs' },
  /*
   * The plugin must be listed even though `packages: 'external'` is set.
   * Without it the `?url` specifier is treated as an ordinary package import,
   * left in the output untouched, and the bundle then fails at runtime rather
   * than at build time — plugin resolution runs before the external check,
   * which is exactly why this works.
   */
  plugins: [urlImports],
  logLevel: 'info'
})

// Only the server is executable, so the shebang goes on afterwards rather than
// via esbuild's banner, which would apply it to both entry points.
const serverFile = 'dist/server.js'
const body = await readFile(serverFile, 'utf8')
if (!body.startsWith('#!')) {
  await writeFile(serverFile, `#!/usr/bin/env node\n${body}`, 'utf8')
}
await chmod(serverFile, 0o755).catch(() => {})
