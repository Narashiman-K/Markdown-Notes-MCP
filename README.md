<div align="center">

# Suprasūtā Markdown Notes — MCP server

**Let Claude, VS Code and Antigravity read any document on your machine — without uploading it.**

Created by **[Narashiman Krishnamurthy](https://www.linkedin.com/in/narashimank/)**

</div>

---

> **Licence:** free for personal, non-commercial use. See [LICENSE.md](LICENSE.md).

## What it does

AI assistants can read plain text, and some can read PDFs. None of them read
EPUB, OpenDocument, PowerPoint or a scanned image, and all of them do it by
uploading your file to a server.

This converts documents **on your own machine** and hands back Markdown that has
been tidied for a model to read — tables promoted to real Markdown tables, deep
indentation flattened, code properly fenced.

| | |
| --- | --- |
| **Documents** | PDF, Word `.docx`, Excel `.xlsx/.xls/.xlsm`, PowerPoint `.pptx`, OpenDocument `.odt/.ods`, EPUB, CSV, TSV, plain text |
| **Images** | OCR on the device, with no key and no network |
| **Audio** | Transcription — the one feature that cannot run locally |

## Tools

| Tool | What it does |
| --- | --- |
| `convert_to_markdown` | Converts one file and **saves the `.md` beside the original automatically** |
| `convert_folder_to_markdown` | Converts several files into a chosen directory |
| `save_summary` | Saves a summary the assistant wrote as `<name>.summary.md` beside the document |
| `list_supported_formats` | Lists the extensions, and which optional cloud features are configured |

### About tokens

Converting costs you nothing — it all happens locally. But **returning a long
document into the conversation does** cost tokens, at the same rate as pasting
it in by hand.

So a long conversion is saved to disk and only a short preview comes back. A
50-page PDF costs roughly 400 tokens instead of 30,000. Short documents are
returned in full, since they are cheap either way. Ask for
`return_content: "full"` to override.

## Installing

### Claude Desktop

```bash
npm install
npm run build
node scripts/install-claude-desktop.mjs --roots "D:\your\documents"
```

Then restart Claude Desktop completely. The script patches the existing config
rather than replacing it, and writes a timestamped backup first.

`--roots` is optional but recommended: it limits which folders the server will
read. Without it, any path the assistant asks for is allowed.

To remove it again: `node scripts/install-claude-desktop.mjs --remove`

### VS Code and Antigravity

Both read a standard MCP configuration. Point them at `dist/server.js`:

```json
{
  "servers": {
    "suprasuta-markdown": {
      "command": "node",
      "args": ["<absolute path>/dist/server.js"],
      "env": { "MARKDOWN_MCP_ROOTS": "D:\\your\\documents" }
    }
  }
}
```

Antigravity looks in `~/.gemini/config/mcp_config.json`, or `.agents/mcp_config.json`
inside a workspace. Note that it requires `serverUrl` rather than `url` for
remote servers; this one is local, so `command` and `args` apply.

## Optional cloud features

Both are dormant until a key is present. Everything else works without either.

| Variable | Enables | What leaves your machine |
| --- | --- | --- |
| `GEMINI_API_KEY` | Cloud OCR, which can also describe charts and diagrams | The image, to Google |
| `ASSEMBLYAI_API_KEY` | Audio transcription | The audio file, to AssemblyAI |

Keys are read from the environment, never written to disk and never logged.

## Development

```bash
npm install          # .npmrc sets include=dev — do not delete it
npm run build        # stages the OCR engine, then bundles with esbuild
npm test             # 15 tests against the built bundle
npm run smoke        # converts every file in samples/ and reports
npm run typecheck
```

### Why the build is esbuild rather than tsc

`src/lib/convert/` is kept **byte-identical** to the copies in the Windows, web
and Android apps, so that drift can be detected rather than discovered. Those
files use extensionless imports and one Vite-specific `?url` import, neither of
which Node's own resolver accepts. esbuild resolves both, so the shared files
never need Node-shaped edits.

### The runtime hook

Three things genuinely differ between a browser and Node, and
`src/lib/convert/runtime.ts` asks the host rather than sniffing for `process`:

| Hook | Why |
| --- | --- |
| `tesseractPaths` | A browser needs URLs and its own worker; Node needs filesystem paths and must **not** be given the browser worker |
| `docxSource` | mammoth reads `arrayBuffer` in browsers and `buffer` under Node |
| `ocrImageInput` | tesseract's Node build cannot decode a `Blob`; it wants a Buffer |

Everything else is shared. `src/runtime/node.ts` supplies the Node answers and
shims exactly one browser global, `DOMParser`.

> A caution learned the hard way: that file used to define `document` too, and
> it broke OCR. tesseract.js sniffed for a DOM, found one, took the browser
> branch and died on `window is not defined`. Half a browser is worse than
> none — shim the minimum.

### Keeping the copies honest

```bash
npm run sync:check              # list differences against all three apps
npm run sync:pull web           # bring the web app's version in
node scripts/sync-converters.mjs --push web
```

This package is the canonical copy: it is the only one with the runtime hook
that lets identical files run in both environments, so fixes start here and
flow outward. `sync:check` reports and exits zero — drift is information, not a
build failure.

## Related

| | |
| --- | --- |
| Windows app | [Microsoft Store](https://apps.microsoft.com/detail/9N1S7QP2WNLX) · [source](https://github.com/Narashiman-K/Markdown-Notes-windows) |
| Web app | [markdown-notes-psi.vercel.app](https://markdown-notes-psi.vercel.app) · [source](https://github.com/Narashiman-K/Markdown-Notes-web) |
| Android | [source](https://github.com/Narashiman-K/Markdown-Notes-Android) |
