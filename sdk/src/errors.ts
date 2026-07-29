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
