import {
  TransactionBuilder,
  Contract,
  Keypair,
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
  TerminalError,
} from '../errors'
import { executeTransaction } from '../tx/pipeline'
import { keypairSigner } from '../tx/signer'

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
 */
function decodeSplitResult(returnValue: import('@stellar/stellar-sdk').xdr.ScVal, txHash: string): [string, string] {
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
 */
function parseContractErrorCode(errorString: string): number | null {
  const match = errorString.match(/Error\(Contract,\s*#(\d+)\)/)
  if (!match) return null
  return parseInt(match[1], 10)
}

/**
 * Maps a known ContractError discriminant to a typed TerminalError for split().
 */
function mapContractError(
  code: number,
  tokenId: string,
  cause: unknown,
): TerminalError {
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
 * @throws {InvalidAmountError}      When `amountKg` is out of range (no RPC call made)
 * @throws {TokenNotFoundError}      When the parent token does not exist
 * @throws {TokenLockedError}        When the parent token is locked
 * @throws {InvalidWeightError}      When the contract rejects the split weight
 * @throws {ContractInvocationError} When the contract returns an unexpected error code
 * @throws {FarmledgeSDKError}       For simulation, submission, or confirmation failures
 */
export async function splitToken(
  client: FarmledgeClient,
  params: SplitTokenParams,
): Promise<SplitTokenResult> {
  const { tokenId, amountKg, signer } = params
  const { networkPassphrase, maizeContractId } = client

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
  // Execute through the pipeline
  // ------------------------------------------------------------------
  let result: import('../tx/pipeline').TransactionResult

  try {
    result = await executeTransaction({
      client,
      sourcePublicKey: signer.publicKey(),
      buildOp: (account) => {
        const contract = new Contract(maizeContractId)

        return new TransactionBuilder(account, {
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
      },
      signer: keypairSigner(signer),
    })
  } catch (err) {
    // Map contract error codes from simulation failures to typed errors
    if (
      err instanceof TerminalError &&
      err.code === 'SIMULATION_FAILED' &&
      err.cause &&
      typeof (err.cause as { error?: string }).error === 'string'
    ) {
      const code = parseContractErrorCode(
        (err.cause as { error: string }).error,
      )
      if (code !== null) {
        throw mapContractError(code, tokenId, err.cause)
      }
    }
    throw err
  }

  // ------------------------------------------------------------------
  // Decode the (child_a_id, child_b_id) tuple from the return value
  // ------------------------------------------------------------------
  if (!result.returnValue) {
    throw new FarmledgeSDKError(
      'MALFORMED_RESULT',
      `Transaction ${result.txHash} succeeded but returned no split result`,
      result,
    )
  }

  const [childAId, childBId] = decodeSplitResult(result.returnValue, result.txHash)

  return {
    parentTokenId: tokenId,
    childA: { tokenId: childAId },
    childB: { tokenId: childBId },
    txHash: result.txHash,
  }
}
