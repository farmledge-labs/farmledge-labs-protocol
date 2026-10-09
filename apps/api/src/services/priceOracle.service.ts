/**
 * Price Oracle Service — LEND-2
 *
 * OVERVIEW
 * ────────
 * Returns a spot price in NGN per kilogram for each supported commodity.
 * This is the one deliberate exception to "no Naira anywhere" in Farmledge:
 * lenders need an estimated collateral value to make a loan decision, and
 * this service is the single source of that figure.
 *
 * DESIGN
 * ──────
 * The real implementation fetches prices from the AFEX Commodities Exchange
 * (or a configured price-feed endpoint). In production, set:
 *
 *   PRICE_FEED_URL   - Base URL of the price feed API
 *   PRICE_FEED_TOKEN - Bearer token for the API (optional)
 *
 * When no URL is configured (local dev / CI), the service falls back to
 * hard-coded reference prices so the rest of the stack compiles and tests
 * pass without a live feed.
 *
 * INJECTION
 * ─────────
 * The core lookup function `lookupPriceNgnPerKg` accepts an optional
 * `fetchImpl` so unit tests can inject a mock without monkey-patching globals.
 *
 * All dollar amounts and foreign currencies are intentionally absent from
 * this module — only NGN is returned here.
 */

// ─── Supported commodity codes ────────────────────────────────────────────────

/** Commodity codes as defined by the farmledge-protocol contracts. */
export type CommodityCode = 'MAIZE_WHITE' | 'MAIZE_YELLOW' | 'SESAME'

/**
 * Whether a string is a known commodity code.
 */
export function isCommodityCode(value: string): value is CommodityCode {
  return value === 'MAIZE_WHITE' || value === 'MAIZE_YELLOW' || value === 'SESAME'
}

// ─── Price result ─────────────────────────────────────────────────────────────

export interface CommodityPrice {
  /** Commodity code this price applies to. */
  commodity: CommodityCode
  /** Price in Nigerian Naira per kilogram. */
  priceNgnPerKg: number
  /** ISO-8601 timestamp of when this price was observed/fetched. */
  fetchedAt: string
  /** True if this is a hard-coded fallback rather than a live quote. */
  isFallback: boolean
}

// ─── Fallback prices (reference values) ──────────────────────────────────────

/**
 * Hard-coded reference prices used when no live price feed is configured.
 * Values are approximate mid-market NGN/kg as of August 2026 (AFEX Nigeria).
 * These exist only so local dev and tests work without a live API key.
 */
const FALLBACK_PRICES_NGN_PER_KG: Record<CommodityCode, number> = {
  MAIZE_WHITE: 320,   // ~NGN 320/kg
  MAIZE_YELLOW: 310,  // ~NGN 310/kg
  SESAME: 1800,       // ~NGN 1,800/kg
}

// ─── Live price feed ──────────────────────────────────────────────────────────

/**
 * Attempt to fetch a live price for `commodity` from the configured price
 * feed URL.
 *
 * Expected response shape (subset):
 *   { "priceNgn": 320.50 }
 *
 * @throws if the fetch fails or the response is malformed — callers should
 *         catch and fall back to reference prices.
 */
async function fetchLivePrice(
  commodity: CommodityCode,
  feedUrl: string,
  feedToken: string | undefined,
  fetchImpl: typeof fetch,
): Promise<number> {
  const url = `${feedUrl.replace(/\/$/, '')}/prices/${commodity}`

  const headers: Record<string, string> = { Accept: 'application/json' }
  if (feedToken) {
    headers['Authorization'] = `Bearer ${feedToken}`
  }

  const response = await fetchImpl(url, {
    method: 'GET',
    headers,
    signal: AbortSignal.timeout(5_000),
  })

  if (!response.ok) {
    throw new Error(`Price feed returned HTTP ${response.status} for ${commodity}`)
  }

  const json = (await response.json()) as Record<string, unknown>
  const price = json['priceNgn']

  if (typeof price !== 'number' || !isFinite(price) || price <= 0) {
    throw new Error(`Price feed returned invalid priceNgn for ${commodity}: ${String(price)}`)
  }

  return price
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Look up the current NGN/kg price for a commodity.
 *
 * Tries the live price feed first; falls back to hard-coded reference prices
 * if the feed is unconfigured or returns an error.
 *
 * @param commodity  - One of the supported commodity codes.
 * @param fetchImpl  - Fetch implementation (injectable for tests).
 * @returns          A {@link CommodityPrice} with the NGN/kg price.
 */
export async function lookupPriceNgnPerKg(
  commodity: CommodityCode,
  fetchImpl: typeof fetch = globalThis.fetch,
): Promise<CommodityPrice> {
  const feedUrl = process.env['PRICE_FEED_URL']
  const feedToken = process.env['PRICE_FEED_TOKEN']
  const now = new Date().toISOString()

  if (feedUrl) {
    try {
      const priceNgnPerKg = await fetchLivePrice(commodity, feedUrl, feedToken, fetchImpl)
      return { commodity, priceNgnPerKg, fetchedAt: now, isFallback: false }
    } catch {
      // Live feed failed — fall through to reference prices.
    }
  }

  return {
    commodity,
    priceNgnPerKg: FALLBACK_PRICES_NGN_PER_KG[commodity],
    fetchedAt: now,
    isFallback: true,
  }
}
