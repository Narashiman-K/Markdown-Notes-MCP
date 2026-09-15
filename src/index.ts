/**
 * Library entry point.
 *
 * The MCP server is one consumer of this package; the VS Code extension is
 * another, and it needs the converters without a stdio transport attached.
 * Importing from here installs the Node shims as a side effect, so a caller
 * cannot forget to.
 */
import { installNodeRuntime } from './runtime/node'

installNodeRuntime()

export { installNodeRuntime }
export * from './lib/convert'
export { geminiOcr, assemblyTranscribe, geminiKey, assemblyKey } from './cloud'
