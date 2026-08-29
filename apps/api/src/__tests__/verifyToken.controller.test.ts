/**
 * Tests for verifyToken.controller.ts — LEND-2
 *
 * All tests are pure unit tests. No real Stellar network or price feed is
 * contacted. All external dependencies are fully injected mocks.
 *
 * Coverage:
 *  1.  Happy path — chain matches DB, returns 200 with full report.
 *  2.  Chain returns TokenNotFound — returns 404.
 *  3.  Chain owner query throws unexpected error — returns 502.
 *  4.  Chain metadata query throws — returns 502.
 *  5.  Owner drift — detected and surfaced in report.drift.
 *  6.  Metadata drift (grade) — detected and surfaced.
 *  7.  Metadata drift (quantity) — detected and surfaced.
 *  8.  Multiple drift fields simultaneously.
 *  9.  Token locked — isLocked: true in report.
 *  10. Token not in DB — dbRecord: null, drift: [].
 *  11. estimatedValueNgn — computed correctly from weight × price.
 *  12. Price fallback flag propagated to report.
 *  13. Custodian not approved — custodianApproved: false.
 *  14. Warehouse not certified — warehouseCertValid: false.
 *  15. Empty tokenId — returns 400.
 *  16. Whitespace-only tokenId — returns 400.
 */

import {
  handleVerifyToken,
  type VerifyTokenDeps,
  type TokenStore,
  type CustodianRegistry,
  type WarehouseRegistry,
  type VerificationReport,
} from '../controllers/verifyToken.controller'
import type { FarmledgeClient, TokenRecord, WarehouseReceipt } from '@farmledge/protocol-sdk'
import type { SesameTokenMetadata } from '@farmledge/protocol-sdk'
import type { CommodityPrice } from '../services/priceOracle.service'

// ─── Test fixtures ────────────────────────────────────────────────────────────

const TOKEN_ID = 'SN-2026-000001'
const OWNER = 'GABC_OWNER_123456'
const CUSTODIAN = 'GCUST_APPROVED_999'
const WAREHOUSE_ID = 'WH-KANO-01'

function makeChainMeta(overrides: Partial<SesameTokenMetadata> = {}): SesameTokenMetadata {
  return {
    tokenId: TOKEN_ID,
    commodity: 'SESAME',
    grade: 'GRADE_A',
    bagCount: 20,
    weightPerBagKg: 25,
    totalWeightKg: 500,
    warehouseId: WAREHOUSE_ID,
    custodian: CUSTODIAN,
    depositTs: BigInt(1_750_000_000),
    isLocked: false,
    parentTokenId: null,
    ...overrides,
  }
}

function makeReceipt(overrides: Partial<WarehouseReceipt> = {}): WarehouseReceipt {
  return {
    id: TOKEN_ID,
    commodity: 'SESAME',
    quantity: 500,
    unit: 'kg',
    gradeCode: 'GRADE_A',
    custodian: CUSTODIAN,
    depositor: WAREHOUSE_ID,
    issuedAt: 1_750_000_000_000,
    expiresAt: 0,
    ...overrides,
  }
}

function makeDbRecord(overrides: Partial<TokenRecord> = {}): TokenRecord {
  return {
    tokenId: TOKEN_ID,
    receipt: makeReceipt(),
    owner: OWNER,
    ...overrides,
  }
}

function makePrice(overrides: Partial<CommodityPrice> = {}): CommodityPrice {
  return {
    commodity: 'SESAME',
    priceNgnPerKg: 1800,
    fetchedAt: new Date().toISOString(),
    isFallback: true,
    ...overrides,
  }
}

/** In-memory store backed by an optional pre-populated record. */
function makeStore(record?: TokenRecord): TokenStore {
  return {
    getToken: (id: string) => (record && record.tokenId === id ? record : undefined),
  }
}

/** Registry that approves only a specific address. */
function makeCustodianRegistry(approvedAddress = CUSTODIAN): CustodianRegistry {
  return { isApproved: (addr) => addr === approvedAddress }
}

/** Registry that certifies only a specific warehouse ID. */
function makeWarehouseRegistry(certifiedId = WAREHOUSE_ID): WarehouseRegistry {
  return { isCertified: (id) => id === certifiedId }
}

const fakeClient = {} as FarmledgeClient

type MockQueryOwner = jest.MockedFunction<VerifyTokenDeps['queryOwner']>
type MockQueryToken = jest.MockedFunction<VerifyTokenDeps['queryToken']>
type MockLookupPrice = jest.MockedFunction<VerifyTokenDeps['lookupPrice']>

function makeDeps(overrides: Partial<VerifyTokenDeps> = {}): VerifyTokenDeps {
  return {
    client: fakeClient,
    store: makeStore(makeDbRecord()),
    custodianRegistry: makeCustodianRegistry(),
    warehouseRegistry: makeWarehouseRegistry(),
    queryOwner: jest.fn().mockResolvedValue(OWNER) as MockQueryOwner,
    queryToken: jest.fn().mockResolvedValue(makeChainMeta()) as MockQueryToken,
    lookupPrice: jest.fn().mockResolvedValue(makePrice()) as MockLookupPrice,
    ...overrides,
  }
}

// ─── 1. Happy path ────────────────────────────────────────────────────────────

describe('handleVerifyToken — happy path', () => {
  it('returns statusCode 200', async () => {
    const result = await handleVerifyToken(TOKEN_ID, makeDeps())
    expect(result.statusCode).toBe(200)
  })

  it('body.tokenId matches the requested token', async () => {
    const result = await handleVerifyToken(TOKEN_ID, makeDeps())
    expect(result.statusCode).toBe(200)
    const body = result.body as VerificationReport
    expect(body.tokenId).toBe(TOKEN_ID)
  })

  it('body.chainMeta is the live on-chain metadata', async () => {
    const meta = makeChainMeta()
    const deps = makeDeps({
      queryToken: jest.fn().mockResolvedValue(meta) as MockQueryToken,
    })
    const result = await handleVerifyToken(TOKEN_ID, deps)
    expect(result.statusCode).toBe(200)
    expect((result.body as VerificationReport).chainMeta).toEqual(meta)
  })

  it('body.chainOwner is the live on-chain owner', async () => {
    const result = await handleVerifyToken(TOKEN_ID, makeDeps())
    expect((result.body as VerificationReport).chainOwner).toBe(OWNER)
  })

  it('body.dbRecord is populated from the store', async () => {
    const record = makeDbRecord()
    const deps = makeDeps({ store: makeStore(record) })
    const result = await handleVerifyToken(TOKEN_ID, deps)
    expect((result.body as VerificationReport).dbRecord).toEqual(record)
  })

  it('body.drift is empty when DB matches chain', async () => {
    const result = await handleVerifyToken(TOKEN_ID, makeDeps())
    expect((result.body as VerificationReport).drift).toHaveLength(0)
  })

  it('body.custodianApproved is true for a registered custodian', async () => {
    const result = await handleVerifyToken(TOKEN_ID, makeDeps())
    expect((result.body as VerificationReport).custodianApproved).toBe(true)
  })

  it('body.warehouseCertValid is true for a certified warehouse', async () => {
    const result = await handleVerifyToken(TOKEN_ID, makeDeps())
    expect((result.body as VerificationReport).warehouseCertValid).toBe(true)
  })

  it('body.isLocked is false for an unlocked token', async () => {
    const result = await handleVerifyToken(TOKEN_ID, makeDeps())
    expect((result.body as VerificationReport).isLocked).toBe(false)
  })
})

// ─── 2. Token not found on chain ─────────────────────────────────────────────

describe('handleVerifyToken — token not found', () => {
  it('returns 404 when chain reports TokenNotFound', async () => {
    const deps = makeDeps({
      queryOwner: jest.fn().mockRejectedValue(
        new Error('get_owner simulation failed: TokenNotFound')
      ) as MockQueryOwner,
    })
    const result = await handleVerifyToken(TOKEN_ID, deps)
    expect(result.statusCode).toBe(404)
  })

  it('returns 404 when chain reports Error(Contract, #1)', async () => {
    const deps = makeDeps({
      queryOwner: jest.fn().mockRejectedValue(
        new Error('simulation failed: Error(Contract, #1)')
      ) as MockQueryOwner,
    })
    const result = await handleVerifyToken(TOKEN_ID, deps)
    expect(result.statusCode).toBe(404)
  })

  it('body.tokenId is echoed in the 404 response', async () => {
    const deps = makeDeps({
      queryOwner: jest.fn().mockRejectedValue(
        new Error('TokenNotFound')
      ) as MockQueryOwner,
    })
    const result = await handleVerifyToken(TOKEN_ID, deps)
    expect(result.body).toMatchObject({ tokenId: TOKEN_ID })
  })
})

// ─── 3. Chain owner query — unexpected error ──────────────────────────────────

describe('handleVerifyToken — chain owner query fails', () => {
  it('returns 502 on unexpected owner query error', async () => {
    const deps = makeDeps({
      queryOwner: jest.fn().mockRejectedValue(
        new Error('RPC timeout')
      ) as MockQueryOwner,
    })
    const result = await handleVerifyToken(TOKEN_ID, deps)
    expect(result.statusCode).toBe(502)
  })

  it('body.error contains the underlying error message', async () => {
    const deps = makeDeps({
      queryOwner: jest.fn().mockRejectedValue(
        new Error('connection refused')
      ) as MockQueryOwner,
    })
    const result = await handleVerifyToken(TOKEN_ID, deps)
    expect(result.body).toMatchObject({ error: expect.stringContaining('connection refused') })
  })
})

// ─── 4. Chain metadata query fails ───────────────────────────────────────────

describe('handleVerifyToken — chain metadata query fails', () => {
  it('returns 502 when metadata query throws', async () => {
    const deps = makeDeps({
      queryToken: jest.fn().mockRejectedValue(
        new Error('soroban node unavailable')
      ) as MockQueryToken,
    })
    const result = await handleVerifyToken(TOKEN_ID, deps)
    expect(result.statusCode).toBe(502)
  })

  it('body.error contains the metadata failure message', async () => {
    const deps = makeDeps({
      queryToken: jest.fn().mockRejectedValue(
        new Error('metadata unavailable')
      ) as MockQueryToken,
    })
    const result = await handleVerifyToken(TOKEN_ID, deps)
    expect(result.body).toMatchObject({
      error: expect.stringContaining('metadata unavailable'),
    })
  })
})

// ─── 5. Owner drift ───────────────────────────────────────────────────────────

describe('handleVerifyToken — owner drift', () => {
  it('surfaces owner drift in body.drift', async () => {
    const staleOwner = 'GSTALE_OWNER_OLD'
    const chainOwner = 'GNEW_OWNER_LIVE'
    const deps = makeDeps({
      store: makeStore(makeDbRecord({ owner: staleOwner })),
      queryOwner: jest.fn().mockResolvedValue(chainOwner) as MockQueryOwner,
    })
    const result = await handleVerifyToken(TOKEN_ID, deps)
    expect(result.statusCode).toBe(200)
    const body = result.body as VerificationReport
    const ownerDrift = body.drift.find((d) => d.field === 'owner')
    expect(ownerDrift).toBeDefined()
    expect(ownerDrift!.dbValue).toBe(staleOwner)
    expect(ownerDrift!.chainValue).toBe(chainOwner)
  })
})

// ─── 6. Metadata drift — grade ───────────────────────────────────────────────

describe('handleVerifyToken — grade drift', () => {
  it('surfaces gradeCode drift in body.drift', async () => {
    const deps = makeDeps({
      store: makeStore(makeDbRecord({ receipt: makeReceipt({ gradeCode: 'GRADE_B' }) })),
      queryToken: jest.fn().mockResolvedValue(makeChainMeta({ grade: 'GRADE_A' })) as MockQueryToken,
    })
    const result = await handleVerifyToken(TOKEN_ID, deps)
    expect(result.statusCode).toBe(200)
    const body = result.body as VerificationReport
    const gradeDrift = body.drift.find((d) => d.field === 'gradeCode')
    expect(gradeDrift).toBeDefined()
    expect(gradeDrift!.dbValue).toBe('GRADE_B')
    expect(gradeDrift!.chainValue).toBe('GRADE_A')
  })
})

// ─── 7. Metadata drift — quantity ────────────────────────────────────────────

describe('handleVerifyToken — quantity drift', () => {
  it('surfaces quantity drift in body.drift', async () => {
    const deps = makeDeps({
      store: makeStore(makeDbRecord({ receipt: makeReceipt({ quantity: 100 }) })),
      queryToken: jest.fn().mockResolvedValue(makeChainMeta({ totalWeightKg: 500 })) as MockQueryToken,
    })
    const result = await handleVerifyToken(TOKEN_ID, deps)
    const body = result.body as VerificationReport
    const qtyDrift = body.drift.find((d) => d.field === 'quantity')
    expect(qtyDrift).toBeDefined()
    expect(qtyDrift!.dbValue).toBe(100)
    expect(qtyDrift!.chainValue).toBe(500)
  })
})

// ─── 8. Multiple drift fields ─────────────────────────────────────────────────

describe('handleVerifyToken — multiple drift fields', () => {
  it('reports all drifted fields in body.drift', async () => {
    const deps = makeDeps({
      store: makeStore(makeDbRecord({
        owner: 'OLD_OWNER',
        receipt: makeReceipt({ gradeCode: 'GRADE_C', quantity: 1 }),
      })),
      queryOwner: jest.fn().mockResolvedValue('NEW_OWNER') as MockQueryOwner,
      queryToken: jest.fn().mockResolvedValue(
        makeChainMeta({ grade: 'GRADE_A', totalWeightKg: 500 })
      ) as MockQueryToken,
    })
    const result = await handleVerifyToken(TOKEN_ID, deps)
    const body = result.body as VerificationReport
    const fields = body.drift.map((d) => d.field)
    expect(fields).toContain('owner')
    expect(fields).toContain('gradeCode')
    expect(fields).toContain('quantity')
    expect(body.drift.length).toBeGreaterThanOrEqual(3)
  })
})

// ─── 9. Locked token ──────────────────────────────────────────────────────────

describe('handleVerifyToken — locked token', () => {
  it('body.isLocked is true when chain reports isLocked', async () => {
    const deps = makeDeps({
      queryToken: jest.fn().mockResolvedValue(
        makeChainMeta({ isLocked: true })
      ) as MockQueryToken,
    })
    const result = await handleVerifyToken(TOKEN_ID, deps)
    expect(result.statusCode).toBe(200)
    expect((result.body as VerificationReport).isLocked).toBe(true)
  })
})

// ─── 10. Token not in DB ──────────────────────────────────────────────────────

describe('handleVerifyToken — token absent from DB', () => {
  it('body.dbRecord is null when store has no record', async () => {
    const deps = makeDeps({ store: makeStore() }) // empty store
    const result = await handleVerifyToken(TOKEN_ID, deps)
    expect(result.statusCode).toBe(200)
    expect((result.body as VerificationReport).dbRecord).toBeNull()
  })

  it('body.drift is empty when token is not in DB', async () => {
    const deps = makeDeps({ store: makeStore() })
    const result = await handleVerifyToken(TOKEN_ID, deps)
    expect((result.body as VerificationReport).drift).toHaveLength(0)
  })
})

// ─── 11. estimatedValueNgn ────────────────────────────────────────────────────

describe('handleVerifyToken — estimatedValueNgn', () => {
  it('computes estimatedValueNgn = totalWeightKg × priceNgnPerKg', async () => {
    const deps = makeDeps({
      queryToken: jest.fn().mockResolvedValue(
        makeChainMeta({ totalWeightKg: 500 })
      ) as MockQueryToken,
      lookupPrice: jest.fn().mockResolvedValue(
        makePrice({ priceNgnPerKg: 1800 })
      ) as MockLookupPrice,
    })
    const result = await handleVerifyToken(TOKEN_ID, deps)
    expect(result.statusCode).toBe(200)
    expect((result.body as VerificationReport).estimatedValueNgn).toBe(900_000)
  })

  it('rounds estimatedValueNgn to nearest integer', async () => {
    const deps = makeDeps({
      queryToken: jest.fn().mockResolvedValue(
        makeChainMeta({ totalWeightKg: 3 })
      ) as MockQueryToken,
      lookupPrice: jest.fn().mockResolvedValue(
        makePrice({ priceNgnPerKg: 1800.7 })
      ) as MockLookupPrice,
    })
    const result = await handleVerifyToken(TOKEN_ID, deps)
    const body = result.body as VerificationReport
    expect(Number.isInteger(body.estimatedValueNgn)).toBe(true)
  })

  it('body.priceNgnPerKg matches what the price oracle returned', async () => {
    const deps = makeDeps({
      lookupPrice: jest.fn().mockResolvedValue(
        makePrice({ priceNgnPerKg: 320 })
      ) as MockLookupPrice,
    })
    const result = await handleVerifyToken(TOKEN_ID, deps)
    expect((result.body as VerificationReport).priceNgnPerKg).toBe(320)
  })
})

// ─── 12. Price fallback flag ──────────────────────────────────────────────────

describe('handleVerifyToken — price fallback flag', () => {
  it('body.priceIsFallback is true when oracle returns fallback price', async () => {
    const deps = makeDeps({
      lookupPrice: jest.fn().mockResolvedValue(
        makePrice({ isFallback: true })
      ) as MockLookupPrice,
    })
    const result = await handleVerifyToken(TOKEN_ID, deps)
    expect((result.body as VerificationReport).priceIsFallback).toBe(true)
  })

  it('body.priceIsFallback is false when oracle returns live price', async () => {
    const deps = makeDeps({
      lookupPrice: jest.fn().mockResolvedValue(
        makePrice({ isFallback: false })
      ) as MockLookupPrice,
    })
    const result = await handleVerifyToken(TOKEN_ID, deps)
    expect((result.body as VerificationReport).priceIsFallback).toBe(false)
  })
})

// ─── 13. Custodian not approved ───────────────────────────────────────────────

describe('handleVerifyToken — custodian not approved', () => {
  it('body.custodianApproved is false for an unregistered custodian', async () => {
    const deps = makeDeps({
      custodianRegistry: { isApproved: () => false },
    })
    const result = await handleVerifyToken(TOKEN_ID, deps)
    expect(result.statusCode).toBe(200)
    expect((result.body as VerificationReport).custodianApproved).toBe(false)
  })
})

// ─── 14. Warehouse not certified ─────────────────────────────────────────────

describe('handleVerifyToken — warehouse not certified', () => {
  it('body.warehouseCertValid is false for an uncertified warehouse', async () => {
    const deps = makeDeps({
      warehouseRegistry: { isCertified: () => false },
    })
    const result = await handleVerifyToken(TOKEN_ID, deps)
    expect(result.statusCode).toBe(200)
    expect((result.body as VerificationReport).warehouseCertValid).toBe(false)
  })
})

// ─── 15 & 16. Invalid tokenId ────────────────────────────────────────────────

describe('handleVerifyToken — invalid tokenId', () => {
  it('returns 400 for an empty string', async () => {
    const result = await handleVerifyToken('', makeDeps())
    expect(result.statusCode).toBe(400)
  })

  it('returns 400 for a whitespace-only string', async () => {
    const result = await handleVerifyToken('   ', makeDeps())
    expect(result.statusCode).toBe(400)
  })

  it('body.error is non-empty for invalid tokenId', async () => {
    const result = await handleVerifyToken('', makeDeps())
    expect(result.body).toMatchObject({ error: expect.stringMatching(/.+/) })
  })
})
