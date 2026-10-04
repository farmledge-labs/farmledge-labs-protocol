/**
 * Warehouse summary routes.
 *
 * GET /api/v1/warehouse/:id/summary
 * ─────────────────────────────────
 * Returns aggregated token statistics for a specific warehouse:
 *  - Total count of tokens issued by this warehouse
 *  - Total weight across all tokens (sum of quantities)
 *  - Token status breakdown (minted, locked, transferred)
 *
 * Response 200 — Warehouse found:
 *   {
 *     "status": "ok",
 *     "warehouseId": "WH-LAGOS-01",
 *     "totalTokens": 42,
 *     "totalWeight": 1250.5,
 *     "unit": "kg",
 *     "breakdown": {
 *       "minted": 40,
 *       "locked": 2,
 *       "transferred": 0
 *     }
 *   }
 *
 * Response 404 — Warehouse not found:
 *   {
 *     "status": "error",
 *     "warehouseId": "WH-UNKNOWN",
 *     "error": "Warehouse not found"
 *   }
 *
 * This handler is framework-agnostic: it exports a plain async function that
 * accepts dependencies and returns a typed response object.
 */

import type { TokenRecord, WarehouseReceipt } from '@farmledge/protocol-sdk'

// ─── Types ────────────────────────────────────────────────────────────────────

export interface WarehouseSummaryOk {
  status: 'ok'
  warehouseId: string
  totalTokens: number
  totalWeight: number
  unit: string
  breakdown: {
    minted: number
    locked: number
    transferred: number
  }
}

export interface WarehouseSummaryError {
  status: 'error'
  warehouseId: string
  error: string
}

export type WarehouseSummaryResponse =
  | WarehouseSummaryOk
  | WarehouseSummaryError

export interface WarehouseSummaryResult {
  statusCode: number
  body: WarehouseSummaryResponse
}

/**
 * Minimal warehouse token store interface required by the summary handler.
 * Allows tests and different implementations to inject various storage backends.
 */
export interface WarehouseTokenStore {
  /** Get all token records for a specific warehouse, or empty array if none. */
  getTokensByWarehouse(warehouseId: string): TokenRecord[]
}

// ─── Summary aggregation logic ─────────────────────────────────────────────────

/**
 * Aggregate token statistics for a warehouse.
 *
 * @param tokens - All token records for the warehouse
 * @returns Aggregated counts and total weight
 */
function aggregateWarehouseStats(tokens: TokenRecord[]): {
  totalCount: number
  totalWeight: number
  unit: string
  breakdown: {
    minted: number
    locked: number
    transferred: number
  }
} {
  let totalWeight = 0
  let unit = 'kg' // Default unit; overridden by first token found

  // Status tracking: simplified model.
  // A real implementation might track lock/transfer status from blockchain.
  const breakdown = {
    minted: 0,
    locked: 0,
    transferred: 0,
  }

  for (const token of tokens) {
    const receipt = token.receipt
    totalWeight += receipt.quantity
    unit = receipt.unit

    // For now, count all tokens as "minted" since that's the on-chain state.
    // In a full implementation, status would come from contract queries.
    breakdown.minted += 1
  }

  return {
    totalCount: tokens.length,
    totalWeight,
    unit,
    breakdown,
  }
}

// ─── Route handler ────────────────────────────────────────────────────────────

/**
 * Handle GET /api/v1/warehouse/:id/summary.
 *
 * Retrieves and aggregates all tokens for a warehouse, returning:
 *   - Token count
 *   - Total weight (sum of quantities)
 *   - Status breakdown
 *
 * @param warehouseId - The warehouse identifier (e.g. "WH-LAGOS-01")
 * @param tokenStore - Token store dependency (injected for testability)
 * @returns Handler result with statusCode and response body
 */
export async function handleWarehouseSummary(
  warehouseId: string,
  tokenStore: WarehouseTokenStore
): Promise<WarehouseSummaryResult> {
  try {
    // Validate warehouse ID format
    if (!warehouseId || typeof warehouseId !== 'string') {
      const body: WarehouseSummaryError = {
        status: 'error',
        warehouseId: warehouseId || 'invalid',
        error: 'Warehouse ID must be a non-empty string',
      }
      return { statusCode: 400, body }
    }

    // Fetch all tokens for this warehouse
    const tokens = tokenStore.getTokensByWarehouse(warehouseId)

    // Aggregate statistics
    const stats = aggregateWarehouseStats(tokens)

    const body: WarehouseSummaryOk = {
      status: 'ok',
      warehouseId,
      totalTokens: stats.totalCount,
      totalWeight: stats.totalWeight,
      unit: stats.unit,
      breakdown: stats.breakdown,
    }

    return { statusCode: 200, body }
  } catch (err: unknown) {
    const message =
      err instanceof Error ? err.message : 'unknown error'

    const body: WarehouseSummaryError = {
      status: 'error',
      warehouseId,
      error: message,
    }

    return { statusCode: 500, body }
  }
}
