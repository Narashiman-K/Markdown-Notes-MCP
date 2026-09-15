/**
 * Registers this server with Claude Desktop by patching its config file.
 *
 * Claude Desktop stores every MCP server in one JSON file alongside unrelated
 * application preferences, so this reads, adds one key, and writes back —
 * rather than generating a file, which would discard whatever else is there.
 * A timestamped backup is written first.
 *
 *   node scripts/install-claude-desktop.mjs
 *   node scripts/install-claude-desktop.mjs --roots "D:\\Work;E:\\Docs"
 *   node scripts/install-claude-desktop.mjs --remove
 */
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { homedir, platform } from 'node:os'
import { fileURLToPath } from 'node:url'

const KEY = 'suprasuta-markdown'
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')

function configPath() {
  if (process.env.CLAUDE_DESKTOP_CONFIG) return process.env.CLAUDE_DESKTOP_CONFIG
  if (platform() === 'win32') {
    const appData = process.env.APPDATA ?? join(homedir(), 'AppData', 'Roaming')
    return join(appData, 'Claude', 'claude_desktop_config.json')
  }
  if (platform() === 'darwin') {
    return join(homedir(), 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json')
  }
  return join(homedir(), '.config', 'Claude', 'claude_desktop_config.json')
}

function flag(name) {
  const i = process.argv.indexOf(`--${name}`)
  return i === -1 ? undefined : (process.argv[i + 1] ?? true)
}

const cfgPath = configPath()
const serverEntry = join(root, 'dist', 'server.js')

if (!existsSync(serverEntry)) {
  console.error(`\nNot built yet — ${serverEntry} is missing.\nRun: npm install && npm run build\n`)
  process.exit(1)
}

let config = {}
if (existsSync(cfgPath)) {
  const raw = await readFile(cfgPath, 'utf8')
  try {
    config = JSON.parse(raw)
  } catch (err) {
    console.error(`\n${cfgPath} is not valid JSON, so it has been left alone.\n${err.message}\n`)
    process.exit(1)
  }
  const backup = `${cfgPath}.backup-${new Date().toISOString().replace(/[:.]/g, '-')}`
  await copyFile(cfgPath, backup)
  console.log(`backed up  → ${backup}`)
} else {
  await mkdir(dirname(cfgPath), { recursive: true })
}

config.mcpServers ??= {}

if (flag('remove')) {
  delete config.mcpServers[KEY]
  await writeFile(cfgPath, JSON.stringify(config, null, 2) + '\n', 'utf8')
  console.log(`removed    ${KEY}\nRestart Claude Desktop for it to take effect.`)
  process.exit(0)
}

/*
 * Only the keys that are actually set are written. An empty string for an API
 * key is worse than an absent one: the server checks for presence to decide
 * whether to offer cloud OCR, and "" would look configured while failing.
 */
const env = {}
const roots = flag('roots') ?? process.env.MARKDOWN_MCP_ROOTS
if (typeof roots === 'string') env.MARKDOWN_MCP_ROOTS = roots
if (process.env.GEMINI_API_KEY) env.GEMINI_API_KEY = process.env.GEMINI_API_KEY
if (process.env.ASSEMBLYAI_API_KEY) env.ASSEMBLYAI_API_KEY = process.env.ASSEMBLYAI_API_KEY

config.mcpServers[KEY] = {
  command: process.execPath,
  args: [serverEntry],
  ...(Object.keys(env).length ? { env } : {})
}

await writeFile(cfgPath, JSON.stringify(config, null, 2) + '\n', 'utf8')

console.log(`installed  ${KEY}`)
console.log(`config     ${cfgPath}`)
console.log(`node       ${process.execPath}`)
console.log(`server     ${serverEntry}`)
if (env.MARKDOWN_MCP_ROOTS) console.log(`roots      ${env.MARKDOWN_MCP_ROOTS}`)
else console.log('roots      (unrestricted — pass --roots to limit which folders it may read)')
console.log('\nRestart Claude Desktop completely for it to load.')
