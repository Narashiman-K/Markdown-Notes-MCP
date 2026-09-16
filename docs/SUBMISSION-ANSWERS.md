# Connectors Directory submission — answer sheet

Everything the MCPB desktop extension submission form is likely to ask, with the
answer ready to paste. Keep this open alongside the form.

**File to upload:** `build\suprasuta-markdown-mcp-0.1.4.mcpb` (53 MB)

---

## Identity

| Field | Answer |
| --- | --- |
| Extension name | `Suprasūtā Markdown Notes` |
| Version | `0.1.4` |
| Developer / publisher | `Narashiman Krishnamurthy` |
| Contact email | `naraforapps@gmail.com` |
| Individual or company | Individual developer, non-commercial project |
| Website | `https://github.com/Narashiman-K/Markdown-Notes-MCP` |

## Links

| Field | Answer |
| --- | --- |
| Source code | `https://github.com/Narashiman-K/Markdown-Notes-MCP` |
| Documentation | `https://github.com/Narashiman-K/Markdown-Notes-MCP#readme` |
| Privacy policy | `https://github.com/Narashiman-K/Markdown-Notes-MCP/blob/main/PRIVACY.md` |
| Support / issues | `https://github.com/Narashiman-K/Markdown-Notes-MCP/issues` |
| npm package | `https://www.npmjs.com/package/suprasuta-markdown-mcp` |
| MCP registry entry | `io.github.Narashiman-K/markdown-notes-mcp` |

## Short description (one line)

```
Convert PDF, Word, Excel, PowerPoint, EPUB and images to Markdown, on your own machine.
```

## Full description

```
Claude can read plain text, and sometimes PDFs. It cannot read EPUB,
OpenDocument or PowerPoint, and everything it does read has to be uploaded
first.

This converts documents on your own computer and hands Claude clean Markdown —
tables kept as tables, headings preserved, code properly fenced. Nothing is
uploaded, there is no account, and no telemetry of any kind.

Supported: PDF, Word (.docx), Excel (.xlsx/.xls/.xlsm), PowerPoint (.pptx),
OpenDocument text and spreadsheets (.odt/.ods), EPUB, CSV, TSV and plain text.
Images are read with optical character recognition that runs on the device,
using an engine bundled inside the extension, so it works with no connection.

The converted .md file is saved beside the original automatically, keeping the
full original filename, so it is always clear which document it came from. Long
documents come back as a short preview rather than filling the conversation,
which keeps token use down: a 50-page PDF costs roughly 400 tokens instead of
30,000.

Two optional features use the internet, and only if the user supplies their own
API key: cloud image recognition through Google Gemini, which can also describe
charts and diagrams, and audio transcription through AssemblyAI. Both are
dormant until a key is entered.
```

## Category

Productivity / document tools / file management — whichever of these the form
offers.

## What the tools do

| Tool | Behaviour | Annotations |
| --- | --- | --- |
| `convert_to_markdown` | Converts one document, saves `<original name>.md` beside it | not read-only, not destructive, open world |
| `convert_folder_to_markdown` | Converts several documents into a chosen folder | not read-only, not destructive, open world |
| `save_summary` | Saves an assistant-written summary as `<name>.summary.md` | not read-only, **destructive** (overwrites by design) |
| `list_supported_formats` | Lists formats and which optional features are configured | **read-only** |

If asked why the converters are `openWorldHint: true` while claiming to be
local: the two optional cloud features can reach the internet, and an annotation
cannot be conditional. Overstating the closed world seemed the wrong way to be
wrong.

## Authentication

**None required.** The extension works fully with no account and no credentials.

Two optional features accept a user-supplied API key, entered in Claude
Desktop's own extension settings and passed to the server as an environment
variable. No OAuth, because there is no service of ours to authenticate against
— the keys belong to the user's own Google and AssemblyAI accounts.

## Data handling

| Question | Answer |
| --- | --- |
| Do you collect user data? | No. No account, no analytics, no telemetry, no server. |
| Where is data processed? | Entirely on the user's machine, except the two optional features below. |
| Third parties | Google (Gemini) for optional cloud image recognition; AssemblyAI for optional audio transcription. Each requires the user's own API key and is inactive without one. |
| Is the API your own? | No — the two optional features call third-party APIs under the user's own account. There is no first-party API. |
| Data retention | None. Nothing is retained by the extension or its developer. |
| Personal health data | No |
| Sponsored content | No |
| Financial transactions | No |
| AI media generation | No |

## Permissions and file access

The extension reads documents the user asks it to convert, and writes a `.md`
file beside each original.

Users can restrict it to a single folder during install, via the **Folder this
extension may read** setting. Anything outside that folder is refused with a
clear message. Left empty, it can read any path the user asks for — which is
stated plainly in the setting's own description.

## Instructions for a reviewer

```
No account, key or setup is needed to test the main functionality.

1. Install the .mcpb. When asked for a folder, choose any folder containing
   documents, or leave it empty to allow any path.
2. Ask Claude: "What document formats can you convert?"
   -> calls list_supported_formats
3. Put a PDF, .docx or .epub somewhere and ask:
   "Convert <full path> to markdown"
   -> converts locally, saves <original name>.md beside it, returns the text
4. Ask: "Summarise <that same file>"
   -> converts, summarises, and saves <name>.summary.md beside it
5. To check the folder restriction: set a folder during install, then ask it to
   convert a file outside that folder. It refuses and names the configured root.

Sample documents in every supported format are in the repository under
samples/, if you would rather not supply your own.

The two optional cloud features need an API key from Google or AssemblyAI. They
are not needed to evaluate the extension; without a key they report clearly
that they are not configured rather than failing.

IMPORTANT: settings are read once at start-up. If you enter an API key while
Claude Desktop is running, restart it before testing that feature.
```

## Testing and platforms

Developed and tested on **Windows 11 (ARM64)**. The manifest declares Windows,
macOS and Linux because the code is plain Node with no platform-specific
dependencies, but macOS and Linux have not been tested on real hardware — worth
saying plainly if the form asks.

19 automated tests run against the built server, including four that drive it
over stdio exactly as a host does.

## Licence

Free for personal, non-commercial use. See
`https://github.com/Narashiman-K/Markdown-Notes-MCP/blob/main/LICENSE.md`.

If the form asks whether the extension is open source: the **source is public
and readable**, but the licence is not an OSI-approved open source licence.
Say source-available rather than open source.
