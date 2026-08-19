import {
  TransactionBuilder,
  Contract,
  Address,
  rpc,
  nativeToScVal,
  scValToNative,
  BASE_FEE,
  Keypair,
} from '@stellar/stellar-sdk'
import type { FarmledgeClient } from '../client'
import { FarmledgeSDKError } from '../errors'

/**
 * Decoded token metadata returned by `get_token_metadata()`.
 * Field names mirror the Rust `TokenMetadata` struct.
 */
export interface SesameTokenMetadata {
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
}

/**
 * Retrieves the on-chain metadata for a sesame warehouse-receipt token by
 * invoking `get_token_metadata()` on the sesame-receipt contract.
 *
 * This is a read-only simulation call — no fee is charged and no transaction
 * is submitted to the network.
 *
 * @param client  - Configured FarmledgeClient (holds server + network info)
 * @param tokenId - The token id to query (format `SN-YYYY-NNNNNN`)
 * @returns Decoded {@link SesameTokenMetadata} for the token
 * @throws  {FarmledgeSDKError} If the token does not exist (contract returns
 *          TokenNotFound) or simulation fails for another reason.
 */
export async function queryToken(
  client: FarmledgeClient,
  tokenId: string,
): Promise<SesameTokenMetadata> {
  const { server, networkPassphrase, sesameContractId } = client

  // Use a throwaway keypair for simulation — no auth required for queries
  const feeSource = Keypair.random()

  // Build a minimal account stub. Queries are pure simulations, so the
  // sequence number and fee-source account do not need to exist on-chain.
  const fakeAccount = {
    accountId: () => feeSource.publicKey(),
    sequenceNumber: () => '0',
    incrementSequenceNumber: () => undefined,
  }

  const contract = new Contract(sesameContractId)

  const builtTx = new TransactionBuilder(fakeAccount as Parameters<typeof TransactionBuilder>[0], {
    fee: BASE_FEE,
    networkPassphrase,
  })
    .addOperation(
      contract.call(
        'get_token_metadata',
        nativeToScVal(tokenId, { type: 'string' }),
      ),
    )
    .setTimeout(30)
    .build()

  const simResult = await server.simulateTransaction(builtTx)

  if (rpc.Api.isSimulationError(simResult)) {
    throw new FarmledgeSDKError(
      'SIMULATION_FAILED',
      `get_token_metadata simulation failed: ${simResult.error}`,
      simResult,
    )
  }

  const successSim = simResult as rpc.Api.SimulateTransactionSuccessResponse
  if (!successSim.result) {
    throw new FarmledgeSDKError(
      'MALFORMED_RESULT',
      `get_token_metadata returned no result for token ${tokenId}`,
      simResult,
    )
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const raw: any = scValToNative(successSim.result.retval)

  return {
    tokenId: raw.token_id as string,
    commodity: raw.commodity as string,
    grade: raw.grade as string,
    bagCount: raw.bag_count as number,
    weightPerBagKg: raw.weight_per_bag_kg as number,
    totalWeightKg: raw.total_weight_kg as number,
    warehouseId: raw.warehouse_id as string,
    custodian: raw.custodian as string,
    depositTs: raw.deposit_ts as bigint,
    isLocked: raw.is_locked as boolean,
    parentTokenId: (raw.parent_token_id ?? null) as string | null,
  }
}

/**
 * Returns the list of sesame token ids currently owned by the given wallet
 * by invoking `get_owner()` iteratively via simulation.
 *
 * Because the sesame contract exposes `get_owner(token_id)` (returns a single
 * owner) rather than a `query_balance(wallet)` function, this SDK helper
 * simulates the `get_owner` check — however, when there is no bulk-balance
 * endpoint on the contract, callers should combine this with off-chain indexing.
 *
 * This overload provides a direct owner lookup for a single token id.
 *
 * @param client  - Configured FarmledgeClient (holds server + network info)
 * @param tokenId - The token id whose owner to look up
 * @returns The Stellar address of the current token owner
 * @throws  {FarmledgeSDKError} If the token does not exist or simulation fails.
 */
export async function queryOwner(
  client: FarmledgeClient,
  tokenId: string,
): Promise<string> {
  const { server, networkPassphrase, sesameContractId } = client

  const feeSource = Keypair.random()
  const fakeAccount = {
    accountId: () => feeSource.publicKey(),
    sequenceNumber: () => '0',
    incrementSequenceNumber: () => undefined,
  }

  const contract = new Contract(sesameContractId)

  const builtTx = new TransactionBuilder(fakeAccount as Parameters<typeof TransactionBuilder>[0], {
    fee: BASE_FEE,
    networkPassphrase,
  })
    .addOperation(
      contract.call(
        'get_owner',
        nativeToScVal(tokenId, { type: 'string' }),
      ),
    )
    .setTimeout(30)
    .build()

  const simResult = await server.simulateTransaction(builtTx)

  if (rpc.Api.isSimulationError(simResult)) {
    throw new FarmledgeSDKError(
      'SIMULATION_FAILED',
      `get_owner simulation failed: ${simResult.error}`,
      simResult,
    )
  }

  const successSim = simResult as rpc.Api.SimulateTransactionSuccessResponse
  if (!successSim.result) {
    throw new FarmledgeSDKError(
      'MALFORMED_RESULT',
      `get_owner returned no result for token ${tokenId}`,
      simResult,
    )
  }

  const ownerAddress = Address.fromScVal(successSim.result.retval)
  return ownerAddress.toString()
}
