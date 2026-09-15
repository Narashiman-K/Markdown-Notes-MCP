/**
 * Sets the version in every file that carries one.
 *
 *   node scripts/version.mjs 0.1.3
 *
 * The version appears in four places — package.json, manifest.json, server.json
 * (twice) and the server's own VERSION constant — and they must agree. The MCP
 * registry in particular compares server.json against the published npm
 * package, so a missed file is a rejected submission. Updating them by hand
 * three times running was enough.
 */
import { readFile, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const next = process.argv[2]

if (!next || !/^\d+\.\d+\.\d+$/.test(next)) {
  console.error('\nUsage: node scripts/version.mjs <major.minor.patch>\n')
  process.exit(1)
}

async function editJson(name, mutate) {
  const path = join(root, name)
  const data = JSON.parse(await readFile(path, 'utf8'))
  mutate(data)
  await writeFile(path, JSON.stringify(data, null, 2) + '\n', 'utf8')
  console.log(`  ${name}`)
}

console.log(`\nsetting version ${next} in:`)

await editJson('package.json', (d) => {
  d.version = next
})

await editJson('manifest.json', (d) => {
  d.version = next
})

await editJson('server.json', (d) => {
  d.version = next
  for (const pkg of d.packages ?? []) pkg.version = next
})

const serverPath = join(root, 'src', 'server.ts')
const source = await readFile(serverPath, 'utf8')
const updated = source.replace(/const VERSION = '[^']*'/, `const VERSION = '${next}'`)
if (updated === source) {
  console.error('\n  src/server.ts — VERSION constant not found; check it by hand\n')
  process.exit(1)
}
await writeFile(serverPath, updated, 'utf8')
console.log('  src/server.ts')

console.log('\nNow: npm test && npm run pack:mcpb && npm publish --access public\n')
