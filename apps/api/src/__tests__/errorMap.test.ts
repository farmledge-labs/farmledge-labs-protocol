/**
 * errorMap.test.ts
 *
 * Unit tests for resolveContractError() — one test per ContractError
 * variant to ensure every variant maps to the expected HTTP status code
 * and a non-empty plain-English message.
 *
 * Also covers the fallback behaviour for an unknown code so that future
 * contract variants never silently swallow the wrong status.
 */

import {
  resolveContractError,
  ContractErrorCode,
} from '../lib/errorMap'

// ---------------------------------------------------------------------------
// AlreadyInitialized (1) → 409 Conflict
// ---------------------------------------------------------------------------
describe('resolveContractError — AlreadyInitialized', () => {
  it('returns HTTP 409 for AlreadyInitialized (code 1)', () => {
    const result = resolveContractError(ContractErrorCode.AlreadyInitialized)
    expect(result.status).toBe(409)
  })

  it('returns a non-empty message for AlreadyInitialized', () => {
    const result = resolveContractError(ContractErrorCode.AlreadyInitialized)
    expect(result.message.length).toBeGreaterThan(0)
  })
})

// ---------------------------------------------------------------------------
// Unauthorized (2) → 403 Forbidden
// ---------------------------------------------------------------------------
describe('resolveContractError — Unauthorized', () => {
  it('returns HTTP 403 for Unauthorized (code 2)', () => {
    const result = resolveContractError(ContractErrorCode.Unauthorized)
    expect(result.status).toBe(403)
  })

  it('returns a non-empty message for Unauthorized', () => {
    const result = resolveContractError(ContractErrorCode.Unauthorized)
    expect(result.message.length).toBeGreaterThan(0)
  })
})

// ---------------------------------------------------------------------------
// TokenNotFound (3) → 404 Not Found
// ---------------------------------------------------------------------------
describe('resolveContractError — TokenNotFound', () => {
  it('returns HTTP 404 for TokenNotFound (code 3)', () => {
    const result = resolveContractError(ContractErrorCode.TokenNotFound)
    expect(result.status).toBe(404)
  })

  it('returns a non-empty message for TokenNotFound', () => {
    const result = resolveContractError(ContractErrorCode.TokenNotFound)
    expect(result.message.length).toBeGreaterThan(0)
  })
})

// ---------------------------------------------------------------------------
// TokenLocked (4) → 422 Unprocessable Entity
// ---------------------------------------------------------------------------
describe('resolveContractError — TokenLocked', () => {
  it('returns HTTP 422 for TokenLocked (code 4)', () => {
    const result = resolveContractError(ContractErrorCode.TokenLocked)
    expect(result.status).toBe(422)
  })

  it('returns a non-empty message for TokenLocked', () => {
    const result = resolveContractError(ContractErrorCode.TokenLocked)
    expect(result.message.length).toBeGreaterThan(0)
  })
})

// ---------------------------------------------------------------------------
// InvalidCommodity (5) → 400 Bad Request
// ---------------------------------------------------------------------------
describe('resolveContractError — InvalidCommodity', () => {
  it('returns HTTP 400 for InvalidCommodity (code 5)', () => {
    const result = resolveContractError(ContractErrorCode.InvalidCommodity)
    expect(result.status).toBe(400)
  })

  it('returns a non-empty message for InvalidCommodity', () => {
    const result = resolveContractError(ContractErrorCode.InvalidCommodity)
    expect(result.message.length).toBeGreaterThan(0)
  })
})

// ---------------------------------------------------------------------------
// InvalidWeight (6) → 400 Bad Request
// ---------------------------------------------------------------------------
describe('resolveContractError — InvalidWeight', () => {
  it('returns HTTP 400 for InvalidWeight (code 6)', () => {
    const result = resolveContractError(ContractErrorCode.InvalidWeight)
    expect(result.status).toBe(400)
  })

  it('returns a non-empty message for InvalidWeight', () => {
    const result = resolveContractError(ContractErrorCode.InvalidWeight)
    expect(result.message.length).toBeGreaterThan(0)
  })
})

// ---------------------------------------------------------------------------
// Unknown / future codes → 500 fallback
// ---------------------------------------------------------------------------
describe('resolveContractError — unknown code', () => {
  it('returns HTTP 500 for an unrecognised code', () => {
    const result = resolveContractError(999)
    expect(result.status).toBe(500)
  })

  it('returns a non-empty message for an unrecognised code', () => {
    const result = resolveContractError(999)
    expect(result.message.length).toBeGreaterThan(0)
  })

  it('returns HTTP 500 for code 0 (not a valid variant)', () => {
    const result = resolveContractError(0)
    expect(result.status).toBe(500)
  })
})

// ---------------------------------------------------------------------------
// Raw numeric equivalence — confirm numeric codes work identically to enum
// ---------------------------------------------------------------------------
describe('resolveContractError — raw numeric codes match enum', () => {
  const cases: [number, number][] = [
    [1, 409], // AlreadyInitialized
    [2, 403], // Unauthorized
    [3, 404], // TokenNotFound
    [4, 422], // TokenLocked
    [5, 400], // InvalidCommodity
    [6, 400], // InvalidWeight
  ]

  test.each(cases)(
    'raw code %i resolves to HTTP %i',
    (code, expectedStatus) => {
      expect(resolveContractError(code).status).toBe(expectedStatus)
    },
  )
})
