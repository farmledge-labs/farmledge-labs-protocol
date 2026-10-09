import {
  TransactionBuilder,
  Contract,
  Keypair,
  rpc,
  nativeToScVal,
  scValToNative,
  BASE_FEE,
} from '@stellar/stellar-sdk'
import type { FarmledgeClient } from '../client'
import {
  FarmledgeSDKError,
  InvalidAmountError,
  InvalidWeightError,
  TokenLockedError,
  TokenNotFoundError,
  ContractInvocationError,
} from '../errors'

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * Input parameters for {@link splitToken}.
 */
export interface SplitTokenParams {
  /** The token id of the parent receipt to split. */
  tokenId: string
  /**
   * Weight in kg to allocate to child A. Must be a positive integer in the
   * u32 range (1 – 4 294 967 295) and strictly less than the parent's total
   * weight. The remainder goes to child B.
   */
  amountKg: number
  /** Keypair of the token owner who authorises the split. */
  signer: Keypair
}

/**
 * The result of a successful {@link splitToken} call.
 */
export interface SplitTokenResult {
  /** Token id of the parent receipt that was consumed by the split. */
  parentTokenId: string
  /** Child A — receives `amountKg` kilograms. */
  childA: { tokenId: string }
  /** Child B — receives `totalWeight - amountKg` kilograms. */
  childB: { tokenId: string }
  /** Hash of the confirmed on-chain transaction. */
  txHash: string
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Parses the `(String, String)` tuple returned by the contract's `split()`
 * and extracts the two child token ids.
 *
 * The Soroban SDK encodes a Rust `(A, B)` as a `ScVec` (struct/map representation
 * when using `contracttype`, or simply a `Vec` for tuples). `scValToNative`
 * converts it to a JS array `[childAId, childBId]`.
 */
function decodeSplitResult(
  statusResult: rpc.Api.GetSuccessfulTransactionResponse,
  txHash: string,
): [string, string] {
  const returnValue = statusResult.returnValue

  if (!returnValue) {
    throw new FarmledgeSDKError(
      'MALFORMED_RESULT',
      `Transaction ${txHash} succeeded but returned no split result`,
      statusResult,
    )
  }

  const decoded = scValToNative(returnValue)

  if (
    !Array.isArray(decoded) ||
    decoded.length !== 2 ||
    typeof decoded[0] !== 'string' ||
    typeof decoded[1] !== 'string'
  ) {
    throw new FarmledgeSDKError(
      'MALFORMED_RESULT',
      `Transaction ${txHash} returned an unexpected split result: ${JSON.stringify(decoded)}`,
      returnValue,
    )
  }

  return [decoded[0], decoded[1]]
}

/**
 * Extracts the numeric ContractError discriminant from a simulation-error
 * string such as `"HostError: Error(Contract, #3)"`.
 *
 * Returns `null` when the string does not match the expected format.
 */
function parseContractErrorCode(errorString: string): number | null {
  const match = errorString.match(/Error\(Contract,\s*#(\d+)\)/)
  if (!match) return null
  return parseInt(match[1], 10)
}

/**
 * Maps a known ContractError discriminant to a typed error for `split()`.
 * Unknown codes produce a {@link ContractInvocationError}.
 */
function mapContractError(
  code: number,
  tokenId: string,
  cause: unknown,
): FarmledgeSDKError {
  switch (code) {
    case TokenNotFoundError.CONTRACT_CODE:
      return new TokenNotFoundError(tokenId, cause)
    case TokenLockedError.CONTRACT_CODE:
      return new TokenLockedError(tokenId, cause)
    case InvalidWeightError.CONTRACT_CODE:
      return new InvalidWeightError(
        `Split amount is invalid for token ${tokenId}: must be > 0 and < total_weight`,
        cause,
      )
    default:
      return new ContractInvocationError(code, cause)
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Splits a maize warehouse-receipt token into two child tokens by invoking
 * `split()` on the maize-receipt contract.
 *
 * The token owner signs the transaction. The contract enforces:
 * - The parent token must exist (TokenNotFound → {@link TokenNotFoundError})
 * - The parent token must not be locked (TokenLocked → {@link TokenLockedError})
 * - `amountKg` must be > 0 and < `total_weight_kg` (InvalidWeight →
 *   {@link InvalidWeightError})
 *
 * **Client-side pre-flight validation** (no RPC call made):
 * - `amountKg` must be a safe positive integer in the u32 range
 *   (throws {@link InvalidAmountError} on failure)
 *
 * @param client  - Configured {@link FarmledgeClient}
 * @param params  - {@link SplitTokenParams}
 * @returns A {@link SplitTokenResult} containing both child token ids and the txHash
 *
 * @throws {InvalidAmountError} When `amountKg` is out of range before any RPC call
 * @throws {TokenNotFoundError} When the parent token does not exist
 * @throws {TokenLockedError} When the parent token is locked
 * @throws {InvalidWeightError} When the contract rejects the split weight
 * @throws {ContractInvocationError} When the contract returns an unexpected error code
 * @throws {FarmledgeSDKError} For simulation, submission, or confirmation failures
 */
export async function splitToken(
  client: FarmledgeClient,
  params: SplitTokenParams,
): Promise<SplitTokenResult> {
  const { tokenId, amountKg, signer } = params
  const { server, networkPassphrase, maizeContractId } = client

  // ------------------------------------------------------------------
  // Client-side validation — reject before touching the network
  // ------------------------------------------------------------------
  if (!Number.isInteger(amountKg) || amountKg <= 0) {
    throw new InvalidAmountError(
      `amountKg must be a positive integer, got: ${amountKg}`,
    )
  }
  if (amountKg > 4_294_967_295) {
    throw new InvalidAmountError(
      `amountKg exceeds the maximum u32 value (4294967295), got: ${amountKg}`,
    )
  }

  // ------------------------------------------------------------------
  // 1. Fetch the signer account's current sequence number from the RPC
  // ------------------------------------------------------------------
  const account = await server.getAccount(signer.publicKey())

  // ------------------------------------------------------------------
  // 2. Build the invoke-host-function operation that calls
  //    split(token_id, amount_kg)
  // ------------------------------------------------------------------
  const contract = new Contract(maizeContractId)

  const builtTx = new TransactionBuilder(account, {
    fee: BASE_FEE,
    networkPassphrase,
  })
    .addOperation(
      contract.call(
        'split',
        nativeToScVal(tokenId, { type: 'string' }),
        nativeToScVal(amountKg, { type: 'u32' }),
      ),
    )
    .setTimeout(30)
    .build()

  // ------------------------------------------------------------------
  // 3. Simulate — surfaces contract rejections (TokenNotFound, TokenLocked,
  //    InvalidWeight) before spending any sequence number.
  // ------------------------------------------------------------------
  const simResult = await server.simulateTransaction(builtTx)

  if (rpc.Api.isSimulationError(simResult)) {
    const code = parseContractErrorCode(simResult.error)
    if (code !== null) {
      throw mapContractError(code, tokenId, simResult)
    }
    throw new FarmledgeSDKError(
      'SIMULATION_FAILED',
      `Contract rejected split during simulation: ${simResult.error}`,
      simResult,
    )
  }

  // ------------------------------------------------------------------
  // 4. Assemble (sets the Soroban resource footprint) → sign → submit
  // ------------------------------------------------------------------
  const preparedTx = rpc.assembleTransaction(builtTx, simResult).build()
  preparedTx.sign(signer)

  const sendResult = await server.sendTransaction(preparedTx)

  if (sendResult.status === 'ERROR') {
    throw new FarmledgeSDKError(
      'SUBMISSION_FAILED',
      `Transaction submission failed: ${JSON.stringify(sendResult.errorResult)}`,
      sendResult,
    )
  }

  const txHash = sendResult.hash

  // ------------------------------------------------------------------
  // 5. Poll until the transaction reaches a terminal state
  // ------------------------------------------------------------------
  const POLL_INTERVAL_MS = 1_000
  const MAX_ATTEMPTS = 30

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    await sleep(POLL_INTERVAL_MS)

    const statusResult = await server.getTransaction(txHash)

    if (statusResult.status === rpc.Api.GetTransactionStatus.SUCCESS) {
      const [childAId, childBId] = decodeSplitResult(statusResult, txHash)
      return {
        parentTokenId: tokenId,
        childA: { tokenId: childAId },
        childB: { tokenId: childBId },
        txHash,
      }
    }

    if (statusResult.status === rpc.Api.GetTransactionStatus.FAILED) {
      throw new FarmledgeSDKError(
        'TRANSACTION_FAILED',
        `Transaction ${txHash} failed on-chain`,
        statusResult,
      )
    }

    // NOT_FOUND means the transaction is still pending — keep polling
  }

  throw new FarmledgeSDKError(
    'CONFIRMATION_TIMEOUT',
    `Transaction ${txHash} did not confirm within ${MAX_ATTEMPTS} seconds`,
  )
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
