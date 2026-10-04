/**
 * errorMap.ts
 *
 * Translates Soroban ContractError discriminant values (the `u32` integer
 * returned by both `maize-receipt` and `sesame-receipt`) into a structured
 * API error shape — HTTP status code + plain-English message — so that
 * contract failures propagate as well-formed API responses rather than
 * generic 500s.
 *
 * The numeric values mirror the `#[contracterror]` enum defined in both
 * contracts' source:
 *
 *   AlreadyInitialized = 1
 *   Unauthorized       = 2
 *   TokenNotFound      = 3
 *   TokenLocked        = 4
 *   InvalidCommodity   = 5
 *   InvalidWeight      = 6
 */

/**
 * Discriminant values emitted by the Soroban contracts when a call fails.
 * Keeping a TypeScript enum here makes call-sites self-documenting.
 */
export enum ContractErrorCode {
  AlreadyInitialized = 1,
  Unauthorized = 2,
  TokenNotFound = 3,
  TokenLocked = 4,
  InvalidCommodity = 5,
  InvalidWeight = 6,
}

/** The shape every entry in the map exposes. */
export interface ContractErrorEntry {
  /** HTTP status code to return to the caller. */
  status: number
  /** Human-readable explanation suitable for an API error body. */
  message: string
}

/**
 * Immutable lookup table: contract error code → HTTP status + message.
 *
 * `as const` guarantees the exact literal types are preserved; the `Record`
 * wrapper makes TypeScript verify that every `ContractErrorCode` variant is
 * covered at compile time.
 */
const ERROR_MAP: Record<ContractErrorCode, ContractErrorEntry> = {
  [ContractErrorCode.AlreadyInitialized]: {
    status: 409,
    message: 'Contract has already been initialised.',
  },
  [ContractErrorCode.Unauthorized]: {
    status: 403,
    message: 'Caller is not authorised to perform this operation.',
  },
  [ContractErrorCode.TokenNotFound]: {
    status: 404,
    message: 'The requested warehouse-receipt token does not exist.',
  },
  [ContractErrorCode.TokenLocked]: {
    status: 422,
    message:
      'Token is currently locked and cannot be transferred or modified.',
  },
  [ContractErrorCode.InvalidCommodity]: {
    status: 400,
    message: 'The supplied commodity type is not supported by this contract.',
  },
  [ContractErrorCode.InvalidWeight]: {
    status: 400,
    message: 'Weight value is out of the acceptable range for this contract.',
  },
} as const

/**
 * A fallback entry used when the raw code is not a known `ContractErrorCode`.
 * Callers should treat this as an unexpected contract error (e.g. a future
 * variant added before the SDK is updated).
 */
const UNKNOWN_ERROR_ENTRY: ContractErrorEntry = {
  status: 500,
  message: 'An unexpected contract error occurred.',
}

/**
 * Resolve a raw Soroban contract error code to the corresponding HTTP status
 * and plain-English message.
 *
 * @param code - The numeric discriminant from the Soroban error value,
 *               e.g. extracted via `contractErrorCode(err)` in the SDK.
 * @returns The matching `ContractErrorEntry`, or a generic 500 entry if the
 *          code is unrecognised.
 *
 * @example
 * ```ts
 * const { status, message } = resolveContractError(err.code);
 * res.status(status).json({ error: message });
 * ```
 */
export function resolveContractError(code: number): ContractErrorEntry {
  if (code in ContractErrorCode && ERROR_MAP[code as ContractErrorCode]) {
    return ERROR_MAP[code as ContractErrorCode]
  }
  return UNKNOWN_ERROR_ENTRY
}
