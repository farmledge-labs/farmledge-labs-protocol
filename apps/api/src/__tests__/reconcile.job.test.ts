/**
 * Tests for reconcile.job.ts — STELLAR-5
 *
 * All tests are pure unit tests.  No real Stellar network is contacted.
 * The SDK query functions and FarmledgeClient are fully mocked.
 *
 * Coverage:
 *  1. No-op pass — all DB tokens match chain state, no corrections made.
 *  2. Owner drift — chain owner differs from DB, DB is corrected.
 *  3. Metadata drift — chain metadata differs from DB, DB is corrected.
 *  4. Combined drift — owner AND metadata drifted simultaneously.
 *  5. Token not found on chain — DB record is deleted.
 *  6. Per-token error (unexpected) — error recorded in summary, other tokens still processed.
 *  7. Empty store — nothing to do, summary has all zeros.
 *  8. Metadata query failure is non-fatal — owner still corrected.
 */

import {
  runReconciliation,
  type TokenStore,
  type ReconciliationDeps,
  type ReconciliationSummary,
} from '../jobs/reconcile.job'
import type { FarmledgeClient } from '@farmledge/protocol-sdk'
import type { TokenRecord, WarehouseReceipt } from '@farmledge/protocol-sdk'
import type { SesameTokenMetadata } from '@farmledge/protocol-sdk'

// ─── Test helpers ─────────────────────────────────────────────────────────────

/** Build a minimal WarehouseReceipt for test fixtures. */
function makeReceipt(overrides: Partial<WarehouseReceipt> = {}): WarehouseReceipt {
  return {
    id: 'SN-2024-000001',
    commodity: 'sesame',
    quantity: 500,
    unit: 'kg',
    gradeCode: 'GR-A',
    custodian: 'GABC1234',
    depositor: 'WH-LAGOS-01',
    issuedAt: 1_700_000_000_000,
    expiresAt: 0,
    ...overrides,
  }
}

/** Build a minimal TokenRecord for test fixtures. */
function makeTokenRecord(overrides: Partial<TokenRecord> = {}): TokenRecord {
  return {
    tokenId: 'SN-2024-000001',
    receipt: makeReceipt(),
    owner: 'GABC_OWNER_1',
    ...overrides,
  }
}

/**
 * Build a SesameTokenMetadata that is the chain-side counterpart to the
 * WarehouseReceipt produced by makeReceipt().
 */
function makeChainMeta(overrides: Partial<SesameTokenMetadata> = {}): SesameTokenMetadata {
  return {
    tokenId: 'SN-2024-000001',
    commodity: 'sesame',
    grade: 'GR-A',
    bagCount: 10,
    weightPerBagKg: 50,
    totalWeightKg: 500,
    warehouseId: 'WH-LAGOS-01',
    custodian: 'GABC1234',
    depositTs: BigInt(1_700_000_000),   // seconds — × 1000 = issuedAt in DB
    isLocked: false,
    parentTokenId: null,
    ...overrides,
  }
}

/**
 * Build a simple in-memory TokenStore backed by a Map.
 * Optionally pre-populated with initial records.
 */
function makeStore(initial: TokenRecord[] = []): TokenStore {
  const db = new Map<string, TokenRecord>(
    initial.map((r) => [r.tokenId, r])
  )
  return {
    listTokenIds: () => Array.from(db.keys()),
    getToken: (id) => db.get(id),
    setToken: (id, record) => { db.set(id, record) },
    deleteToken: (id) => { db.delete(id) },
  }
}

/** Typed shorthand for a jest mock matching QueryOwnerFn. */
type MockQueryOwner = jest.MockedFunction<ReconciliationDeps['queryOwner']>
/** Typed shorthand for a jest mock matching QueryTokenFn. */
type MockQueryToken = jest.MockedFunction<ReconciliationDeps['queryToken']>

/** Fake FarmledgeClient — tests never call real Stellar methods. */
const fakeClient = {} as FarmledgeClient

/** Build a default deps object with fresh mocks each test. */
function makeDeps(
  store: TokenStore,
  queryOwnerImpl: MockQueryOwner,
  queryTokenImpl: MockQueryToken
): ReconciliationDeps {
  return {
    client: fakeClient,
    store,
    queryOwner: queryOwnerImpl,
    queryToken: queryTokenImpl,
  }
}

// ─── 1. No-op pass ────────────────────────────────────────────────────────────

describe('runReconciliation — no drift', () => {
  it('returns zero corrections when chain state matches DB', async () => {
    const record = makeTokenRecord()
    const store = makeStore([record])

    const queryOwner = jest.fn().mockResolvedValue(record.owner) as MockQueryOwner
    const queryToken = jest.fn().mockResolvedValue(makeChainMeta()) as MockQueryToken

    const summary = await runReconciliation(makeDeps(store, queryOwner, queryToken))

    expect(summary.checked).toBe(1)
    expect(summary.ownerCorrected).toBe(0)
    expect(summary.metadataCorrected).toBe(0)
    expect(summary.deleted).toBe(0)
    expect(summary.errors).toHaveLength(0)
  })

  it('does not call setToken when nothing changed', async () => {
    const record = makeTokenRecord()
    const store = makeStore([record])
    const setTokenSpy = jest.spyOn(store, 'setToken')

    const queryOwner = jest.fn().mockResolvedValue(record.owner) as MockQueryOwner
    const queryToken = jest.fn().mockResolvedValue(makeChainMeta()) as MockQueryToken

    await runReconciliation(makeDeps(store, queryOwner, queryToken))

    expect(setTokenSpy).not.toHaveBeenCalled()
  })
})

// ─── 2. Owner drift ───────────────────────────────────────────────────────────

describe('runReconciliation — owner drift', () => {
  it('corrects the owner when chain owner differs from DB', async () => {
    const record = makeTokenRecord({ owner: 'GABC_STALE_OWNER' })
    const store = makeStore([record])
    const chainOwner = 'GXYZ_NEW_OWNER'

    const queryOwner = jest.fn().mockResolvedValue(chainOwner) as MockQueryOwner
    const queryToken = jest.fn().mockResolvedValue(makeChainMeta()) as MockQueryToken

    const summary = await runReconciliation(makeDeps(store, queryOwner, queryToken))

    expect(summary.ownerCorrected).toBe(1)
    expect(summary.metadataCorrected).toBe(0)
    expect(store.getToken(record.tokenId)!.owner).toBe(chainOwner)
  })

  it('increments ownerCorrected for each drifted token', async () => {
    const records = [
      makeTokenRecord({ tokenId: 'SN-2024-000001', owner: 'OLD_OWNER_1' }),
      makeTokenRecord({ tokenId: 'SN-2024-000002', owner: 'OLD_OWNER_2' }),
    ]
    const store = makeStore(records)

    const queryOwner = jest.fn()
      .mockResolvedValueOnce('NEW_OWNER_1')
      .mockResolvedValueOnce('NEW_OWNER_2') as MockQueryOwner
    const queryToken = jest.fn().mockResolvedValue(makeChainMeta()) as MockQueryToken

    const summary = await runReconciliation(makeDeps(store, queryOwner, queryToken))

    expect(summary.ownerCorrected).toBe(2)
    expect(store.getToken('SN-2024-000001')!.owner).toBe('NEW_OWNER_1')
    expect(store.getToken('SN-2024-000002')!.owner).toBe('NEW_OWNER_2')
  })
})

// ─── 3. Metadata drift ────────────────────────────────────────────────────────

describe('runReconciliation — metadata drift', () => {
  it('corrects metadata when chain grade differs from DB', async () => {
    const record = makeTokenRecord({
      receipt: makeReceipt({ gradeCode: 'GR-STALE' }),
    })
    const store = makeStore([record])

    const queryOwner = jest.fn().mockResolvedValue(record.owner) as MockQueryOwner
    const queryToken = jest.fn().mockResolvedValue(
      makeChainMeta({ grade: 'GR-A' })  // chain has the correct grade
    ) as MockQueryToken

    const summary = await runReconciliation(makeDeps(store, queryOwner, queryToken))

    expect(summary.metadataCorrected).toBe(1)
    expect(store.getToken(record.tokenId)!.receipt.gradeCode).toBe('GR-A')
  })

  it('corrects metadata when quantity (totalWeightKg) drifted', async () => {
    const record = makeTokenRecord({
      receipt: makeReceipt({ quantity: 100 }),  // stale weight
    })
    const store = makeStore([record])

    const queryOwner = jest.fn().mockResolvedValue(record.owner) as MockQueryOwner
    const queryToken = jest.fn().mockResolvedValue(
      makeChainMeta({ totalWeightKg: 500 })  // real weight on chain
    ) as MockQueryToken

    const summary = await runReconciliation(makeDeps(store, queryOwner, queryToken))

    expect(summary.metadataCorrected).toBe(1)
    expect(store.getToken(record.tokenId)!.receipt.quantity).toBe(500)
  })
})

// ─── 4. Combined drift ────────────────────────────────────────────────────────

describe('runReconciliation — combined owner + metadata drift', () => {
  it('corrects both owner and metadata in one pass', async () => {
    const record = makeTokenRecord({
      owner: 'OLD_OWNER',
      receipt: makeReceipt({ gradeCode: 'GR-BAD', quantity: 1 }),
    })
    const store = makeStore([record])

    const chainOwner = 'NEW_OWNER'
    const queryOwner = jest.fn().mockResolvedValue(chainOwner) as MockQueryOwner
    const queryToken = jest.fn().mockResolvedValue(
      makeChainMeta({ grade: 'GR-A', totalWeightKg: 500 })
    ) as MockQueryToken

    const summary = await runReconciliation(makeDeps(store, queryOwner, queryToken))

    expect(summary.ownerCorrected).toBe(1)
    expect(summary.metadataCorrected).toBe(1)

    const corrected = store.getToken(record.tokenId)!
    expect(corrected.owner).toBe(chainOwner)
    expect(corrected.receipt.gradeCode).toBe('GR-A')
    expect(corrected.receipt.quantity).toBe(500)
  })
})

// ─── 5. Token not found on chain ─────────────────────────────────────────────

describe('runReconciliation — token deleted on chain', () => {
  it('removes the DB record when chain reports TokenNotFound', async () => {
    const record = makeTokenRecord()
    const store = makeStore([record])

    const queryOwner = jest.fn().mockRejectedValue(
      new Error('get_owner simulation failed: TokenNotFound')
    ) as MockQueryOwner
    const queryToken = jest.fn() as MockQueryToken

    const summary = await runReconciliation(makeDeps(store, queryOwner, queryToken))

    expect(summary.deleted).toBe(1)
    expect(store.getToken(record.tokenId)).toBeUndefined()
    // queryToken should never be called — we already deleted on owner failure
    expect(queryToken).not.toHaveBeenCalled()
  })

  it('removes the DB record when chain reports Error(Contract, #1)', async () => {
    const record = makeTokenRecord()
    const store = makeStore([record])

    const queryOwner = jest.fn().mockRejectedValue(
      new Error('simulation failed: Error(Contract, #1)')
    ) as MockQueryOwner
    const queryToken = jest.fn() as MockQueryToken

    const summary = await runReconciliation(makeDeps(store, queryOwner, queryToken))

    expect(summary.deleted).toBe(1)
    expect(store.getToken(record.tokenId)).toBeUndefined()
  })
})

// ─── 6. Per-token unexpected error ───────────────────────────────────────────

describe('runReconciliation — per-token errors', () => {
  it('records error in summary and continues processing other tokens', async () => {
    const records = [
      makeTokenRecord({ tokenId: 'SN-2024-000001' }),
      makeTokenRecord({ tokenId: 'SN-2024-000002' }),
    ]
    const store = makeStore(records)

    // Second token has a different owner than DB ('OWNER_B' vs 'GABC_OWNER_1')
    const queryOwner = jest.fn()
      .mockRejectedValueOnce(new Error('RPC timeout'))  // first token fails
      .mockResolvedValueOnce('OWNER_B') as MockQueryOwner   // second succeeds, owner drifted
    const queryToken = jest.fn().mockResolvedValue(makeChainMeta()) as MockQueryToken

    const summary = await runReconciliation(makeDeps(store, queryOwner, queryToken))

    expect(summary.checked).toBe(2)
    expect(summary.errors).toHaveLength(1)
    expect(summary.errors[0]!.tokenId).toBe('SN-2024-000001')
    expect(summary.errors[0]!.error).toContain('RPC timeout')
    // Second token was still processed and owner corrected
    expect(summary.ownerCorrected).toBe(1)
  })

  it('continues when only metadata query fails — owner still corrected', async () => {
    const record = makeTokenRecord({ owner: 'OLD_OWNER' })
    const store = makeStore([record])

    const queryOwner = jest.fn().mockResolvedValue('NEW_OWNER') as MockQueryOwner
    const queryToken = jest.fn().mockRejectedValue(
      new Error('metadata unavailable')
    ) as MockQueryToken

    const summary = await runReconciliation(makeDeps(store, queryOwner, queryToken))

    // Owner was corrected despite metadata failure
    expect(summary.ownerCorrected).toBe(1)
    expect(store.getToken(record.tokenId)!.owner).toBe('NEW_OWNER')
    // Error recorded for metadata failure
    expect(summary.errors).toHaveLength(1)
    expect(summary.errors[0]!.error).toContain('metadata query failed')
  })
})

// ─── 7. Empty store ───────────────────────────────────────────────────────────

describe('runReconciliation — empty store', () => {
  it('returns all-zero summary when store is empty', async () => {
    const store = makeStore([])
    const queryOwner = jest.fn() as MockQueryOwner
    const queryToken = jest.fn() as MockQueryToken

    const summary = await runReconciliation(makeDeps(store, queryOwner, queryToken))

    const expected: ReconciliationSummary = {
      checked: 0,
      ownerCorrected: 0,
      metadataCorrected: 0,
      deleted: 0,
      errors: [],
    }
    expect(summary).toEqual(expected)
    expect(queryOwner).not.toHaveBeenCalled()
    expect(queryToken).not.toHaveBeenCalled()
  })
})

// ─── 8. Multiple tokens, only one drifted ────────────────────────────────────

describe('runReconciliation — selective correction', () => {
  it('only corrects the drifted token, leaves clean tokens untouched', async () => {
    const cleanRecord = makeTokenRecord({ tokenId: 'SN-2024-000001', owner: 'OWNER_CORRECT' })
    const driftedRecord = makeTokenRecord({ tokenId: 'SN-2024-000002', owner: 'OWNER_STALE' })
    const store = makeStore([cleanRecord, driftedRecord])

    const setTokenSpy = jest.spyOn(store, 'setToken')

    const queryOwner = (jest.fn()
      .mockResolvedValueOnce('OWNER_CORRECT')  // clean — no change
      .mockResolvedValueOnce('OWNER_UPDATED')) as unknown as MockQueryOwner  // drifted — correction needed
    const queryToken = jest.fn().mockResolvedValue(makeChainMeta()) as MockQueryToken

    const summary = await runReconciliation(makeDeps(store, queryOwner, queryToken))

    expect(summary.ownerCorrected).toBe(1)
    // setToken called only once, for the drifted token
    expect(setTokenSpy).toHaveBeenCalledTimes(1)
    expect(setTokenSpy).toHaveBeenCalledWith('SN-2024-000002', expect.objectContaining({
      owner: 'OWNER_UPDATED',
    }))

    // Clean record is untouched
    expect(store.getToken('SN-2024-000001')!.owner).toBe('OWNER_CORRECT')
  })
})
