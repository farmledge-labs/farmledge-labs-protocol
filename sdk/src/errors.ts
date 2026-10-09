/**
 * Typed error thrown by the Farmledge SDK when a contract call is rejected or
 * fails to confirm.
 *
 * Callers (e.g. the platform deposit controller, issue CUST-1) can branch on
 * `error.code` to distinguish failure modes without string-matching messages.
 */
export type FarmledgeSDKErrorCode =
  | 'SIMULATION_FAILED'
  | 'SUBMISSION_FAILED'
  | 'TRANSACTION_FAILED'
  | 'CONFIRMATION_TIMEOUT'
  | 'MALFORMED_RESULT'

export class FarmledgeSDKError extends Error {
  /** Stable, machine-readable failure category. */
  readonly code: FarmledgeSDKErrorCode
  /** The underlying value that triggered the error, when available. */
  readonly cause?: unknown

  constructor(code: FarmledgeSDKErrorCode, message: string, cause?: unknown) {
    super(message)
    this.name = 'FarmledgeSDKError'
    this.code = code
    this.cause = cause
    // Restore the prototype chain so `instanceof FarmledgeSDKError` works even
    // when compiled down to ES2020 (see TypeScript's extending-built-ins note).
    Object.setPrototypeOf(this, FarmledgeSDKError.prototype)
  }
}

// ---------------------------------------------------------------------------
// Contract-level typed errors
//
// These map the on-chain ContractError discriminants to JS class instances so
// callers can use `instanceof` instead of comparing raw numbers.
//
// Discriminants come directly from contracts/maize-receipt/src/errors.rs:
//   AlreadyInitialized = 1
//   Unauthorized       = 2
//   TokenNotFound      = 3
//   TokenLocked        = 4
//   InvalidCommodity   = 5
//   InvalidWeight      = 6
// ---------------------------------------------------------------------------

/**
 * Thrown when the requested token does not exist on-chain.
 * Maps to ContractError::TokenNotFound (discriminant 3).
 */
export class TokenNotFoundError extends FarmledgeSDKError {
  /** The on-chain ContractError discriminant for TokenNotFound. */
  static readonly CONTRACT_CODE = 3 as const

  constructor(tokenId: string, cause?: unknown) {
    super(
      'TRANSACTION_FAILED',
      `Token not found: ${tokenId}`,
      cause,
    )
    this.name = 'TokenNotFoundError'
    Object.setPrototypeOf(this, TokenNotFoundError.prototype)
  }
}

/**
 * Thrown when the operation is rejected because the token is locked.
 * Maps to ContractError::TokenLocked (discriminant 4).
 */
export class TokenLockedError extends FarmledgeSDKError {
  /** The on-chain ContractError discriminant for TokenLocked. */
  static readonly CONTRACT_CODE = 4 as const

  constructor(tokenId: string, cause?: unknown) {
    super(
      'TRANSACTION_FAILED',
      `Token is locked and cannot be split: ${tokenId}`,
      cause,
    )
    this.name = 'TokenLockedError'
    Object.setPrototypeOf(this, TokenLockedError.prototype)
  }
}

/**
 * Thrown when the contract rejects the split weight (0 or >= total weight).
 * Maps to ContractError::InvalidWeight (discriminant 6).
 */
export class InvalidWeightError extends FarmledgeSDKError {
  /** The on-chain ContractError discriminant for InvalidWeight. */
  static readonly CONTRACT_CODE = 6 as const

  constructor(message: string, cause?: unknown) {
    super('TRANSACTION_FAILED', message, cause)
    this.name = 'InvalidWeightError'
    Object.setPrototypeOf(this, InvalidWeightError.prototype)
  }
}

/**
 * Thrown before any network call when the caller passes an `amountKg` that is
 * not a safe positive integer or exceeds the u32 range.
 *
 * This is a client-side guard — the RPC is never contacted.
 */
export class InvalidAmountError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'InvalidAmountError'
    Object.setPrototypeOf(this, InvalidAmountError.prototype)
  }
}

/**
 * Thrown when the contract returns an unknown error code not covered by a
 * more specific typed error. Carries the raw numeric discriminant.
 */
export class ContractInvocationError extends FarmledgeSDKError {
  /** The raw numeric ContractError discriminant returned by the contract. */
  readonly contractCode: number

  constructor(contractCode: number, cause?: unknown) {
    super(
      'TRANSACTION_FAILED',
      `Contract returned unknown error code: ${contractCode}`,
      cause,
    )
    this.name = 'ContractInvocationError'
    this.contractCode = contractCode
    Object.setPrototypeOf(this, ContractInvocationError.prototype)
  }
}
