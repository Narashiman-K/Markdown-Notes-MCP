# Privacy Policy

**Suprasūtā Markdown Notes — MCP server and Claude Desktop extension**

Last updated 16 September 2026.

---

## In short

This software collects nothing. It has no account, no analytics, no telemetry
and no server of its own. Document conversion happens entirely on your computer.

Two optional features send data to a third party, and only if you supply your
own API key for that service. Both are off until you do.

## Who is responsible

Narashiman Krishnamurthy, an independent developer. This is a non-commercial
project.

Contact: **naraforapps@gmail.com**

## What data is collected

**None.** The developer receives no data of any kind from this software. There
is no endpoint it reports to, no usage counter, and no crash reporting.

## What the software reads, and where it goes

| Data | What happens to it |
| --- | --- |
| Documents you convert | Read from disk, converted in memory, written back as a `.md` file beside the original. Never transmitted. |
| The resulting Markdown | Returned to the AI assistant that asked for it, and saved to your disk. |
| Folder paths you configure | Held in your MCP host's own settings. Read by the server at start-up. |
| API keys you enter | Held in your MCP host's own settings, passed to the server as environment variables. Never written to disk by this software, never logged, and never sent anywhere except the provider they belong to. |

The AI assistant you are using — Claude, or another MCP host — receives the
converted Markdown, because that is the point of the tool. What that assistant
does with it is governed by its own privacy policy, not this one.

## Third-party sharing

Only through the two optional features below, each requiring your own API key.
With no keys configured, this software makes no network connections at all.

| Feature | What is sent | To whom | Their policy |
| --- | --- | --- | --- |
| Cloud image recognition | The image you are converting | Google (Gemini API) | [policies.google.com/privacy](https://policies.google.com/privacy) |
| Audio transcription | The audio file you are converting | AssemblyAI | [assemblyai.com/legal/privacy-policy](https://www.assemblyai.com/legal/privacy-policy) |

Audio transcription is the only conversion with no local alternative. Text
recognition on images runs on your machine by default, using an engine bundled
inside this software, and only uses Google if you explicitly choose cloud mode.

Requests to these providers are made under **your** account with them, using
**your** key. The developer has no visibility into them.

## Storage and retention

Nothing is retained by this software or its developer, because nothing is
collected.

On your own computer, the software writes:

- Converted `.md` files, beside the original documents
- Summary files, if the assistant saves one
- A cached copy of the offline text-recognition language data, inside the
  installed package folder

All of these are ordinary files you can read, move or delete at any time. No
database, no hidden state.

## Your rights

Because no personal data is collected, there is nothing held about you to
access, correct, export or erase. To remove everything this software has put on
your computer, uninstall the extension or the npm package, and delete any
`.md` files it produced that you no longer want.

Any records held by Google or AssemblyAI, from the optional features, sit under
your own account with those providers and should be pursued with them directly.

## Children

This is a document conversion tool, not directed at children, and it collects no
personal information from anyone.

## Changes

Revisions will be published on this page with a new date, and noted in the
release notes.

---

Source code: <https://github.com/Narashiman-K/Markdown-Notes-MCP>
