/**
 * Tests for GET /health/stellar handler.
 *
 * Coverage:
 *  1. Healthy Horizon — responds 200 with status "ok", latency, and version.
 *  2. Horizon returns a non-2xx HTTP status — responds 503 with status "error".
 *  3. Unreachable Horizon (network error / timeout) — responds 503 with status "error".
 *  4. Horizon reachable but response body has no horizon_version — still returns 200.
 *  5. latencyMs is always a non-negative integer.
 *
 * The real fetch is never called — each test injects its own mock implementation.
 */

import {
  handleStellarHealth,
  probeHorizon,
  type StellarHealthOk,
  type StellarHealthError,
} from '../routes/health.routes'

// ─── Fetch mock helpers ───────────────────────────────────────────────────────

/** Build a mock fetch that returns a successful Horizon root response. */
function makeMockFetchOk(horizonVersion = '0.0.1'): typeof fetch {
  return jest.fn().mockResolvedValue({
    ok: true,
    status: 200,
    json: async () => ({ horizon_version: horizonVersion }),
  }) as unknown as typeof fetch
}

/** Build a mock fetch that returns a non-2xx HTTP response. */
function makeMockFetchHttpError(status: number): typeof fetch {
  return jest.fn().mockResolvedValue({
    ok: false,
    status,
    json: async () => ({}),
  }) as unknown as typeof fetch
}

/** Build a mock fetch that rejects (simulates network error / timeout). */
function makeMockFetchNetworkError(message = 'ECONNREFUSED'): typeof fetch {
  return jest.fn().mockRejectedValue(new Error(message)) as unknown as typeof fetch
}

// ─── 1. Healthy Horizon ───────────────────────────────────────────────────────

describe('handleStellarHealth — healthy Horizon', () => {
  it('returns statusCode 200', async () => {
    const result = await handleStellarHealth(makeMockFetchOk())
    expect(result.statusCode).toBe(200)
  })

  it('body.status is "ok"', async () => {
    const result = await handleStellarHealth(makeMockFetchOk())
    expect(result.body.status).toBe('ok')
  })

  it('body.horizonVersion matches the value returned by Horizon', async () => {
    const result = await handleStellarHealth(makeMockFetchOk('2.28.3'))
    expect((result.body as StellarHealthOk).horizonVersion).toBe('2.28.3')
  })

  it('body.network is a non-empty string', async () => {
    const result = await handleStellarHealth(makeMockFetchOk())
    expect(typeof result.body.network).toBe('string')
    expect(result.body.network.length).toBeGreaterThan(0)
  })

  it('body.horizonUrl is a non-empty string', async () => {
    const result = await handleStellarHealth(makeMockFetchOk())
    expect(typeof result.body.horizonUrl).toBe('string')
    expect(result.body.horizonUrl.length).toBeGreaterThan(0)
  })

  it('body.latencyMs is a non-negative integer', async () => {
    const result = await handleStellarHealth(makeMockFetchOk())
    expect(Number.isInteger(result.body.latencyMs)).toBe(true)
    expect(result.body.latencyMs).toBeGreaterThanOrEqual(0)
  })
})

// ─── 2. Horizon returns non-2xx ───────────────────────────────────────────────

describe('handleStellarHealth — Horizon HTTP error', () => {
  it('returns statusCode 503 when Horizon responds 429', async () => {
    const result = await handleStellarHealth(makeMockFetchHttpError(429))
    expect(result.statusCode).toBe(503)
  })

  it('body.status is "error"', async () => {
    const result = await handleStellarHealth(makeMockFetchHttpError(500))
    expect(result.body.status).toBe('error')
  })

  it('body.error contains the HTTP status code', async () => {
    const result = await handleStellarHealth(makeMockFetchHttpError(503))
    const errorBody = result.body as StellarHealthError
    expect(errorBody.error).toContain('503')
  })

  it('body.latencyMs is a non-negative integer even on error', async () => {
    const result = await handleStellarHealth(makeMockFetchHttpError(503))
    expect(Number.isInteger(result.body.latencyMs)).toBe(true)
    expect(result.body.latencyMs).toBeGreaterThanOrEqual(0)
  })
})

// ─── 3. Unreachable Horizon (network / timeout error) ────────────────────────

describe('handleStellarHealth — unreachable Horizon', () => {
  it('returns statusCode 503 on ECONNREFUSED', async () => {
    const result = await handleStellarHealth(makeMockFetchNetworkError('ECONNREFUSED'))
    expect(result.statusCode).toBe(503)
  })

  it('body.status is "error" on fetch rejection', async () => {
    const result = await handleStellarHealth(makeMockFetchNetworkError('TimeoutError'))
    expect(result.body.status).toBe('error')
  })

  it('body.error includes the underlying error message', async () => {
    const result = await handleStellarHealth(makeMockFetchNetworkError('request timeout'))
    const errorBody = result.body as StellarHealthError
    expect(errorBody.error).toContain('request timeout')
  })

  it('body.network and body.horizonUrl are always present', async () => {
    const result = await handleStellarHealth(makeMockFetchNetworkError())
    expect(typeof result.body.network).toBe('string')
    expect(result.body.network.length).toBeGreaterThan(0)
    expect(typeof result.body.horizonUrl).toBe('string')
    expect(result.body.horizonUrl.length).toBeGreaterThan(0)
  })
})

// ─── 4. Horizon reachable but no horizon_version field ───────────────────────

describe('handleStellarHealth — missing horizonVersion', () => {
  it('returns 200 even when horizon_version is absent from the response body', async () => {
    const fetchWithoutVersion: typeof fetch = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ some_other_field: 'value' }),
    }) as unknown as typeof fetch

    const result = await handleStellarHealth(fetchWithoutVersion)
    expect(result.statusCode).toBe(200)
    expect(result.body.status).toBe('ok')
  })

  it('horizonVersion is undefined when absent', async () => {
    const fetchWithoutVersion: typeof fetch = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({}),
    }) as unknown as typeof fetch

    const result = await handleStellarHealth(fetchWithoutVersion)
    const okBody = result.body as StellarHealthOk
    expect(okBody.horizonVersion).toBeUndefined()
  })
})

// ─── 5. probeHorizon unit ────────────────────────────────────────────────────

describe('probeHorizon', () => {
  it('returns latencyMs and horizonVersion on success', async () => {
    const { latencyMs, horizonVersion } = await probeHorizon(
      'https://horizon-testnet.stellar.org',
      makeMockFetchOk('1.2.3')
    )
    expect(latencyMs).toBeGreaterThanOrEqual(0)
    expect(horizonVersion).toBe('1.2.3')
  })

  it('throws when Horizon returns a non-ok status', async () => {
    await expect(
      probeHorizon(
        'https://horizon-testnet.stellar.org',
        makeMockFetchHttpError(500)
      )
    ).rejects.toThrow('HTTP 500')
  })

  it('throws when fetch rejects', async () => {
    await expect(
      probeHorizon(
        'https://horizon-testnet.stellar.org',
        makeMockFetchNetworkError('ECONNREFUSED')
      )
    ).rejects.toThrow('ECONNREFUSED')
  })
})
