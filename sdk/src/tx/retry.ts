import { RetryableError, TerminalError } from '../errors'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Options for {@link withRetry}.
 */
export interface RetryOptions {
  /**
   * Maximum number of attempts (including the first try).
   * @default 3
   */
  attempts?: number

  /**
   * Base delay in milliseconds before the first retry.
   * Subsequent retries use exponential back-off from this base.
   * @default 500
   */
  baseDelayMs?: number

  /**
   * Hard cap on delay. No single sleep will exceed this value, even after
   * jitter is applied.
   * @default 8000
   */
  maxDelayMs?: number

  /**
   * Injectable sleep function. Defaults to a real `setTimeout`-based sleep.
   * Provide a fake in tests so retries complete instantly.
   */
  sleep?: (ms: number) => Promise<void>

  /**
   * Injectable random-number source that returns a value in [0, 1).
   * Defaults to `Math.random`. Provide a deterministic value in tests.
   */
  random?: () => number
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

const DEFAULT_ATTEMPTS = 3
const DEFAULT_BASE_DELAY_MS = 500
const DEFAULT_MAX_DELAY_MS = 8_000

function realSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * Calls `fn` up to `attempts` times, retrying only on {@link RetryableError}.
 *
 * Back-off formula (before jitter):
 * ```
 * delay = min(maxDelayMs, baseDelayMs * 2^(attempt - 1))
 * ```
 * Jitter: the actual sleep is `delay * random()`, which keeps it in
 * `[0, delay]` and therefore always `≤ maxDelayMs`.
 *
 * - {@link TerminalError} (and all its subclasses) are re-thrown immediately
 *   without consuming any retry budget.
 * - Any other error type is treated like a {@link RetryableError} and retried,
 *   because unknown errors may be transient.
 * - After exhausting the attempt budget, the last error is re-thrown.
 *
 * @param fn      - Async function to attempt
 * @param options - {@link RetryOptions}
 * @returns The resolved value of `fn` on success
 * @throws The last error after all attempts are exhausted, or immediately on
 *         {@link TerminalError}
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  options: RetryOptions = {},
): Promise<T> {
  const {
    attempts = DEFAULT_ATTEMPTS,
    baseDelayMs = DEFAULT_BASE_DELAY_MS,
    maxDelayMs = DEFAULT_MAX_DELAY_MS,
    sleep = realSleep,
    random = Math.random,
  } = options

  let lastError: unknown

  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await fn()
    } catch (err) {
      // TerminalError: do not retry — rethrow immediately
      if (err instanceof TerminalError) {
        throw err
      }

      lastError = err

      // If we've used all attempts, stop here (no sleep before the final throw)
      if (attempt === attempts) {
        break
      }

      // Exponential back-off: base * 2^(attempt-1), capped at maxDelayMs
      const exponential = baseDelayMs * Math.pow(2, attempt - 1)
      const capped = Math.min(maxDelayMs, exponential)

      // Full jitter: actual delay in [0, capped] — never exceeds maxDelayMs
      const jittered = Math.floor(capped * random())

      await sleep(jittered)
    }
  }

  throw lastError
}
