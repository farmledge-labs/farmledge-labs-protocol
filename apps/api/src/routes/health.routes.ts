/**
 * Health check routes.
 *
 * GET /health/stellar
 * ───────────────────
 * Pings the configured Horizon endpoint, measures round-trip latency, and
 * returns the Stellar network status.  This is a pure infrastructure probe —
 * it carries no user data and does not touch any Soroban contract.
 *
 * Response 200 — Horizon reachable:
 *   {
 *     "status": "ok",
 *     "network": "testnet",          // STELLAR_NETWORK env var
 *     "horizonUrl": "https://...",
 *     "latencyMs": 42,
 *     "horizonVersion": "0.0.1"      // from Horizon root response (may be absent)
 *   }
 *
 * Response 503 — Horizon unreachable:
 *   {
 *     "status": "error",
 *     "network": "testnet",
 *     "horizonUrl": "https://...",
 *     "latencyMs": 1234,
 *     "error": "request timeout"
 *   }
 *
 * This handler is framework-agnostic: it exports a plain async function that
 * accepts a minimal request-like object and returns a typed response object.
 * Wire it into Express / Fastify / plain http at the application layer.
 */

import { HORIZON_URL, STELLAR_NETWORK } from '../lib/env'

// ─── Types ────────────────────────────────────────────────────────────────────

export interface StellarHealthOk {
  status: 'ok'
  network: string
  horizonUrl: string
  latencyMs: number
  horizonVersion?: string
}

export interface StellarHealthError {
  status: 'error'
  network: string
  horizonUrl: string
  latencyMs: number
  error: string
}

export type StellarHealthResponse = StellarHealthOk | StellarHealthError

export interface HealthHandlerResult {
  statusCode: number
  body: StellarHealthResponse
}

// ─── Horizon probe ────────────────────────────────────────────────────────────

/**
 * Fetch the Horizon root endpoint and return timing + version info.
 *
 * @internal — exported so tests can replace it via jest.mock without touching
 *             the global fetch implementation.
 */
export async function probeHorizon(
  horizonUrl: string,
  fetchImpl: typeof fetch = globalThis.fetch
): Promise<{ latencyMs: number; horizonVersion?: string }> {
  const start = Date.now()

  const response = await fetchImpl(horizonUrl, {
    method: 'GET',
    headers: { Accept: 'application/json' },
    signal: AbortSignal.timeout(8_000), // 8-second hard deadline
  })

  const latencyMs = Date.now() - start

  if (!response.ok) {
    throw new Error(`Horizon returned HTTP ${response.status}`)
  }

  // Best-effort: parse version from response body.
  // Horizon root returns {"horizon_version": "...", ...}.
  let horizonVersion: string | undefined
  try {
    const json = (await response.json()) as Record<string, unknown>
    if (typeof json['horizon_version'] === 'string') {
      horizonVersion = json['horizon_version']
    }
  } catch {
    // Non-JSON or missing field — version stays undefined; not a hard failure.
  }

  return { latencyMs, horizonVersion }
}

// ─── Route handler ────────────────────────────────────────────────────────────

/**
 * Handle GET /health/stellar.
 *
 * Pass an optional `fetchImpl` for testing (defaults to `globalThis.fetch`).
 */
export async function handleStellarHealth(
  fetchImpl?: typeof fetch
): Promise<HealthHandlerResult> {
  const start = Date.now()

  try {
    const { latencyMs, horizonVersion } = await probeHorizon(
      HORIZON_URL,
      fetchImpl ?? globalThis.fetch
    )

    const body: StellarHealthOk = {
      status: 'ok',
      network: STELLAR_NETWORK,
      horizonUrl: HORIZON_URL,
      latencyMs,
      ...(horizonVersion !== undefined ? { horizonVersion } : {}),
    }

    return { statusCode: 200, body }
  } catch (err: unknown) {
    const latencyMs = Date.now() - start
    const message =
      err instanceof Error ? err.message : 'unknown error'

    const body: StellarHealthError = {
      status: 'error',
      network: STELLAR_NETWORK,
      horizonUrl: HORIZON_URL,
      latencyMs,
      error: message,
    }

    return { statusCode: 503, body }
  }
}
