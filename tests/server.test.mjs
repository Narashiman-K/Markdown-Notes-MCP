/**
 * Drives the built server over stdio, exactly as an MCP host does.
 *
 * The converter tests cover conversion. These cover the things that only go
 * wrong once the server is the one deciding: what the output file is called,
 * and whether the folder restriction is honoured. Both were found by installing
 * the extension rather than by any test, which is why they have tests now.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { copyFile, mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const server = join(root, 'dist', 'server.js')

/** Sends a batch of JSON-RPC calls to a fresh server and returns the replies. */
function callServer(calls, env = {}) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, [server], {
      env: { ...process.env, MARKDOWN_MCP_ROOTS: '', GEMINI_API_KEY: '', ASSEMBLYAI_API_KEY: '', ...env },
      stdio: ['pipe', 'pipe', 'ignore']
    })

    let out = ''
    child.stdout.on('data', (d) => (out += d))
    child.on('error', reject)
    child.on('close', () => {
      const replies = out
        .split('\n')
        .filter((l) => l.trim().startsWith('{'))
        .map((l) => JSON.parse(l))
      resolvePromise(replies)
    })

    const init = {
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 't', version: '1' } }
    }
    child.stdin.write([init, ...calls].map((c) => JSON.stringify(c)).join('\n') + '\n')
    child.stdin.end()
  })
}

const convert = (id, args) => ({
  jsonrpc: '2.0',
  id,
  method: 'tools/call',
  params: { name: 'convert_to_markdown', arguments: args }
})

test('output keeps the original extension, so same-named sources do not collide', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'suprasuta-names-'))
  t.after(() => rm(dir, { recursive: true, force: true }))

  for (const name of ['sample.docx', 'sample.pdf', 'sample.epub']) {
    await copyFile(join(root, 'samples', name), join(dir, name))
  }

  await callServer([
    convert(2, { path: join(dir, 'sample.docx'), return_content: 'none' }),
    convert(3, { path: join(dir, 'sample.pdf'), return_content: 'none' }),
    convert(4, { path: join(dir, 'sample.epub'), return_content: 'none' })
  ])

  const produced = (await readdir(dir)).filter((f) => f.endsWith('.md')).sort()

  assert.deepEqual(produced, ['sample.docx.md', 'sample.epub.md', 'sample.pdf.md'])
  // The old behaviour would have given sample.md, sample-2.md and sample-3.md,
  // with nothing to say which document each came from.
  assert.ok(!produced.some((f) => /-\d+\.md$/.test(f)), 'a numbered fallback means names collided')
})

test('the folder restriction is enforced, and ignores an unsubstituted placeholder', async () => {
  const allowed = join(root, 'samples')

  const [refused] = (
    await callServer([convert(2, { path: 'C:\\Windows\\win.ini', save: false })], {
      MARKDOWN_MCP_ROOTS: allowed
    })
  ).filter((r) => r.id === 2)
  assert.equal(refused.result.isError, true)
  assert.match(refused.result.content[0].text, /outside the configured roots/)

  // A host that leaves the template unsubstituted must not produce a root that
  // matches nothing and silently refuses every file.
  const [allowedReply] = (
    await callServer([convert(2, { path: join(allowed, 'sample.docx'), save: false })], {
      MARKDOWN_MCP_ROOTS: '${user_config.allowed_folders}'
    })
  ).filter((r) => r.id === 2)
  assert.notEqual(allowedReply.result.isError, true)
})

test('an unsubstituted key placeholder reports as not configured', async () => {
  const [reply] = (
    await callServer(
      [{ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'list_supported_formats', arguments: {} } }],
      { GEMINI_API_KEY: '${user_config.gemini_api_key}', ASSEMBLYAI_API_KEY: '${user_config.assemblyai_api_key}' }
    )
  ).filter((r) => r.id === 2)

  assert.match(reply.result.content[0].text, /Cloud OCR \(Gemini\): not configured/)
  assert.match(reply.result.content[0].text, /AssemblyAI\): not configured/)
})

test('every tool declares a title and the hints the directory requires', async () => {
  // A Connectors Directory submission is rejected if any tool lacks a title or
  // the applicable readOnlyHint/destructiveHint, and the portal groups
  // unannotated tools separately for a reviewer to query.
  const [reply] = (
    await callServer([{ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }])
  ).filter((r) => r.id === 2)

  for (const tool of reply.result.tools) {
    const a = tool.annotations
    assert.ok(a, `${tool.name} has no annotations`)
    assert.ok(a.title, `${tool.name} has no title`)
    assert.equal(typeof a.readOnlyHint, 'boolean', `${tool.name} has no readOnlyHint`)
    if (a.readOnlyHint === false) {
      assert.equal(typeof a.destructiveHint, 'boolean', `${tool.name} writes but has no destructiveHint`)
    }
  }
})
