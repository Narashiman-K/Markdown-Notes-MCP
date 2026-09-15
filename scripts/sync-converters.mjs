/**
 * Keeps the copies of the converters honest.
 *
 * The same converter code lives in four places by deliberate choice — the
 * Windows app, the web app, the Android app and this package — because
 * isolation was judged more valuable than a shared dependency. The cost of
 * that choice is drift: a fix made in one copy silently fails to reach the
 * others, and nobody notices until two versions of the app behave differently.
 *
 * This script makes drift visible instead of silent. It does not enforce
 * anything; it reports.
 *
 *   npm run sync:check     compare every copy against this one, list differences
 *   npm run sync:pull      copy a named project's version INTO this one
 *   node scripts/sync-converters.mjs --push <name>   push this one OUT to a project
 *
 * This package is the canonical copy, decided 2026-09-15: it is the only one
 * with the runtime hook that lets identical files run in a browser and in Node,
 * so improvements start here and flow outward.
 */
import { createHash } from 'node:crypto'
import { copyFile, readFile, readdir } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const mine = join(root, 'src', 'lib', 'convert')
const builds = resolve(root, '..')

/**
 * Where each project keeps its copy. Relative to the Build Projects folder, so
 * the script works regardless of where that folder lives.
 */
const PROJECTS = {
  windows: join(builds, 'MarkNote', 'src', 'renderer', 'src', 'lib', 'convert'),
  web: join(builds, 'MarkNote-Web', 'src', 'lib', 'convert'),
  android: join(builds, 'MarkNote-Android', 'src', 'lib', 'convert')
}

/**
 * Files that are expected to differ, with the reason.
 *
 * `runtime.ts` is the hook this package introduced. Until it has been synced
 * outward it will be absent from the apps, and that is not drift — it is work
 * not yet done. Listing it here stops a known gap drowning out real surprises.
 */
const EXPECTED_DIFFERENCES = {
  'runtime.ts': 'introduced here; sync outward when the apps next change'
}

const hash = async (p) => createHash('sha256').update(await readFile(p)).digest('hex').slice(0, 12)

async function listTs(dir) {
  if (!existsSync(dir)) return null
  return (await readdir(dir)).filter((f) => f.endsWith('.ts')).sort()
}

async function compare(name, dir) {
  const theirs = await listTs(dir)
  if (!theirs) {
    console.log(`\n${name.padEnd(8)} not found at ${dir}`)
    return { name, missing: true, differences: [] }
  }

  const ours = await listTs(mine)
  const differences = []

  for (const file of new Set([...ours, ...theirs])) {
    const a = join(mine, file)
    const b = join(dir, file)
    const inOurs = existsSync(a)
    const inTheirs = existsSync(b)

    if (!inTheirs) differences.push({ file, state: 'only here', note: EXPECTED_DIFFERENCES[file] })
    else if (!inOurs) differences.push({ file, state: `only in ${name}` })
    else if ((await hash(a)) !== (await hash(b))) differences.push({ file, state: 'differs' })
  }

  const unexpected = differences.filter((d) => !d.note)
  console.log(`\n${name.padEnd(8)} ${differences.length ? `${differences.length} difference(s)` : 'identical'}`)
  for (const d of differences) {
    console.log(`  ${d.state.padEnd(16)} ${d.file}${d.note ? `  — ${d.note}` : ''}`)
  }
  return { name, differences, unexpected }
}

const mode = process.argv.includes('--pull')
  ? 'pull'
  : process.argv.includes('--push')
    ? 'push'
    : 'check'

if (mode === 'check') {
  const results = []
  for (const [name, dir] of Object.entries(PROJECTS)) results.push(await compare(name, dir))

  const total = results.reduce((n, r) => n + (r.unexpected?.length ?? 0), 0)
  console.log(
    total
      ? `\n${total} unexpected difference(s). Review them, then --pull or --push to reconcile.`
      : '\nNo unexpected drift.'
  )
  // Deliberately exits 0 even when copies differ. Drift is information, not a
  // build failure — blocking CI on it would only teach everyone to skip it.
  process.exit(0)
}

const target = process.argv[process.argv.indexOf(mode === 'pull' ? '--pull' : '--push') + 1]
const dir = PROJECTS[target]

if (!dir) {
  console.error(`\nUnknown project "${target ?? ''}". Choose one of: ${Object.keys(PROJECTS).join(', ')}\n`)
  process.exit(1)
}

const [from, to] = mode === 'pull' ? [dir, mine] : [mine, dir]
let n = 0
for (const file of await listTs(from)) {
  await copyFile(join(from, file), join(to, file))
  n++
}
console.log(`\ncopied ${n} file(s)\n  from ${from}\n  to   ${to}\n\nRun npm run typecheck before trusting it.`)
