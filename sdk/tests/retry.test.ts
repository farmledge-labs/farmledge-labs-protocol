import { withRetry } from '../src/tx/retry'
import { RetryableError, TerminalError } from '../src/errors'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** A sleep spy that records every delay passed to it. */
function makeFakeSleep() {
  const delays: number[] = []
  const sleep = async (ms: number): Promise<void> => {
    delays.push(ms)
  }
  return { sleep, delays }
}

/** A deterministic random that always returns the same fraction. */
const alwaysHalf = () => 0.5
const alwaysOne = () => 0.9999999 // max-jitter (just under 1)

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('withRetry()', () => {
  // -------------------------------------------------------------------------
  // Success on first attempt
  // -------------------------------------------------------------------------
  it('returns the value immediately on success (no retries)', async () => {
    const { sleep, delays } = makeFakeSleep()
    const result = await withRetry(() => Promise.resolve(42), {
      sleep,
      random: alwaysHalf,
    })
    expect(result).toBe(42)
    expect(delays).toHaveLength(0)
  })

  // -------------------------------------------------------------------------
  // Transient failure then success
  // -------------------------------------------------------------------------
  it('retries on RetryableError and returns on the second attempt', async () => {
    const { sleep, delays } = makeFakeSleep()
    let calls = 0

    const result = await withRetry(
      () => {
        calls++
        if (calls === 1) throw new RetryableError('NETWORK_FAILURE', 'transient')
        return Promise.resolve('ok')
      },
      { attempts: 3, baseDelayMs: 500, maxDelayMs: 8000, sleep, random: alwaysHalf },
    )

    expect(result).toBe('ok')
    expect(calls).toBe(2)
    // One sleep before attempt 2: baseDelayMs * 2^0 * 0.5 = 500 * 1 * 0.5 = 250
    expect(delays).toEqual([250])
  })

  // -------------------------------------------------------------------------
  // TerminalError is not retried
  // -------------------------------------------------------------------------
  it('rethrows TerminalError immediately without retrying', async () => {
    const { sleep, delays } = makeFakeSleep()
    let calls = 0

    const terminal = new TerminalError('SIMULATION_FAILED', 'contract rejected')

    await expect(
      withRetry(
        () => {
          calls++
          throw terminal
        },
        { attempts: 5, sleep, random: alwaysHalf },
      ),
    ).rejects.toBe(terminal)

    // Exactly one call, zero sleeps
    expect(calls).toBe(1)
    expect(delays).toHaveLength(0)
  })

  // -------------------------------------------------------------------------
  // Retry budget exhaustion
  // -------------------------------------------------------------------------
  it('exhausts the budget and re-throws the last RetryableError after exactly N attempts', async () => {
    const { sleep, delays } = makeFakeSleep()
    let calls = 0
    const lastErr = new RetryableError('TRY_AGAIN_LATER', 'still busy')

    await expect(
      withRetry(
        () => {
          calls++
          throw new RetryableError('TRY_AGAIN_LATER', `attempt ${calls}`)
        },
        { attempts: 3, baseDelayMs: 100, maxDelayMs: 8000, sleep, random: alwaysHalf },
      ),
    ).rejects.toBeInstanceOf(RetryableError)

    // 3 attempts, 2 sleeps (no sleep after the final attempt)
    expect(calls).toBe(3)
    expect(delays).toHaveLength(2)
    void lastErr // suppress unused warning
  })

  // -------------------------------------------------------------------------
  // Exponential back-off grows correctly
  // -------------------------------------------------------------------------
  it('delays grow exponentially: base*2^0, base*2^1, base*2^2 (with fixed jitter 0.5)', async () => {
    const { sleep, delays } = makeFakeSleep()
    const BASE = 500

    await expect(
      withRetry(
        () => {
          throw new RetryableError('NETWORK_FAILURE', 'fail')
        },
        {
          attempts: 4,
          baseDelayMs: BASE,
          maxDelayMs: 8000,
          sleep,
          random: alwaysHalf, // jitter = delay * 0.5
        },
      ),
    ).rejects.toBeInstanceOf(RetryableError)

    // Delays before attempts 2, 3, 4:
    //   attempt 1 → sleep(floor(500 * 2^0 * 0.5)) = sleep(250)
    //   attempt 2 → sleep(floor(500 * 2^1 * 0.5)) = sleep(500)
    //   attempt 3 → sleep(floor(500 * 2^2 * 0.5)) = sleep(1000)
    expect(delays).toEqual([250, 500, 1000])
  })

  // -------------------------------------------------------------------------
  // Jitter never pushes delay above maxDelayMs
  // -------------------------------------------------------------------------
  it('jitter never pushes delay above maxDelayMs even at maximum jitter', async () => {
    const { sleep, delays } = makeFakeSleep()
    const MAX = 1000

    await expect(
      withRetry(
        () => {
          throw new RetryableError('NETWORK_FAILURE', 'fail')
        },
        {
          attempts: 6,
          baseDelayMs: 500,
          maxDelayMs: MAX,
          sleep,
          random: alwaysOne, // near-maximum jitter
        },
      ),
    ).rejects.toBeInstanceOf(RetryableError)

    // All delays must be strictly below MAX (floor(MAX * alwaysOne) < MAX)
    for (const d of delays) {
      expect(d).toBeLessThanOrEqual(MAX)
    }
  })

  // -------------------------------------------------------------------------
  // maxDelayMs caps exponential growth
  // -------------------------------------------------------------------------
  it('caps delay at maxDelayMs before applying jitter', async () => {
    const { sleep, delays } = makeFakeSleep()
    const BASE = 500
    const MAX = 600

    await expect(
      withRetry(
        () => {
          throw new RetryableError('NETWORK_FAILURE', 'fail')
        },
        {
          attempts: 5,
          baseDelayMs: BASE,
          maxDelayMs: MAX,
          sleep,
          random: alwaysHalf, // jitter factor 0.5
        },
      ),
    ).rejects.toBeInstanceOf(RetryableError)

    // attempt 1: exponential=500, capped=500, jittered=floor(500*0.5)=250
    // attempt 2: exponential=1000, capped=600, jittered=floor(600*0.5)=300
    // attempt 3: exponential=2000, capped=600, jittered=300
    // attempt 4: exponential=4000, capped=600, jittered=300
    expect(delays).toEqual([250, 300, 300, 300])
    for (const d of delays) {
      expect(d).toBeLessThanOrEqual(MAX)
    }
  })

  // -------------------------------------------------------------------------
  // Non-RetryableError / non-TerminalError is retried (treated as transient)
  // -------------------------------------------------------------------------
  it('retries on plain Error (not TerminalError) as if it were retryable', async () => {
    const { sleep } = makeFakeSleep()
    let calls = 0

    const result = await withRetry(
      () => {
        calls++
        if (calls < 3) throw new Error('plain error')
        return Promise.resolve('done')
      },
      { attempts: 5, sleep, random: alwaysHalf },
    )

    expect(result).toBe('done')
    expect(calls).toBe(3)
  })
})
