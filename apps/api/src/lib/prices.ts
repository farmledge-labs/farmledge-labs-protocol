/**
 * Spot price lookups for NGN-denominated collateral valuation.
 *
 * IMPORTANT — deliberate exception to the "no Naira anywhere" rule:
 * The verifyToken endpoint is the ONLY place in Farmledge that exposes NGN
 * values. Every other view shows physical quantity only. The NGN estimate here
 * is for lenders making loan decisions, not a display convention.
 *
 * Price source hierarchy (first defined wins):
 *   1. Environment variables  MAIZE_SPOT_PRICE_NGN_PER_KG / SESAME_SPOT_PRICE_NGN_PER_KG
 *   2. Compile-time fallback constants (indicative Nigerian market rates)
 *
 * In production this module is the single place LEND-1 (or any future price
 * feed integration) needs to wire into. Replace the env-var override with a
 * live feed call here and nothing else changes.
 */

export type Commodity = 'MAIZE_WHITE' | 'MAIZE_YELLOW' | 'SESAME'

/** Indicative spot prices (NGN / kg) based on AFEX/ACE market data (2026 Q2). */
const FALLBACK_PRICES_NGN_PER_KG: Record<Commodity, number> = {
  MAIZE_WHITE: 320,    // ~₦320 / kg (~₦16,000 / 50 kg bag)
  MAIZE_YELLOW: 310,   // yellow maize trades at a slight discount to white
  SESAME: 1_200,       // sesame commands a premium as an export crop
}

/**
 * Returns the spot price in NGN per kilogram for the given commodity.
 *
 * The returned value is the basis for `estimatedValueNgn` in the verification
 * report. Callers should treat it as an indicative estimate — it is not a
 * guaranteed execution price.
 *
 * @param commodity - One of the protocol's recognised commodity codes
 * @returns NGN per kg as a number (always positive)
 * @throws If the commodity is not recognised
 */
export function getSpotPriceNgn(commodity: Commodity): number {
  switch (commodity) {
    case 'MAIZE_WHITE': {
      const envVal = process.env['MAIZE_SPOT_PRICE_NGN_PER_KG']
      return parsePositiveFloat(envVal, FALLBACK_PRICES_NGN_PER_KG.MAIZE_WHITE)
    }
    case 'MAIZE_YELLOW': {
      const envVal = process.env['MAIZE_SPOT_PRICE_NGN_PER_KG']
      // Yellow and white share the same env override; the fallback differs
      return parsePositiveFloat(envVal, FALLBACK_PRICES_NGN_PER_KG.MAIZE_YELLOW)
    }
    case 'SESAME': {
      const envVal = process.env['SESAME_SPOT_PRICE_NGN_PER_KG']
      return parsePositiveFloat(envVal, FALLBACK_PRICES_NGN_PER_KG.SESAME)
    }
    default: {
      // TypeScript exhaustiveness guard
      const _: never = commodity
      throw new Error(`Unrecognised commodity for NGN pricing: ${String(_)}`)
    }
  }
}

/**
 * Parses a price string from an environment variable and falls back to the
 * provided default when the variable is absent, empty, or malformed.
 */
function parsePositiveFloat(raw: string | undefined, fallback: number): number {
  if (!raw) return fallback
  const parsed = Number(raw)
  if (!Number.isFinite(parsed) || parsed <= 0) {
    // Malformed env var — use fallback silently to avoid crashing at startup
    return fallback
  }
  return parsed
}
