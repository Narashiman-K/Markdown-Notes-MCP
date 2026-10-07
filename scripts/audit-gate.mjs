/**
 * Fails the build on any high or critical npm advisory that has not been
 * looked at and accepted.
 *
 * `npm audit --audit-level=high` alone cannot be used as a gate: some
 * advisories have no fix yet and cannot be reached from this project's code
 * (a build tool's download cache, say), and they would fail every build until
 * the gate was switched off and forgotten. Instead, each accepted advisory is
 * listed in audit-allowlist.json with the reason it is safe and a date by
 * which to look again. This script fails when:
 *   - a high or critical advisory is not on the list;
 *   - an entry's review date has passed, so it is looked at again rather than
 *     accepted for ever.
 * It reports, without failing, entries that npm no longer raises, so the list
 * can be pruned once a fix has landed.
 *
 * Kept identical in the Windows app, the web app and the MCP package; each
 * keeps its own audit-allowlist.json.
 *
 * Usage: node scripts/audit-gate.mjs
 */
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'

const GATED = new Set(['high', 'critical'])

/*
 * `--audit=true` because these projects' .npmrc sets audit=false (to keep
 * every `npm install` quiet), and under `npm run` that setting reaches this
 * child npm too: it then reports nothing at all, and the gate would pass on
 * an empty report. Run through the same npm that launched the script when
 * there is one, so no shell is involved.
 */
const args = ['audit', '--json', '--audit=true']
// The npm that runs this script passes its own settings down as npm_config_*
// variables, and newer npm refuses some of them in a child (allow-scripts:
// EALLOWSCRIPTS). The child reads the project's .npmrc itself instead.
const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^npm_config_/i.test(k)))
let report
try {
  report = process.env.npm_execpath
    ? execFileSync(process.execPath, [process.env.npm_execpath, ...args], { encoding: 'utf8', env, stdio: ['ignore', 'pipe', 'ignore'] })
    : execFileSync('npm', args, { encoding: 'utf8', env, shell: true, stdio: ['ignore', 'pipe', 'ignore'] })
} catch (err) {
  // npm audit exits non-zero whenever it finds anything; the JSON is still
  // on stdout.
  report = err.stdout
}
const audit = JSON.parse(report || '{}')
// An audit that did not run must not pass: no counts means no audit.
if (!audit.metadata?.vulnerabilities || !audit.metadata?.dependencies) {
  console.error('audit gate: npm audit returned no results (offline, or auditing disabled). Failing rather than passing blind.')
  console.error(String(report).slice(0, 400))
  process.exit(1)
}

const allowlist = existsSync('audit-allowlist.json') ? JSON.parse(readFileSync('audit-allowlist.json', 'utf8')) : []
const accepted = new Map(allowlist.map((e) => [e.id, e]))
const today = new Date().toISOString().slice(0, 10)

// The advisories themselves, not every package that depends on one.
const advisories = new Map()
for (const v of Object.values(audit.vulnerabilities ?? {})) {
  for (const via of v.via) {
    if (typeof via !== 'object') continue
    const id = via.url.split('/').pop()
    advisories.set(id, { id, name: via.name, severity: via.severity, title: via.title, url: via.url })
  }
}

const problems = []
for (const a of advisories.values()) {
  if (!GATED.has(a.severity)) continue
  const entry = accepted.get(a.id)
  if (!entry) problems.push(`NEW ${a.severity}: ${a.name} - ${a.title} (${a.url})`)
  else if (entry.reviewBy < today) problems.push(`REVIEW DUE (${entry.reviewBy}): ${a.name} ${a.id} - ${entry.reason}`)
  else console.log(`accepted until ${entry.reviewBy}: ${a.name} ${a.id} - ${entry.reason}`)
}
for (const entry of allowlist) {
  if (!advisories.has(entry.id)) console.log(`no longer reported, can be removed from the list: ${entry.package} ${entry.id}`)
}

const counts = audit.metadata?.vulnerabilities ?? {}
console.log(`npm audit: ${JSON.stringify(counts)}; ${advisories.size} distinct advisories`)
if (problems.length) {
  console.error(`\n${problems.length} unaccepted:`)
  for (const p of problems) console.error(`  ${p}`)
  process.exit(1)
}
console.log('audit gate: passed')
