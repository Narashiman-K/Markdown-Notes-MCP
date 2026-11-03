# Architecture — Suprasūtā Markdown Notes (MCP server)

An MCP server that lets Claude Desktop, and any other MCP host, read documents
on the user's machine as clean Markdown. It is also the npm package the VS Code
extension imports, and it holds the **canonical copy of the converters** for the
whole project family.

This document is for someone who has cloned the repository and wants to find
their way around without breaking an invariant they could not have guessed at.

---

## 1. At a glance

| | |
|---|---|
| Protocol | `@modelcontextprotocol/sdk`, stdio transport |
| Runtime | Node 20+ |
| Bundler | esbuild |
| Distribution | `.mcpb` bundle (`npm run pack:mcpb`) |
| Native modules | **none** used (pdf.js pulls in `@napi-rs/canvas` as an optional dependency; nothing here loads it) |
| WASM | one: the Tesseract OCR engine (English, Kannada, Hindi) |
| CI | `.github/workflows/ci.yml`: typecheck, build, tests, drift check, audit gate |

Two roles in one package, and it is worth being clear which you are touching:

1. **An MCP server** — `src/server.ts`, four tools over stdio.
2. **A library** — `src/index.ts` exports the converters for other Node
   consumers. Importing it installs the Node shims as a side effect, so a caller
   cannot forget to.

---

## 2. Layout

```
src/
  index.ts              library entry: installs Node runtime, re-exports
  server.ts             MCP server, four tools
  cloud.ts              the two conversions that cannot run locally
  runtime/node.ts       browser globals for Node
  lib/convert/          the canonical converters
    runtime.ts          the host seam — read this first
  shared/formats.ts     the format list, identical in all four repositories
scripts/
  build.mjs             esbuild
  stage-tesseract.mjs   stages the OCR engine and language model
  sync-converters.mjs   drift report across the family
  pack-mcpb.mjs         bundle for MCP hosts
  smoke.mjs             end-to-end check
```

---

## 3. The tools

| Tool | What it does |
|---|---|
| `convert_to_markdown` | One document on this machine → Markdown |
| `convert_folder_to_markdown` | Several at once, with a summary of what succeeded |
| `save_summary` | Write a summary the model produced as a `.md` beside the original |
| `list_supported_formats` | Extensions handled, and which optional capabilities are available |

`list_supported_formats` reports capability rather than just extensions,
because cloud OCR and audio transcription depend on keys that may not be
present. The server advertises the tools either way and returns a clear
instruction rather than a failure when a key is missing — a host that cannot
discover why something did not work will simply retry it.

---

## 4. The runtime seam — the important part

`src/lib/convert/runtime.ts` is the mechanism that lets **byte-identical files**
run in a browser, in Electron and under Node. Everything else in
`lib/convert/` is pure: bytes in, Markdown out. This module exists so the few
genuinely environment-specific values are supplied from outside rather than
sniffed for.

```ts
export interface ConvertRuntime {
  tesseractPaths(): { workerPath?, corePath?, langPath?, cachePath? }
  docxSource(bytes, arrayBuffer): Record<string, unknown>
  ocrImageInput(bytes, blob): unknown
}
```

Each of the three exists because a library behaves differently under Node:

- **`tesseractPaths`** — tesseract.js ships a Node-specific worker of its own,
  and pointing it at the browser worker makes it fail on web-worker globals
  that do not exist. Worker, WASM core and language data are returned
  separately because they are not always siblings and not always all needed.
- **`docxSource`** — mammoth reads an `arrayBuffer` in browsers but only `path`
  or `buffer` under Node; its package.json swaps the unzip implementation via
  the `browser` field. Asking the host rather than sniffing for `process` keeps
  the converter free of environment checks.
- **`ocrImageInput`** — the browser Tesseract build reads a `Blob`; the Node
  build reports "truncated file" and wants a `Buffer`.

**Defaults are the browser behaviour**, so browser callers configure nothing and
the app copies need no seam at all.

`src/runtime/node.ts` then supplies the browser globals the converters still
touch. The list is short and was established by grepping the converters rather
than guessed:

```
DOMParser          html.ts and office.ts, for XML and HTML parsing
Blob               ocr.ts — native in Node 20+, nothing to do
createImageBitmap  ocr.ts, only for TIFF and BMP
```

A plain static import of the converters is safe alongside it, because **no
converter touches a browser global at module scope** — every use is inside a
function. If you add one that does, this breaks in a way that is hard to trace.

---

## 5. Cloud conversions

`src/cloud.ts` holds the two conversions that cannot run locally: Gemini for
cloud OCR and AssemblyAI for audio transcription.

Both are **injected into the converters rather than imported by them**, which is
exactly why `src/lib/convert/` stays free of network code and stays identical
to the app copies. Keys are read from the environment — how every MCP host
supplies configuration — and are never written to disk and never logged. An
unsubstituted `${user_config.x}` placeholder counts as unset, because a host
can pass the literal template through when its settings field is empty.

---

## 6. This repository is the canonical copy

The converters exist in four copies across the project family by deliberate
choice. A shared npm package would remove drift by construction — and would
also tie four independent release cadences together, so a converter fix could
not reach the web app without a publish cycle, and the MSIX, the VSIX and the
PWA cache would all have to move at once.

The judgement was that independent release cadences are worth more than enforced
sameness, **provided drift is visible**. That proviso is what this repository
carries:

```
npm run sync:check                              compare every copy, list differences
npm run sync:pull                               pull a named project's version in
node scripts/sync-converters.mjs --push <name>  push this one out
```

It reports; it does not enforce. **This copy is canonical, decided
2026-09-15** — it is the only one with the runtime hook, so improvements start
here and flow outward.

| Repository | What it is |
|---|---|
| **Markdown-Notes-MCP** (this one) | MCP server, canonical converters |
| Markdown-Notes-windows | Electron desktop app, Microsoft Store |
| Markdown-Notes-web | Browser app, PWA |
| Markdown-Notes-VSCode | VS Code / Antigravity extension |

`src/shared/formats.ts` is byte-identical in all four.

The Android build was dropped from the family in September 2026 — Google Play
requires fourteen testers over fourteen days before a personal developer account
may publish. The repository and its code are intact; only the sync target was
removed, because a target nobody updates reports drift on every run until the
report is ignored entirely, which is worse than not checking at all.

---

## 7. Build, test, package

```
npm run build        esbuild → dist/          (stages Tesseract first)
npm run typecheck    tsc --noEmit
npm test             node:test — converters and server
npm run smoke        end-to-end
npm run pack:mcpb    bundle for MCP hosts
npm run sync:check   drift report
npm run audit:gate   dependency audit; fails on unaccepted high/critical
```

Spreadsheets are parsed in a worker thread (`sheet-worker.js`) that is
terminated at a time limit, so a crafted file cannot hang the server
(SheetJS 0.20.3, vendored as `vendor/xlsx-0.20.3.tgz` because 0.20.x is not
on the npm registry).

Under Node, pictures are not extracted from PDF, Word, PowerPoint or EPUB:
that needs a canvas, and `canExtractImages()` is false here, so those formats
convert as text. Scanned pages are still read with OCR, turned upright first.

**Audit allowlist** (`audit-allowlist.json`): two advisories are accepted,
both reached only through `@anthropic-ai/mcpb`, the developer tool that packs
the `.mcpb` bundle (a devDependency, never shipped): node-forge
(GHSA-86w9-cpqp-85rv, no patched release) and the zod 3 copy nested inside it
(GHSA-mrhx-c7xc-m3w5; the server itself uses patched zod 4). Both are to be
re-checked by 31 December 2026.

`scripts/stage-tesseract.mjs` runs before every build. Without it the OCR
engine and the ~3 MB English model would be fetched from a CDN on first use, so
"offline OCR" would fail in exactly the situation it exists for.

**No native modules.** No node-gyp, no prebuilds, no `.node` binaries — which
is what keeps the `.mcpb` bundle installable without a toolchain, and what
allows the same converters to run in a browser.

---

## 8. Conventions worth knowing

- **Keep `lib/convert/` pure.** No network calls, no `process` checks, no
  browser globals at module scope. Anything the host must answer goes through
  `ConvertRuntime`.
- **Changes here flow outward.** After changing a converter, run
  `sync:check` and push to the app copies, or the fix reaches one host only.
- **Never paste an access token into a chat, an issue, or a commit.**

---

## 9. Where this is going

Since the first release (on `main` from November 2026): SheetJS 0.20.3 in a
time-limited worker, page notes and scanned-PDF OCR, OCR languages, upright
pages, pictures in the app copies (`pdfImages.ts`), full EPUB with internal
links, dependency fixes, the audit gate and CI.

Carried: closing the remaining drift in `ocr.ts`, which currently has three
distinct variants across the family and is the reason the VS Code extension has
no OCR yet; more OCR languages on demand.
