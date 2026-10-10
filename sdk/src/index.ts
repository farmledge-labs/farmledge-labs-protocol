export { FarmledgeClient } from './client'

// ---------------------------------------------------------------------------
// Error model
// ---------------------------------------------------------------------------
export {
  FarmledgeSDKError,
  /** Transient failures — the pipeline will back off and retry. */
  RetryableError,
  /** Permanent failures — retrying cannot help; inspect `.code` or subclass. */
  TerminalError,
  /**
   * Thrown when simulation finds the contract entry is archived.
   * Carries `.restorePreamble` for the caller to initiate a RestoreFootprint
   * operation if desired. The SDK does not auto-restore.
   */
  StateArchivedError,
  TokenNotFoundError,
  TokenLockedError,
  InvalidWeightError,
  InvalidAmountError,
  ContractInvocationError,
} from './errors'
export type { FarmledgeSDKErrorCode } from './errors'

// ---------------------------------------------------------------------------
// Transaction pipeline
// ---------------------------------------------------------------------------
/**
 * Execute the full Soroban transaction lifecycle (simulate → assemble → sign →
 * send → poll) with exponential back-off retry and idempotent submission.
 */
export { executeTransaction, submitSignedTransaction } from './tx/pipeline'
export type {
  TransactionResult,
  AccountLike,
  ExecuteTransactionParams,
} from './tx/pipeline'

/** A function type for signing a transaction XDR. */
export type { Signer } from './tx/signer'
/** Wrap a Stellar Keypair into a {@link Signer}. */
export { keypairSigner } from './tx/signer'

/** Retry with exponential back-off and jitter. Retries only {@link RetryableError}. */
export { withRetry } from './tx/retry'
export type { RetryOptions } from './tx/retry'

// ---------------------------------------------------------------------------
// Maize bindings
// ---------------------------------------------------------------------------
export { init as maizeInit } from './maize/init'
export {
  addCustodian as maizeAddCustodian,
  removeCustodian as maizeRemoveCustodian,
} from './maize/custodians'
export { mint as maizeMint } from './maize/mint'
export type { MintResult as MaizeMintResult } from './maize/mint'
export { splitToken as maizeSplitToken } from './maize/split'
export type {
  SplitTokenParams as MaizeSplitTokenParams,
  SplitTokenResult as MaizeSplitTokenResult,
} from './maize/split'

// ---------------------------------------------------------------------------
// Sesame bindings
// ---------------------------------------------------------------------------
export { init as sesameInit } from './sesame/init'
export {
  addCustodian as sesameAddCustodian,
  removeCustodian as sesameRemoveCustodian,
} from './sesame/custodians'
export { mint as sesameMint } from './sesame/mint'
export type { MintResult as SesameMintResult } from './sesame/mint'
export { transfer as sesameTransfer } from './sesame/transfer'
export { burn as sesameBurn } from './sesame/burn'
export {
  queryToken as sesameQueryToken,
  queryOwner as sesameQueryOwner,
} from './sesame/query'
export type { SesameTokenMetadata } from './sesame/query'

// ---------------------------------------------------------------------------
// Misc
// ---------------------------------------------------------------------------
export { generateCertificatePdf } from './lib/pdf/certificate'
export * from './types'
export const FARMLEDGE_PROTOCOL_VERSION = '0.1.0'
