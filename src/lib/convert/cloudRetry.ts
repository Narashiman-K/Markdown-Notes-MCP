/**
 * Calling a cloud OCR service page after page without losing the document.
 *
 * Gemini's free tier refuses bursts: a multi-page scan sent page after page
 * came back "the model is overloaded" or "resource exhausted" partway
 * through, and because one failed page failed the whole conversion, an
 * eight-page scan could not be converted at all while a one-page scan worked.
 *
 * Three things fix that, in order:
 *   1. pacing — a short gap between requests, so a document is never a burst;
 *   2. retrying — a busy or rate-limited answer is retried after a growing
 *      wait, with the wait shown to the user so nothing looks frozen;
 *   3. giving up gracefully — a page that still fails is handed back to the
 *      caller, which reads it offline instead. Nothing already read is lost.
 *
 * The status code does not survive the trip from the provider to here (the
 * Windows app relays only the message), so busy-ness is judged from the text.
 * The patterns are the ones Google and the other providers actually return.
 */

/** Messages that mean "not now", as opposed to "never" (a bad key, a bad request). */
const TRANSIENT = /high demand|overload|busy|unavailable|temporar|try again|rate.?limit|too many requests|quota|exhausted|\b429\b|\b503\b|\b502\b|\b504\b|timed? ?out|timeout|deadline|ECONNRESET|network/i

export function isTransient(error: unknown): boolean {
  return TRANSIENT.test(String((error as Error)?.message ?? error))
}

export interface RetryOptions {
  /** Waits, in milliseconds, before each retry. Four retries by default. */
  backoff?: number[]
  /** Shortest gap between the start of one request and the next. */
  minGap?: number
  /** Told about each wait, so the UI can say what is happening. */
  onWait?: (seconds: number, attempt: number, reason: string) => void
  /** Injectable for tests. */
  sleep?: (ms: number) => Promise<void>
  now?: () => number
}

/*
 * About a minute and a quarter of patience per page. Gemini's overload spells
 * often outlast a shorter backoff, and giving up early matters more than it
 * seems: the fallback is offline OCR, which reads only the languages it has,
 * so for a document in Kannada or Hindi a patient retry is the difference
 * between a transcript and nonsense.
 */
const DEFAULT_BACKOFF = [3_000, 8_000, 20_000, 45_000]

/** Paces and retries calls to one cloud service. One instance per document. */
export class CloudCaller {
  private lastStart = -Infinity
  private readonly backoff: number[]
  private readonly minGap: number
  private readonly sleep: (ms: number) => Promise<void>
  private readonly now: () => number

  constructor(private readonly options: RetryOptions = {}) {
    this.backoff = options.backoff ?? DEFAULT_BACKOFF
    this.minGap = options.minGap ?? 1_500
    this.sleep = options.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)))
    this.now = options.now ?? (() => Date.now())
  }

  /**
   * Runs `call`, pacing it after the previous one and retrying while the
   * service says it is busy. Rejects with the last error once retries run
   * out, or at once for an error that retrying cannot fix.
   */
  async run<T>(call: () => Promise<T>): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      const wait = this.lastStart + this.minGap - this.now()
      if (wait > 0) await this.sleep(wait)
      this.lastStart = this.now()
      try {
        return await call()
      } catch (err) {
        if (!isTransient(err) || attempt >= this.backoff.length) throw err
        const ms = this.backoff[attempt]
        this.options.onWait?.(Math.round(ms / 1000), attempt + 1, String((err as Error)?.message ?? err))
        await this.sleep(ms)
      }
    }
  }
}
