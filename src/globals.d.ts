/**
 * Declarations that exist so the shared converter files type-check unchanged.
 *
 * These describe Vite conventions the app copies rely on. Nothing here affects
 * the emitted output — `scripts/build.mjs` handles the corresponding runtime
 * behaviour — but without them TypeScript would flag code that is correct in
 * the apps, and the pressure to "fix" it here would break byte-identity.
 */

/** Vite's `?url` import, used by pdf.ts to locate the pdf.js worker. */
declare module '*?url' {
  const url: string
  export default url
}

declare module '*?worker' {
  const worker: new () => Worker
  export default worker
}
