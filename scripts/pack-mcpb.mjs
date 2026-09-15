/**
 * Builds the `.mcpb` bundle for one-click install in Claude Desktop.
 *
 * Unlike the npm package, an .mcpb has to be self-contained: Claude Desktop
 * unzips it and runs it, with no `npm install` step. That means the runtime
 * dependencies travel inside it, which is why this is tens of megabytes while
 * the npm tarball is four.
 *
 * Everything is assembled in a staging directory rather than packed from the
 * working tree, so the bundle cannot accidentally pick up sources, tests,
 * samples or dev dependencies.
 */
import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { execFileSync } from 'node:child_process'
import { dirname, join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const stage = join(root, 'build', 'mcpb')

console.log('staging in', stage)
await rm(stage, { recursive: true, force: true })
await mkdir(stage, { recursive: true })

for (const item of ['manifest.json', 'icon.png', 'LICENSE.md', 'README.md', 'dist', 'vendor']) {
  await cp(join(root, item), join(stage, item), { recursive: true })
}

/*
 * A trimmed package.json. The staged copy exists only so `npm install` knows
 * what to fetch; scripts and devDependencies would either fail or pull in the
 * build toolchain, neither of which belongs in a shipped bundle.
 */
const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))
await writeFile(
  join(stage, 'package.json'),
  JSON.stringify(
    {
      name: pkg.name,
      version: pkg.version,
      description: pkg.description,
      license: pkg.license,
      type: pkg.type,
      main: pkg.main,
      dependencies: pkg.dependencies
    },
    null,
    2
  ) + '\n'
)

/*
 * The staging directory sits inside the project, so npm would otherwise read
 * the project's .npmrc — which sets `include=dev` to work around NODE_ENV being
 * production on this machine — and pull the entire build toolchain into the
 * bundle. A local .npmrc overrides it.
 *
 * `--ignore-scripts` is deliberately absent: npm 11 rejects it in a
 * project-scoped install, and it already declines to run lifecycle scripts
 * unless they are approved.
 */
await writeFile(join(stage, '.npmrc'), 'omit=dev\ninclude=prod\n')

/*
 * The install is also isolated from the user's own npm config.
 *
 * A machine-level `.npmrc` here carries `allow-scripts=...`, which npm 11
 * rejects outright during a project-scoped install, and nothing about one
 * developer's global settings should decide what ends up in a published
 * bundle. Pointing `userconfig` at an empty file removes the whole class of
 * problem rather than patching this one instance of it.
 */
// Written to the temp directory, not the staging folder: this project's own
// path contains spaces, and with `shell: true` on Windows an unquoted argument
// splits at them, so npm saw a truncated path and fell back to the user config
// it was supposed to be ignoring.
const emptyConfig = join(tmpdir(), 'suprasuta-mcpb-empty.npmrc')
await writeFile(emptyConfig, '')

console.log('installing runtime dependencies…')
// Passed as a flag rather than the npm_config_userconfig environment
// variable, which npm ignores here.
execFileSync('npm', ['install', '--omit=dev', '--no-audit', '--no-fund', '--userconfig', emptyConfig], {
  cwd: stage,
  stdio: 'inherit',
  shell: process.platform === 'win32',
  /*
   * npm config is stripped from the child's environment.
   *
   * `npm run` exports every npm setting as an npm_config_* variable, so the
   * child npm inherited the user's `allow-scripts` entry no matter which
   * config file it was pointed at — and npm 11 rejects that setting outright
   * in a project-scoped install. Removing the whole npm_config_ namespace is
   * what actually isolates this install; --userconfig alone was not enough.
   */
  env: {
    ...Object.fromEntries(
      Object.entries(process.env).filter(([k]) => !k.toLowerCase().startsWith('npm_config_'))
    ),
    NODE_ENV: 'production'
  }
})

// The lockfile is an artefact of that install and serves no purpose inside the
// bundle, where nothing will ever be installed again.
await rm(join(stage, 'package-lock.json'), { force: true })
await rm(join(stage, '.npmrc'), { force: true })
await rm(emptyConfig, { force: true })

console.log('packing…')
execFileSync(
  'node',
  [join(root, 'node_modules', '@anthropic-ai', 'mcpb', 'dist', 'cli', 'cli.js'), 'pack', stage, join(root, 'build', `${pkg.name}-${pkg.version}.mcpb`)],
  { stdio: 'inherit' }
)
