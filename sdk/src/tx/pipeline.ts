import {
  Transaction,
  rpc,
  xdr,
} from '@stellar/stellar-sdk'
import type { FarmledgeClient } from '../client'
import {
  RetryableError,
  TerminalError,
  StateArchivedError,
} from '../errors'
import type { Signer } from './signer'
import { withRetry, type RetryOptions } from './retry'

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * The result shape returned by {@link executeTransaction} and
 * {@link submitSignedTransaction}.
 */
export interface TransactionResult {
  /** The hash of the confirmed transaction (lowercase hex string). */
  txHash: string
  /** The ledger number in which the transaction was included. */
  ledger: number
  /** The raw ScVal return value from the contract, if any. */
  returnValue: xdr.ScVal | undefined
  /**
   * Total number of `sendTransaction` calls made. 1 means the transaction
   * succeeded on the first send attempt.
   */
  attempts: number
}

/**
 * Minimal account interface that `buildOp` receives. Compatible with the
 * object returned by `rpc.Server.getAccount()`.
 */
export interface AccountLike {
  accountId(): string
  sequenceNumber(): string
  incrementSequenceNumber(): void
}

/**
 * Parameters for {@link executeTransaction}.
 */
export interface ExecuteTransactionParams {
  /** Configured {@link FarmledgeClient}. */
  client: FarmledgeClient
  /**
   * The public key of the source account. The pipeline fetches this account
   * before every attempt so the sequence number is always fresh, including
   * after a `txBAD_SEQ` rejection.
   */
  sourcePublicKey: string
  /**
   * Factory that builds the unsigned Transaction given the freshly-loaded
   * source account. Called on every attempt; build with the account's current
   * sequence number via `new TransactionBuilder(account, ...)`.
   */
  buildOp: (account: AccountLike) => Transaction
  /** Signer implementation — wraps a Keypair, Freighter, Ledger, etc. */
  signer: Signer
  /**
   * Retry options. Defaults: 3 attempts, 500 ms base delay, 8 s max delay.
   * Inject `sleep` and `random` in tests to run without real timers.
   */
  retry?: RetryOptions
}

// ---------------------------------------------------------------------------
// Internal constants
// ---------------------------------------------------------------------------

const POLL_INTERVAL_MS = 1_000
const MAX_POLL_ATTEMPTS = 30

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function realSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * Computes the transaction hash from a signed XDR envelope.
 * Returns a lowercase hex string, matching what the RPC returns.
 */
export function hashFromXdr(signedXdr: string, networkPassphrase: string): string {
  const tx = new Transaction(
    xdr.TransactionEnvelope.fromXDR(signedXdr, 'base64'),
    networkPassphrase,
  )
  return tx.hash().toString('hex')
}

/**
 * Classifies a simulation result:
 * - restore-required → throws {@link StateArchivedError}
 * - error            → throws {@link TerminalError}(SIMULATION_FAILED)
 * - success          → returns the success response
 */
function classifySimulation(
  simResult: rpc.Api.SimulateTransactionResponse,
): rpc.Api.SimulateTransactionSuccessResponse {
  if (rpc.Api.isSimulationRestore(simResult)) {
    const restoreResult = simResult as rpc.Api.SimulateTransactionRestoreResponse
    throw new StateArchivedError(restoreResult.restorePreamble, simResult)
  }

  if (rpc.Api.isSimulationError(simResult)) {
    const errResult = simResult as rpc.Api.SimulateTransactionErrorResponse
    throw new TerminalError(
      'SIMULATION_FAILED',
      `Simulation failed: ${errResult.error}`,
      simResult,
    )
  }

  return simResult as rpc.Api.SimulateTransactionSuccessResponse
}

/**
 * Returns true when a `sendTransaction` ERROR result encodes a `txBAD_SEQ`
 * transaction result code.
 */
function isBadSequenceError(sendResult: rpc.Api.SendTransactionResponse): boolean {
  if (sendResult.status !== 'ERROR') return false
  if (!sendResult.errorResult) return false
  try {
    const code = (sendResult.errorResult as xdr.TransactionResult)
      .result()
      .switch()
      .name as string
    return code === 'txBAD_SEQ'
  } catch {
    return JSON.stringify(sendResult.errorResult).includes('txBAD_SEQ')
  }
}

/**
 * Polls `getTransaction(hash)` until the transaction reaches a terminal state.
 *
 * - SUCCESS → returns the response
 * - FAILED  → throws TerminalError(TRANSACTION_FAILED)
 * - timeout → throws RetryableError(POLL_TIMEOUT)
 */
async function pollUntilFinal(
  server: rpc.Server,
  txHash: string,
  sleep: (ms: number) => Promise<void>,
): Promise<rpc.Api.GetSuccessfulTransactionResponse> {
  for (let i = 0; i < MAX_POLL_ATTEMPTS; i++) {
    await sleep(POLL_INTERVAL_MS)

    const result = await server.getTransaction(txHash)

    if (result.status === rpc.Api.GetTransactionStatus.SUCCESS) {
      return result as rpc.Api.GetSuccessfulTransactionResponse
    }

    if (result.status === rpc.Api.GetTransactionStatus.FAILED) {
      throw new TerminalError(
        'TRANSACTION_FAILED',
        `Transaction ${txHash} failed on-chain`,
        result,
      )
    }
    // NOT_FOUND → still pending, keep polling
  }

  throw new RetryableError(
    'POLL_TIMEOUT',
    `Transaction ${txHash} did not confirm within ${MAX_POLL_ATTEMPTS} seconds`,
  )
}

// Internal sentinel — signals txBAD_SEQ to executeTransaction's rebuild loop.
// Not exported; callers always see RetryableError('BAD_SEQUENCE').
class BadSequenceSentinel extends Error {
  readonly sendResult: rpc.Api.SendTransactionResponse
  constructor(sendResult: rpc.Api.SendTransactionResponse) {
    super('txBAD_SEQ')
    this.sendResult = sendResult
    Object.setPrototypeOf(this, BadSequenceSentinel.prototype)
  }
}

/**
 * Sends a signed transaction and polls until confirmed.
 *
 * Status handling:
 * - PENDING / DUPLICATE → poll by hash (DUPLICATE = already submitted, no resend)
 * - TRY_AGAIN_LATER     → throws RetryableError
 * - ERROR + txBAD_SEQ   → throws BadSequenceSentinel (caught by executeTransaction)
 * - ERROR other         → throws TerminalError
 *
 * Idempotency on POLL_TIMEOUT (called before any resubmission):
 * - SUCCESS  → return immediately, no resend ever
 * - FAILED   → throw TerminalError
 * - NOT_FOUND → re-throw RetryableError (safe to retry/resend)
 */
async function sendAndPoll(
  server: rpc.Server,
  signedXdr: string,
  networkPassphrase: string,
  sleep: (ms: number) => Promise<void>,
): Promise<rpc.Api.GetSuccessfulTransactionResponse> {
  const txHash = hashFromXdr(signedXdr, networkPassphrase)
  const signedTx = new Transaction(
    xdr.TransactionEnvelope.fromXDR(signedXdr, 'base64'),
    networkPassphrase,
  )

  const sendResult = await server.sendTransaction(signedTx)

  if (sendResult.status === 'PENDING' || sendResult.status === 'DUPLICATE') {
    try {
      return await pollUntilFinal(server, txHash, sleep)
    } catch (err) {
      if (err instanceof RetryableError && err.code === 'POLL_TIMEOUT') {
        // Idempotency check — before any retry/resend, query the ledger
        const check = await server.getTransaction(txHash)

        if (check.status === rpc.Api.GetTransactionStatus.SUCCESS) {
          // Already landed — return it, never call sendTransaction again
          return check as rpc.Api.GetSuccessfulTransactionResponse
        }
        if (check.status === rpc.Api.GetTransactionStatus.FAILED) {
          throw new TerminalError(
            'TRANSACTION_FAILED',
            `Transaction ${txHash} failed on-chain (confirmed on idempotency check)`,
            check,
          )
        }
        // NOT_FOUND — safe to retry and resend; re-throw as-is
      }
      throw err
    }
  }

  if (sendResult.status === 'TRY_AGAIN_LATER') {
    throw new RetryableError(
      'TRY_AGAIN_LATER',
      'RPC returned TRY_AGAIN_LATER; will back off and retry',
      sendResult,
    )
  }

  if (sendResult.status === 'ERROR') {
    if (isBadSequenceError(sendResult)) {
      throw new BadSequenceSentinel(sendResult)
    }
    throw new TerminalError(
      'SUBMISSION_FAILED',
      `Transaction submission failed: ${JSON.stringify(sendResult.errorResult)}`,
      sendResult,
    )
  }

  throw new TerminalError(
    'SUBMISSION_FAILED',
    `Unexpected sendTransaction status: ${(sendResult as { status: string }).status}`,
    sendResult,
  )
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Executes the full Soroban transaction lifecycle:
 * **load account → build → simulate → assemble → sign → send → poll**
 *
 * ### Retry behaviour
 * The entire cycle is wrapped in {@link withRetry}. On every attempt the
 * pipeline re-fetches the source account (guaranteeing a fresh sequence
 * number), rebuilds via `buildOp`, re-simulates, re-signs, and re-sends.
 * Only {@link RetryableError}s consume the retry budget; {@link TerminalError}s
 * (including {@link StateArchivedError}) are re-thrown immediately without
 * retrying.
 *
 * ### `txBAD_SEQ` handling
 * A `txBAD_SEQ` rejection causes the pipeline to re-fetch the source account
 * and rebuild the transaction — counted against the attempt budget.
 *
 * ### Idempotency guarantee
 * After a poll timeout, before any resubmission, the pipeline calls
 * `getTransaction(hash)`. If the transaction already landed as SUCCESS, it
 * returns that result and **never** calls `sendTransaction` again. If FAILED,
 * it throws immediately. Only NOT_FOUND permits a retry and resend.
 *
 * @param params - {@link ExecuteTransactionParams}
 * @returns {@link TransactionResult}
 *
 * @throws {StateArchivedError} Contract entry is archived; caller must restore
 * @throws {TerminalError}      Simulation failed, contract rejected, or FAILED
 * @throws {RetryableError}     All attempts exhausted (last error is re-thrown)
 */
export async function executeTransaction(
  params: ExecuteTransactionParams,
): Promise<TransactionResult> {
  const { client, sourcePublicKey, buildOp, signer, retry = {} } = params
  const { server, networkPassphrase } = client
  const sleep = retry.sleep ?? realSleep

  let totalAttempts = 0
  let finalTxHash = ''
  let finalLedger = 0
  let finalReturnValue: xdr.ScVal | undefined

  await withRetry(
    async () => {
      // 1. Load fresh source account — guarantees correct sequence number
      const account = await server.getAccount(sourcePublicKey)

      // 2. Build the transaction (caller uses the fresh account)
      const builtTx = buildOp(account as unknown as AccountLike)

      // 3. Simulate — throws StateArchivedError or TerminalError on failure
      let simResult: rpc.Api.SimulateTransactionResponse
      try {
        simResult = await server.simulateTransaction(builtTx)
      } catch (err) {
        throw new RetryableError('NETWORK_FAILURE', 'simulateTransaction network error', err)
      }
      classifySimulation(simResult)

      // 4. Assemble (sets the Soroban resource footprint)
      const preparedTx = rpc.assembleTransaction(builtTx, simResult).build()

      // 5. Sign — obtain signed XDR
      const signedXdr = await signer(
        preparedTx.toEnvelope().toXDR('base64'),
        networkPassphrase,
      )

      // 6. Compute hash BEFORE sending — the idempotency anchor
      finalTxHash = hashFromXdr(signedXdr, networkPassphrase)

      // 7. Send + poll (idempotency check on POLL_TIMEOUT built into sendAndPoll)
      try {
        totalAttempts++
        const statusResult = await sendAndPoll(server, signedXdr, networkPassphrase, sleep)
        finalLedger = (statusResult as { ledger?: number }).ledger ?? 0
        finalReturnValue = statusResult.returnValue
      } catch (err) {
        if (err instanceof BadSequenceSentinel) {
          // Re-fetch account + rebuild on the next withRetry iteration
          throw new RetryableError(
            'BAD_SEQUENCE',
            'txBAD_SEQ — rebuilding transaction with fresh sequence number',
            err.sendResult,
          )
        }
        throw err
      }
    },
    retry,
  )

  return {
    txHash: finalTxHash,
    ledger: finalLedger,
    returnValue: finalReturnValue,
    attempts: totalAttempts,
  }
}

/**
 * Submits an already-signed transaction XDR and polls until it confirms.
 *
 * Use this for flows where signing happened outside the SDK — Freighter,
 * Ledger, or a remote signing service. No keypair or signer is required.
 *
 * Applies the same send/poll classification, idempotency guarantee, and
 * exponential back-off as {@link executeTransaction}.
 *
 * @param client    - Configured {@link FarmledgeClient}
 * @param signedXdr - Base64-encoded XDR of the signed transaction
 * @param retry     - Optional retry/sleep injection (useful in tests)
 * @returns {@link TransactionResult}
 */
export async function submitSignedTransaction(
  client: FarmledgeClient,
  signedXdr: string,
  retry: RetryOptions = {},
): Promise<TransactionResult> {
  const { server, networkPassphrase } = client
  const sleep = retry.sleep ?? realSleep

  const txHash = hashFromXdr(signedXdr, networkPassphrase)
  let totalAttempts = 0
  let finalLedger = 0
  let finalReturnValue: xdr.ScVal | undefined

  await withRetry(
    async () => {
      totalAttempts++
      const statusResult = await sendAndPoll(server, signedXdr, networkPassphrase, sleep)
      finalLedger = (statusResult as { ledger?: number }).ledger ?? 0
      finalReturnValue = statusResult.returnValue
    },
    retry,
  )

  return {
    txHash,
    ledger: finalLedger,
    returnValue: finalReturnValue,
    attempts: totalAttempts,
  }
}
