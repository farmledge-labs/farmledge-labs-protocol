/**
 * Typed errors thrown by the Farmledge SDK when a contract call is rejected
 * or fails to confirm.
 *
 * Error hierarchy:
 *
 *   FarmledgeSDKError
 *   ├── RetryableError       — transient failures; safe to retry
 *   └── TerminalError        — permanent failures; do not retry
 *       ├── StateArchivedError
 *       ├── TokenNotFoundError
 *       ├── TokenLockedError
 *       ├── InvalidWeightError
 *       └── ContractInvocationError
 *
 * Callers can branch on `error.code` for stable machine-readable categories,
 * or use `instanceof` for class-specific handling.
 */

// ---------------------------------------------------------------------------
// Error codes
// ---------------------------------------------------------------------------

export type FarmledgeSDKErrorCode =
  // ── original codes (preserved) ──────────────────────────────────────────
  | 'SIMULATION_FAILED'
  | 'SUBMISSION_FAILED'
  | 'TRANSACTION_FAILED'
  | 'CONFIRMATION_TIMEOUT'
  | 'MALFORMED_RESULT'
  // ── retryable ───────────────────────────────────────────────────────────
  | 'NETWORK_FAILURE'
  | 'RPC_ERROR'
  | 'TRY_AGAIN_LATER'
  | 'POLL_TIMEOUT'
  // ── terminal ────────────────────────────────────────────────────────────
  | 'STATE_ARCHIVED'
  | 'AUTH_FAILED'
  | 'BAD_SEQUENCE'

// ---------------------------------------------------------------------------
// Base error
// ---------------------------------------------------------------------------

/**
 * Base class for all Farmledge SDK errors.
 *
 * Callers (e.g. the platform deposit controller) can branch on `error.code`
 * to distinguish failure modes without string-matching messages.
 */
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
// Retryable errors — transient; the pipeline will back off and retry
// ---------------------------------------------------------------------------

/**
 * Thrown for transient failures where retrying is safe: network errors,
 * RPC 5xx responses, `TRY_AGAIN_LATER` send status, and poll timeouts.
 *
 * The retry helper ({@link withRetry}) catches only this class; it rethrows
 * {@link TerminalError} immediately without consuming any retry budget.
 */
export class RetryableError extends FarmledgeSDKError {
  constructor(code: FarmledgeSDKErrorCode, message: string, cause?: unknown) {
    super(code, message, cause)
    this.name = 'RetryableError'
    Object.setPrototypeOf(this, RetryableError.prototype)
  }
}

// ---------------------------------------------------------------------------
// Terminal errors — permanent; retrying will not help
// ---------------------------------------------------------------------------

/**
 * Thrown for permanent failures where retrying cannot help: contract
 * rejections, auth failures, `FAILED` transaction results, and simulation
 * errors.
 *
 * All contract-level typed errors extend this class, so callers can use
 * `instanceof TerminalError` as a catch-all guard before inspecting the
 * specific subclass.
 */
export class TerminalError extends FarmledgeSDKError {
  constructor(code: FarmledgeSDKErrorCode, message: string, cause?: unknown) {
    super(code, message, cause)
    this.name = 'TerminalError'
    Object.setPrototypeOf(this, TerminalError.prototype)
  }
}

// ---------------------------------------------------------------------------
// StateArchivedError — special terminal: contract state needs restoration
// ---------------------------------------------------------------------------

/**
 * Thrown when the simulation indicates the contract entry is archived and must
 * be restored before the transaction can proceed.
 *
 * Carries the `restorePreamble` from the simulation response so the caller
 * can initiate a `RestoreFootprint` operation if they choose to.
 *
 * **The SDK does not auto-restore.** The caller is responsible for deciding
 * whether and how to restore the archived entry (out of scope: SDK-11).
 */
export class StateArchivedError extends TerminalError {
  /**
   * The restore preamble returned by the RPC simulation response.
   * Pass this to a `RestoreFootprint` operation to restore the archived entry.
   */
  readonly restorePreamble: unknown

  constructor(restorePreamble: unknown, cause?: unknown) {
    super(
      'STATE_ARCHIVED',
      'Contract entry is archived and must be restored before this transaction can proceed',
      cause,
    )
    this.name = 'StateArchivedError'
    this.restorePreamble = restorePreamble
    Object.setPrototypeOf(this, StateArchivedError.prototype)
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
export class TokenNotFoundError extends TerminalError {
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
export class TokenLockedError extends TerminalError {
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
export class InvalidWeightError extends TerminalError {
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
export class ContractInvocationError extends TerminalError {
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
