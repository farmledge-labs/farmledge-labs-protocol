/**
 * LEND-2 — verifyToken controller
 *
 * OVERVIEW
 * ────────
 * This controller handles requests from the lending UI that need a deep
 * verification report on a warehouse-receipt token before a loan decision
 * is made.  It is the ONE place in Farmledge where an NGN value is
 * deliberately surfaced — lenders need estimated collateral value and this
 * is the approved source.
 *
 * REPORT CONTENTS
 * ───────────────
 * 1. tokenId            — the queried token
 * 2. chainMeta          — live SesameTokenMetadata fetched directly from the
 *                         Soroban contract (single source of truth)
 * 3. chainOwner         — current on-chain owner address
 * 4. dbRecord           — the DB snapshot at the time of the request (may lag
 *                         the chain if reconciliation hasn't run yet)
 * 5. drift              — fields where DB diverges from chain state
 * 6. custodianStatus    — whether the custodian address is on the approved list
 * 7. warehouseCertValid — whether the warehouse ID maps to a certified facility
 * 8. isLocked           — whether the token is currently locked for financing
 * 9. estimatedValueNgn  — totalWeightKg × current NGN/kg spot price
 *
 * DESIGN PRINCIPLES
 * ─────────────────
 * • Framework-agnostic: returns {statusCode, body}, never touches Express.
 * • All external dependencies (SDK queries, price oracle, store) are injected,
 *   making the handler fully unit-testable without a live network.
 * • Chain is always the source of truth.  If the chain query fails, the
 *   handler returns 502 rather than falling back to stale DB data silently.
 */

import type { FarmledgeClient } from '@farmledge/protocol-sdk'
import {
  sesameQueryToken,
  sesameQueryOwner,
} from '@farmledge/protocol-sdk'
import type { SesameTokenMetadata } from '@farmledge/protocol-sdk'
import type { TokenRecord } from '@farmledge/protocol-sdk'
import {
  lookupPriceNgnPerKg,
  isCommodityCode,
} from '../services/priceOracle.service'
import type { CommodityCode } from '../services/priceOracle.service'

// ─── Store interface (same minimal shape as reconcile.job.ts) ─────────────────

export interface TokenStore {
  getToken(tokenId: string): TokenRecord | undefined
}

// ─── Approved custodians & certified warehouses registries ────────────────────

/**
 * Minimal registry interfaces injected by the caller.
 * In production these back onto DB tables; in tests they are plain objects.
 */
export interface CustodianRegistry {
  isApproved(custodianAddress: string): boolean
}

export interface WarehouseRegistry {
  isCertified(warehouseId: string): boolean
}

// ─── Drift report ─────────────────────────────────────────────────────────────

/** A single field that differs between DB and chain. */
export interface DriftField {
  field: string
  dbValue: unknown
  chainValue: unknown
}

// ─── Verification report (success) ───────────────────────────────────────────

export interface VerificationReport {
  tokenId: string
  /** Live on-chain metadata — always from the chain, never from the DB. */
  chainMeta: SesameTokenMetadata
  /** Current on-chain owner address. */
  chainOwner: string
  /** DB snapshot at request time. null if not in DB. */
  dbRecord: TokenRecord | null
  /** Fields where DB diverges from chain. Empty when DB is current. */
  drift: DriftField[]
  /** Whether the token's custodian is on the approved list. */
  custodianApproved: boolean
  /** Whether the warehouse holding this deposit is certified. */
  warehouseCertValid: boolean
  /** Whether the token is currently locked for financing. */
  isLocked: boolean
  /**
   * Estimated collateral value in NGN.
   * = chainMeta.totalWeightKg × live NGN/kg spot price.
   *
   * This is the one deliberate NGN figure in the Farmledge API.
   * Shown only here to support lender collateral decisions.
   */
  estimatedValueNgn: number
  /** Price per kg used for the valuation. */
  priceNgnPerKg: number
  /** Whether the price is a live quote or a fallback reference price. */
  priceIsFallback: boolean
}

// ─── Error body ───────────────────────────────────────────────────────────────

export interface VerifyTokenErrorBody {
  error: string
  tokenId: string
}

// ─── Handler result ───────────────────────────────────────────────────────────

export type VerifyTokenResult =
  | { statusCode: 200; body: VerificationReport }
  | { statusCode: 400 | 404 | 502; body: VerifyTokenErrorBody }

// ─── Injected dependencies ────────────────────────────────────────────────────

export type QueryTokenFn = typeof sesameQueryToken
export type QueryOwnerFn = typeof sesameQueryOwner
export type LookupPriceFn = typeof lookupPriceNgnPerKg

export interface VerifyTokenDeps {
  client: FarmledgeClient
  store: TokenStore
  custodianRegistry: CustodianRegistry
  warehouseRegistry: WarehouseRegistry
  queryToken: QueryTokenFn
  queryOwner: QueryOwnerFn
  lookupPrice: LookupPriceFn
}

// ─── Handler ─────────────────────────────────────────────────────────────────

/**
 * Handle a verify-token request.
 *
 * @param tokenId - The warehouse-receipt token ID to verify.
 * @param deps    - Injected dependencies.
 * @returns       A structured {@link VerifyTokenResult}.
 */
export async function handleVerifyToken(
  tokenId: string,
  deps: VerifyTokenDeps,
): Promise<VerifyTokenResult> {
  const { client, store, custodianRegistry, warehouseRegistry, queryToken, queryOwner, lookupPrice } =
    deps

  // ── 0. Validate input ──────────────────────────────────────────────────────
  if (!tokenId || typeof tokenId !== 'string' || tokenId.trim() === '') {
    return {
      statusCode: 400,
      body: { error: 'tokenId is required', tokenId: tokenId ?? '' },
    }
  }

  const id = tokenId.trim()

  // ── 1. Live chain query — owner ────────────────────────────────────────────
  let chainOwner: string
  try {
    chainOwner = await queryOwner(client, id)
  } catch (err: unknown) {
    if (isTokenNotFoundError(err)) {
      return {
        statusCode: 404,
        body: {
          error: 'Token does not exist on chain.',
          tokenId: id,
        },
      }
    }
    return {
      statusCode: 502,
      body: {
        error: `Chain owner query failed: ${errorMessage(err)}`,
        tokenId: id,
      },
    }
  }

  // ── 2. Live chain query — metadata ─────────────────────────────────────────
  let chainMeta: SesameTokenMetadata
  try {
    chainMeta = await queryToken(client, id)
  } catch (err: unknown) {
    return {
      statusCode: 502,
      body: {
        error: `Chain metadata query failed: ${errorMessage(err)}`,
        tokenId: id,
      },
    }
  }

  // ── 3. DB snapshot ────────────────────────────────────────────────────────
  const dbRecord = store.getToken(id) ?? null

  // ── 4. Drift detection ────────────────────────────────────────────────────
  const drift = detectDrift(dbRecord, chainMeta, chainOwner)

  // ── 5. Custodian & warehouse status ───────────────────────────────────────
  const custodianApproved = custodianRegistry.isApproved(chainMeta.custodian)
  const warehouseCertValid = warehouseRegistry.isCertified(chainMeta.warehouseId)

  // ── 6. Lock status ────────────────────────────────────────────────────────
  const isLocked = chainMeta.isLocked

  // ── 7. Price & estimated value ────────────────────────────────────────────
  const commodity: CommodityCode = isCommodityCode(chainMeta.commodity)
    ? chainMeta.commodity
    : 'SESAME' // safe fallback — sesame is the primary commodity

  const priceResult = await lookupPrice(commodity)
  const estimatedValueNgn = Math.round(chainMeta.totalWeightKg * priceResult.priceNgnPerKg)

  // ── 8. Assemble report ────────────────────────────────────────────────────
  const report: VerificationReport = {
    tokenId: id,
    chainMeta,
    chainOwner,
    dbRecord,
    drift,
    custodianApproved,
    warehouseCertValid,
    isLocked,
    estimatedValueNgn,
    priceNgnPerKg: priceResult.priceNgnPerKg,
    priceIsFallback: priceResult.isFallback,
  }

  return { statusCode: 200, body: report }
}

// ─── Private helpers ──────────────────────────────────────────────────────────

/**
 * Compare the DB snapshot against live chain state and collect any
 * fields that differ.
 */
function detectDrift(
  dbRecord: TokenRecord | null,
  chainMeta: SesameTokenMetadata,
  chainOwner: string,
): DriftField[] {
  if (!dbRecord) return []

  const drifts: DriftField[] = []

  if (dbRecord.owner !== chainOwner) {
    drifts.push({ field: 'owner', dbValue: dbRecord.owner, chainValue: chainOwner })
  }

  const r = dbRecord.receipt
  if (r.commodity !== chainMeta.commodity) {
    drifts.push({ field: 'commodity', dbValue: r.commodity, chainValue: chainMeta.commodity })
  }
  if (r.quantity !== chainMeta.totalWeightKg) {
    drifts.push({ field: 'quantity', dbValue: r.quantity, chainValue: chainMeta.totalWeightKg })
  }
  if (r.gradeCode !== chainMeta.grade) {
    drifts.push({ field: 'gradeCode', dbValue: r.gradeCode, chainValue: chainMeta.grade })
  }
  if (r.custodian !== chainMeta.custodian) {
    drifts.push({ field: 'custodian', dbValue: r.custodian, chainValue: chainMeta.custodian })
  }
  if (r.depositor !== chainMeta.warehouseId) {
    drifts.push({ field: 'depositor', dbValue: r.depositor, chainValue: chainMeta.warehouseId })
  }

  return drifts
}

/** Detect "token not found" errors from the Soroban contract. */
function isTokenNotFoundError(err: unknown): boolean {
  if (!(err instanceof Error)) return false
  return (
    err.message.includes('TokenNotFound') ||
    err.message.includes('Error(Contract, #1)') ||
    err.message.includes('token not found')
  )
}

/** Extract a plain string message from any thrown value. */
function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
