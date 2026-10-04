/**
 * Tests for warehouse.routes.ts — Warehouse Summary Endpoint
 *
 * Coverage:
 *  1. Success case: warehouse with multiple tokens aggregates correctly.
 *  2. Empty warehouse: no tokens returns zero counts.
 *  3. Idempotency: multiple calls return identical results.
 *  4. Invalid warehouse ID: returns 400 Bad Request.
 *  5. Token aggregation: weight sums correctly across different quantities.
 *  6. Mixed commodities: handles multiple commodity types in same warehouse.
 */

import {
  handleWarehouseSummary,
  type WarehouseTokenStore,
  type WarehouseSummaryOk,
  type WarehouseSummaryError,
} from '../routes/warehouse.routes'
import type { TokenRecord, WarehouseReceipt } from '@farmledge/protocol-sdk'

// ─── Test fixture builders ─────────────────────────────────────────────────────

/** Build a minimal WarehouseReceipt for testing. */
function makeReceipt(overrides: Partial<WarehouseReceipt> = {}): WarehouseReceipt {
  return {
    id: 'token-' + Math.random().toString(36).substring(7),
    commodity: 'maize',
    quantity: 100,
    unit: 'kg',
    gradeCode: 'A',
    custodian: 'Farmledge Labs',
    depositor: 'WH-LAGOS-01',
    issuedAt: Date.now(),
    expiresAt: Date.now() + 365 * 24 * 60 * 60 * 1000,
    ...overrides,
  }
}

/** Build a minimal TokenRecord for testing. */
function makeToken(
  warehouseId: string,
  overrides: Partial<TokenRecord> = {}
): TokenRecord {
  return {
    tokenId: 'CAAAAAAAAAAAAAA-' + Math.random().toString(36).substring(7),
    receipt: makeReceipt({
      depositor: warehouseId,
    }),
    owner: 'GBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB',
    mintedAt: Date.now(),
    ...overrides,
  }
}

/** Build a mock token store with preset tokens. */
function makeMockStore(
  tokensByWarehouse: Map<string, TokenRecord[]>
): WarehouseTokenStore {
  return {
    getTokensByWarehouse: (warehouseId: string) => {
      return tokensByWarehouse.get(warehouseId) ?? []
    },
  }
}

// ─── 1. Success case ──────────────────────────────────────────────────────────

describe('handleWarehouseSummary — success case', () => {
  it('returns 200 with aggregated stats for warehouse with tokens', async () => {
    const tokens = [
      makeToken('WH-LAGOS-01', { receipt: makeReceipt({ quantity: 100 }) }),
      makeToken('WH-LAGOS-01', { receipt: makeReceipt({ quantity: 50 }) }),
      makeToken('WH-LAGOS-01', { receipt: makeReceipt({ quantity: 75 }) }),
    ]

    const store = makeMockStore(new Map([['WH-LAGOS-01', tokens]]))

    const result = await handleWarehouseSummary('WH-LAGOS-01', store)

    expect(result.statusCode).toBe(200)
    expect(result.body.status).toBe('ok')

    const body = result.body as WarehouseSummaryOk
    expect(body.warehouseId).toBe('WH-LAGOS-01')
    expect(body.totalTokens).toBe(3)
    expect(body.totalWeight).toBe(225) // 100 + 50 + 75
    expect(body.unit).toBe('kg')
    expect(body.breakdown.minted).toBe(3)
  })

  it('correctly sums weight across different quantities', async () => {
    const tokens = [
      makeToken('WH-SESAME-02', {
        receipt: makeReceipt({ commodity: 'sesame', quantity: 1500.5 }),
      }),
      makeToken('WH-SESAME-02', {
        receipt: makeReceipt({ commodity: 'sesame', quantity: 2000.25 }),
      }),
    ]

    const store = makeMockStore(new Map([['WH-SESAME-02', tokens]]))

    const result = await handleWarehouseSummary('WH-SESAME-02', store)

    expect(result.statusCode).toBe(200)
    const body = result.body as WarehouseSummaryOk
    expect(body.totalWeight).toBeCloseTo(3500.75, 2)
    expect(body.totalTokens).toBe(2)
  })
})

// ─── 2. Empty warehouse ───────────────────────────────────────────────────────

describe('handleWarehouseSummary — empty warehouse', () => {
  it('returns 200 with zero counts for warehouse with no tokens', async () => {
    const store = makeMockStore(new Map())

    const result = await handleWarehouseSummary('WH-EMPTY-99', store)

    expect(result.statusCode).toBe(200)
    expect(result.body.status).toBe('ok')

    const body = result.body as WarehouseSummaryOk
    expect(body.warehouseId).toBe('WH-EMPTY-99')
    expect(body.totalTokens).toBe(0)
    expect(body.totalWeight).toBe(0)
    expect(body.breakdown.minted).toBe(0)
  })

  it('returns default unit for empty warehouse', async () => {
    const store = makeMockStore(new Map())

    const result = await handleWarehouseSummary('WH-EMPTY-99', store)

    const body = result.body as WarehouseSummaryOk
    expect(body.unit).toBe('kg') // Default unit
  })
})

// ─── 3. Idempotency ───────────────────────────────────────────────────────────

describe('handleWarehouseSummary — idempotency', () => {
  it('returns identical results on repeated calls', async () => {
    const tokens = [
      makeToken('WH-IDEMPOTENT', {
        receipt: makeReceipt({ quantity: 500 }),
      }),
      makeToken('WH-IDEMPOTENT', {
        receipt: makeReceipt({ quantity: 300 }),
      }),
    ]

    const store = makeMockStore(new Map([['WH-IDEMPOTENT', tokens]]))

    const result1 = await handleWarehouseSummary('WH-IDEMPOTENT', store)
    const result2 = await handleWarehouseSummary('WH-IDEMPOTENT', store)
    const result3 = await handleWarehouseSummary('WH-IDEMPOTENT', store)

    // All results should be identical
    expect(result1).toEqual(result2)
    expect(result2).toEqual(result3)

    const body = result1.body as WarehouseSummaryOk
    expect(body.totalWeight).toBe(800)
  })

  it('unchanged data produces identical response across calls', async () => {
    const tokens = [
      makeToken('WH-STABLE', {
        tokenId: 'token-stable-1',
        receipt: makeReceipt({ id: 'receipt-1', quantity: 100 }),
      }),
    ]

    const store = makeMockStore(new Map([['WH-STABLE', tokens]]))

    // Call multiple times
    const responses = await Promise.all([
      handleWarehouseSummary('WH-STABLE', store),
      handleWarehouseSummary('WH-STABLE', store),
      handleWarehouseSummary('WH-STABLE', store),
    ])

    // All responses must be identical
    expect(responses[0]).toEqual(responses[1])
    expect(responses[1]).toEqual(responses[2])
  })
})

// ─── 4. Invalid warehouse ID ──────────────────────────────────────────────────

describe('handleWarehouseSummary — error cases', () => {
  it('returns 400 for empty warehouse ID', async () => {
    const store = makeMockStore(new Map())

    const result = await handleWarehouseSummary('', store)

    expect(result.statusCode).toBe(400)
    expect(result.body.status).toBe('error')

    const body = result.body as WarehouseSummaryError
    expect(body.error).toContain('non-empty string')
  })

  it('returns 400 for null-like warehouse ID', async () => {
    const store = makeMockStore(new Map())

    const result = await handleWarehouseSummary(
      null as unknown as string,
      store
    )

    expect(result.statusCode).toBe(400)
    expect(result.body.status).toBe('error')
  })

  it('handles store errors gracefully', async () => {
    const brokenStore: WarehouseTokenStore = {
      getTokensByWarehouse: () => {
        throw new Error('Database connection failed')
      },
    }

    const result = await handleWarehouseSummary('WH-BROKEN', brokenStore)

    expect(result.statusCode).toBe(500)
    expect(result.body.status).toBe('error')

    const body = result.body as WarehouseSummaryError
    expect(body.error).toContain('Database connection failed')
  })
})

// ─── 5. Token aggregation correctness ──────────────────────────────────────────

describe('handleWarehouseSummary — aggregation correctness', () => {
  it('sums quantities correctly with fractional values', async () => {
    const tokens = [
      makeToken('WH-FRACTIONS', {
        receipt: makeReceipt({ quantity: 10.5 }),
      }),
      makeToken('WH-FRACTIONS', {
        receipt: makeReceipt({ quantity: 20.3 }),
      }),
      makeToken('WH-FRACTIONS', {
        receipt: makeReceipt({ quantity: 5.2 }),
      }),
    ]

    const store = makeMockStore(new Map([['WH-FRACTIONS', tokens]]))

    const result = await handleWarehouseSummary('WH-FRACTIONS', store)

    const body = result.body as WarehouseSummaryOk
    expect(body.totalWeight).toBeCloseTo(36, 1) // 10.5 + 20.3 + 5.2
    expect(body.totalTokens).toBe(3)
  })

  it('handles very large quantities', async () => {
    const tokens = [
      makeToken('WH-LARGE', {
        receipt: makeReceipt({ quantity: 1_000_000 }),
      }),
      makeToken('WH-LARGE', {
        receipt: makeReceipt({ quantity: 500_000 }),
      }),
    ]

    const store = makeMockStore(new Map([['WH-LARGE', tokens]]))

    const result = await handleWarehouseSummary('WH-LARGE', store)

    const body = result.body as WarehouseSummaryOk
    expect(body.totalWeight).toBe(1_500_000)
  })

  it('preserves unit from first token', async () => {
    const tokens = [
      makeToken('WH-UNITS', {
        receipt: makeReceipt({ unit: 'tonnes' }),
      }),
      makeToken('WH-UNITS', {
        receipt: makeReceipt({ unit: 'tonnes' }),
      }),
    ]

    const store = makeMockStore(new Map([['WH-UNITS', tokens]]))

    const result = await handleWarehouseSummary('WH-UNITS', store)

    const body = result.body as WarehouseSummaryOk
    expect(body.unit).toBe('tonnes')
  })
})

// ─── 6. Multiple warehouses ───────────────────────────────────────────────────

describe('handleWarehouseSummary — warehouse isolation', () => {
  it('only aggregates tokens belonging to requested warehouse', async () => {
    const warehouse1Tokens = [
      makeToken('WH-ISOLATED-1', {
        receipt: makeReceipt({ quantity: 100 }),
      }),
      makeToken('WH-ISOLATED-1', {
        receipt: makeReceipt({ quantity: 50 }),
      }),
    ]

    const warehouse2Tokens = [
      makeToken('WH-ISOLATED-2', {
        receipt: makeReceipt({ quantity: 1000 }),
      }),
    ]

    const store = makeMockStore(
      new Map([
        ['WH-ISOLATED-1', warehouse1Tokens],
        ['WH-ISOLATED-2', warehouse2Tokens],
      ])
    )

    const result1 = await handleWarehouseSummary('WH-ISOLATED-1', store)
    const result2 = await handleWarehouseSummary('WH-ISOLATED-2', store)

    const body1 = result1.body as WarehouseSummaryOk
    const body2 = result2.body as WarehouseSummaryOk

    expect(body1.totalTokens).toBe(2)
    expect(body1.totalWeight).toBe(150)

    expect(body2.totalTokens).toBe(1)
    expect(body2.totalWeight).toBe(1000)
  })
})
