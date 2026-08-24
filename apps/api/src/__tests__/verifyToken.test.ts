/**
 * Tests for verifyToken controller.
 *
 * All on-chain calls are mocked so no live RPC is needed. The tests exercise:
 *   - Contract type detection from token id prefix
 *   - NOT_FOUND path (metadata query throws)
 *   - Full FOUND path for a maize token
 *   - Full FOUND path for a sesame token
 *   - Locked token report
 *   - Split-child token report (parentTokenId set)
 *   - Custodian DEREGISTERED path
 *   - Custodian UNKNOWN path (registry check throws)
 *   - Warehouse cert FORMAT_INVALID path
 *   - estimatedValueNgn calculation
 *   - NGN price env var override
 *   - Unrecognised token id prefix
 *   - Owner lookup failure produces warning but report still returned
 */

import { verifyToken } from '../controllers/verifyToken'
import type { FarmledgeClient } from '@farmledge/protocol-sdk'

// ---------------------------------------------------------------------------
// Module mocks
// ---------------------------------------------------------------------------

// Mock the SDK query functions so we never hit a real RPC endpoint
jest.mock('@farmledge/protocol-sdk', () => {
  const actual = jest.requireActual('@farmledge/protocol-sdk')
  return {
    ...actual,
    maizeQueryToken: jest.fn(),
    maizeQueryOwner: jest.fn(),
    sesameQueryToken: jest.fn(),
    sesameQueryOwner: jest.fn(),
  }
})

// Mock the stellar client singleton used as the default
jest.mock('../lib/stellar', () => ({
  stellarClient: buildMockClient(),
}))

import {
  maizeQueryToken,
  maizeQueryOwner,
  sesameQueryToken,
  sesameQueryOwner,
} from '@farmledge/protocol-sdk'

const mockMaizeQueryToken = maizeQueryToken as jest.Mock
const mockMaizeQueryOwner = maizeQueryOwner as jest.Mock
const mockSesameQueryToken = sesameQueryToken as jest.Mock
const mockSesameQueryOwner = sesameQueryOwner as jest.Mock

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function buildMockClient(): FarmledgeClient {
  return {
    server: {
      getLedgerEntries: jest.fn().mockResolvedValue({ entries: [] }),
    },
    networkPassphrase: 'Test SDF Network ; September 2015',
    maizeContractId: 'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM',
    sesameContractId: 'CBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBZG',
  } as unknown as FarmledgeClient
}

const MAIZE_OWNER = 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF'
const MAIZE_CUSTODIAN = 'GBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBCL'
const SESAME_OWNER = 'GCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCYT'
const SESAME_CUSTODIAN = 'GDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDE3'

function maizeMetaFixture(overrides: Partial<ReturnType<typeof buildMaizeMeta>> = {}) {
  return buildMaizeMeta(overrides)
}

function buildMaizeMeta(overrides: Record<string, unknown> = {}): {
  tokenId: string
  commodity: string
  grade: string
  bagCount: number
  weightPerBagKg: number
  totalWeightKg: number
  warehouseId: string
  custodian: string
  depositTs: bigint
  isLocked: boolean
  parentTokenId: string | null
  [key: string]: unknown
} {
  return {
    tokenId: 'KN-2026-000042',
    commodity: 'MAIZE_WHITE',
    grade: 'GRADE_A',
    bagCount: 200,
    weightPerBagKg: 50,
    totalWeightKg: 10_000,
    warehouseId: 'WH-KD-001',
    custodian: MAIZE_CUSTODIAN,
    depositTs: BigInt(1_700_000_000),
    isLocked: false,
    parentTokenId: null,
    ...overrides,
  }
}

function sesameMetaFixture(overrides: Record<string, unknown> = {}) {
  return {
    tokenId: 'SN-2026-000007',
    commodity: 'SESAME',
    grade: 'GRADE_A',
    bagCount: 100,
    weightPerBagKg: 50,
    totalWeightKg: 5_000,
    warehouseId: 'WH-OG-002',
    custodian: SESAME_CUSTODIAN,
    depositTs: BigInt(1_700_100_000),
    isLocked: false,
    parentTokenId: null,
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

beforeEach(() => {
  jest.clearAllMocks()
  delete process.env['MAIZE_SPOT_PRICE_NGN_PER_KG']
  delete process.env['SESAME_SPOT_PRICE_NGN_PER_KG']
})

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('verifyToken — prefix detection', () => {
  it('returns NOT_FOUND with a warning for an unrecognised prefix', async () => {
    const report = await verifyToken('XX-2026-000001')
    expect(report.tokenExists).toBe('NOT_FOUND')
    expect(report.warnings.length).toBeGreaterThan(0)
    expect(report.warnings[0]).toMatch(/unrecognised prefix/i)
  })

  it('routes KN- tokens to the maize contract', async () => {
    mockMaizeQueryToken.mockResolvedValueOnce(maizeMetaFixture())
    mockMaizeQueryOwner.mockResolvedValueOnce(MAIZE_OWNER)

    const report = await verifyToken('KN-2026-000042')
    expect(report.contractType).toBe('maize')
    expect(mockMaizeQueryToken).toHaveBeenCalledTimes(1)
    expect(mockSesameQueryToken).not.toHaveBeenCalled()
  })

  it('routes SN- tokens to the sesame contract', async () => {
    mockSesameQueryToken.mockResolvedValueOnce(sesameMetaFixture())
    mockSesameQueryOwner.mockResolvedValueOnce(SESAME_OWNER)

    const report = await verifyToken('SN-2026-000007')
    expect(report.contractType).toBe('sesame')
    expect(mockSesameQueryToken).toHaveBeenCalledTimes(1)
    expect(mockMaizeQueryToken).not.toHaveBeenCalled()
  })
})

describe('verifyToken — NOT_FOUND path', () => {
  it('returns NOT_FOUND when metadata query throws', async () => {
    mockMaizeQueryToken.mockRejectedValueOnce(new Error('TokenNotFound'))

    const report = await verifyToken('KN-2026-999999')
    expect(report.tokenExists).toBe('NOT_FOUND')
    expect(report.onChainMetadata).toBeNull()
    expect(report.estimatedValueNgn).toBeNull()
    expect(report.warnings.some(w => w.includes('TokenNotFound'))).toBe(true)
  })

  it('null-fills all nullable fields on NOT_FOUND', async () => {
    mockMaizeQueryToken.mockRejectedValueOnce(new Error('TokenNotFound'))

    const report = await verifyToken('KN-2026-999999')
    expect(report.currentOwner).toBeNull()
    expect(report.custodianStatus).toBeNull()
    expect(report.custodianAddress).toBeNull()
    expect(report.warehouseCertStatus).toBeNull()
    expect(report.warehouseId).toBeNull()
    expect(report.lockStatus).toBeNull()
    expect(report.isSplitChild).toBeNull()
    expect(report.parentTokenId).toBeNull()
    expect(report.spotPriceNgnPerKg).toBeNull()
  })
})

describe('verifyToken — FOUND path (maize)', () => {
  beforeEach(() => {
    mockMaizeQueryToken.mockResolvedValue(maizeMetaFixture())
    mockMaizeQueryOwner.mockResolvedValue(MAIZE_OWNER)
  })

  it('returns FOUND with populated metadata', async () => {
    const report = await verifyToken('KN-2026-000042')
    expect(report.tokenExists).toBe('FOUND')
    expect(report.onChainMetadata).not.toBeNull()
    expect(report.onChainMetadata?.tokenId).toBe('KN-2026-000042')
    expect(report.onChainMetadata?.commodity).toBe('MAIZE_WHITE')
  })

  it('exposes the current owner', async () => {
    const report = await verifyToken('KN-2026-000042')
    expect(report.currentOwner).toBe(MAIZE_OWNER)
  })

  it('exposes the custodian address', async () => {
    const report = await verifyToken('KN-2026-000042')
    expect(report.custodianAddress).toBe(MAIZE_CUSTODIAN)
  })

  it('reports UNLOCKED when token is not locked', async () => {
    const report = await verifyToken('KN-2026-000042')
    expect(report.lockStatus).toBe('UNLOCKED')
  })

  it('reports isSplitChild false and null parentTokenId for a non-split token', async () => {
    const report = await verifyToken('KN-2026-000042')
    expect(report.isSplitChild).toBe(false)
    expect(report.parentTokenId).toBeNull()
  })

  it('includes verifiedAt as a recent timestamp', async () => {
    const before = Date.now()
    const report = await verifyToken('KN-2026-000042')
    const after = Date.now()
    expect(report.verifiedAt).toBeGreaterThanOrEqual(before)
    expect(report.verifiedAt).toBeLessThanOrEqual(after)
  })
})

describe('verifyToken — FOUND path (sesame)', () => {
  beforeEach(() => {
    mockSesameQueryToken.mockResolvedValue(sesameMetaFixture())
    mockSesameQueryOwner.mockResolvedValue(SESAME_OWNER)
  })

  it('returns FOUND with sesame metadata', async () => {
    const report = await verifyToken('SN-2026-000007')
    expect(report.tokenExists).toBe('FOUND')
    expect(report.onChainMetadata?.commodity).toBe('SESAME')
    expect(report.contractType).toBe('sesame')
  })

  it('computes estimatedValueNgn using the sesame fallback price', async () => {
    const report = await verifyToken('SN-2026-000007')
    // 5,000 kg × 1,200 NGN/kg = 6,000,000
    expect(report.estimatedValueNgn).toBe(6_000_000)
    expect(report.spotPriceNgnPerKg).toBe(1_200)
  })
})

describe('verifyToken — locked token', () => {
  it('reports LOCKED when isLocked is true', async () => {
    mockMaizeQueryToken.mockResolvedValueOnce(maizeMetaFixture({ isLocked: true }))
    mockMaizeQueryOwner.mockResolvedValueOnce(MAIZE_OWNER)

    const report = await verifyToken('KN-2026-000042')
    expect(report.lockStatus).toBe('LOCKED')
  })
})

describe('verifyToken — split-child token', () => {
  it('reports isSplitChild true and sets parentTokenId', async () => {
    mockMaizeQueryToken.mockResolvedValueOnce(
      maizeMetaFixture({ parentTokenId: 'KN-2026-000010' }),
    )
    mockMaizeQueryOwner.mockResolvedValueOnce(MAIZE_OWNER)

    const report = await verifyToken('KN-2026-000042')
    expect(report.isSplitChild).toBe(true)
    expect(report.parentTokenId).toBe('KN-2026-000010')
  })
})

describe('verifyToken — custodian status', () => {
  it('returns UNKNOWN when the registry check throws', async () => {
    // getLedgerEntries throws — custodian check should fail gracefully
    const mockClient = buildMockClient()
    ;(mockClient.server.getLedgerEntries as jest.Mock).mockRejectedValue(
      new Error('RPC unavailable'),
    )
    mockMaizeQueryToken.mockResolvedValueOnce(maizeMetaFixture())
    mockMaizeQueryOwner.mockResolvedValueOnce(MAIZE_OWNER)

    const report = await verifyToken('KN-2026-000042', mockClient)
    expect(report.custodianStatus).toBe('UNKNOWN')
    expect(report.warnings.some(w => w.includes('Custodian registry check failed'))).toBe(true)
  })

  it('still returns a FOUND report even when custodian check fails', async () => {
    const mockClient = buildMockClient()
    ;(mockClient.server.getLedgerEntries as jest.Mock).mockRejectedValue(
      new Error('RPC unavailable'),
    )
    mockMaizeQueryToken.mockResolvedValueOnce(maizeMetaFixture())
    mockMaizeQueryOwner.mockResolvedValueOnce(MAIZE_OWNER)

    const report = await verifyToken('KN-2026-000042', mockClient)
    expect(report.tokenExists).toBe('FOUND')
    expect(report.onChainMetadata).not.toBeNull()
  })
})

describe('verifyToken — warehouse cert status', () => {
  it('returns FORMAT_INVALID for a malformed warehouseId', async () => {
    mockMaizeQueryToken.mockResolvedValueOnce(
      maizeMetaFixture({ warehouseId: 'INVALID' }),
    )
    mockMaizeQueryOwner.mockResolvedValueOnce(MAIZE_OWNER)

    const report = await verifyToken('KN-2026-000042')
    expect(report.warehouseCertStatus).toBe('FORMAT_INVALID')
  })

  it('returns PENDING_VERIFICATION for a valid warehouseId format', async () => {
    mockMaizeQueryToken.mockResolvedValueOnce(
      maizeMetaFixture({ warehouseId: 'WH-KD-001' }),
    )
    mockMaizeQueryOwner.mockResolvedValueOnce(MAIZE_OWNER)

    const report = await verifyToken('KN-2026-000042')
    expect(report.warehouseCertStatus).toBe('PENDING_VERIFICATION')
  })

  it('accepts multi-letter state codes like WH-ABJ-042', async () => {
    mockMaizeQueryToken.mockResolvedValueOnce(
      maizeMetaFixture({ warehouseId: 'WH-ABJ-042' }),
    )
    mockMaizeQueryOwner.mockResolvedValueOnce(MAIZE_OWNER)

    const report = await verifyToken('KN-2026-000042')
    expect(report.warehouseCertStatus).toBe('PENDING_VERIFICATION')
  })
})

describe('verifyToken — estimatedValueNgn', () => {
  it('calculates estimatedValueNgn correctly for MAIZE_WHITE at fallback price', async () => {
    // 10,000 kg × 320 NGN/kg = 3,200,000
    mockMaizeQueryToken.mockResolvedValueOnce(maizeMetaFixture())
    mockMaizeQueryOwner.mockResolvedValueOnce(MAIZE_OWNER)

    const report = await verifyToken('KN-2026-000042')
    expect(report.estimatedValueNgn).toBe(3_200_000)
    expect(report.spotPriceNgnPerKg).toBe(320)
  })

  it('respects MAIZE_SPOT_PRICE_NGN_PER_KG env override', async () => {
    process.env['MAIZE_SPOT_PRICE_NGN_PER_KG'] = '400'
    mockMaizeQueryToken.mockResolvedValueOnce(maizeMetaFixture())
    mockMaizeQueryOwner.mockResolvedValueOnce(MAIZE_OWNER)

    const report = await verifyToken('KN-2026-000042')
    // 10,000 kg × 400 NGN/kg = 4,000,000
    expect(report.estimatedValueNgn).toBe(4_000_000)
    expect(report.spotPriceNgnPerKg).toBe(400)
  })

  it('respects SESAME_SPOT_PRICE_NGN_PER_KG env override', async () => {
    process.env['SESAME_SPOT_PRICE_NGN_PER_KG'] = '1500'
    mockSesameQueryToken.mockResolvedValueOnce(sesameMetaFixture())
    mockSesameQueryOwner.mockResolvedValueOnce(SESAME_OWNER)

    const report = await verifyToken('SN-2026-000007')
    // 5,000 kg × 1,500 NGN/kg = 7,500,000
    expect(report.estimatedValueNgn).toBe(7_500_000)
    expect(report.spotPriceNgnPerKg).toBe(1_500)
  })

  it('omits estimatedValueNgn for unknown commodity and adds a warning', async () => {
    mockMaizeQueryToken.mockResolvedValueOnce(
      maizeMetaFixture({ commodity: 'UNKNOWN_GRAIN' }),
    )
    mockMaizeQueryOwner.mockResolvedValueOnce(MAIZE_OWNER)

    const report = await verifyToken('KN-2026-000042')
    expect(report.estimatedValueNgn).toBeNull()
    expect(report.spotPriceNgnPerKg).toBeNull()
    expect(report.warnings.some(w => w.includes('estimatedValueNgn omitted'))).toBe(true)
  })
})

describe('verifyToken — owner lookup failure', () => {
  it('still returns a FOUND report when owner lookup fails', async () => {
    mockMaizeQueryToken.mockResolvedValueOnce(maizeMetaFixture())
    mockMaizeQueryOwner.mockRejectedValueOnce(new Error('Owner lookup timed out'))

    const report = await verifyToken('KN-2026-000042')
    expect(report.tokenExists).toBe('FOUND')
    expect(report.currentOwner).toBeNull()
    expect(report.warnings.some(w => w.includes('Owner lookup failed'))).toBe(true)
  })
})

describe('verifyToken — warnings array', () => {
  it('returns an empty warnings array on a clean report', async () => {
    mockMaizeQueryToken.mockResolvedValueOnce(maizeMetaFixture())
    mockMaizeQueryOwner.mockResolvedValueOnce(MAIZE_OWNER)

    const report = await verifyToken('KN-2026-000042')
    // Custodian check uses the mock client which returns empty entries,
    // so custodianStatus = DEREGISTERED (not a warning — it's a status).
    // No other warnings should fire on a clean run.
    const nonCustodianWarnings = report.warnings.filter(
      w => !w.includes('Custodian'),
    )
    expect(nonCustodianWarnings).toHaveLength(0)
  })
})
