import {
  TransactionBuilder,
  Contract,
  Keypair,
  Address,
  rpc,
  nativeToScVal,
  scValToNative,
  BASE_FEE,
} from '@stellar/stellar-sdk'
import type { FarmledgeClient } from '../client'
import { FarmledgeSDKError } from '../errors'

/**
 * The result of a successful mint: the freshly-minted token id (contract return
 * value) and the hash of the confirmed transaction.
 *
 * This is the exact shape the platform deposit controller (issue CUST-1)
 * consumes, so keep it stable — backend work depends on it.
 */
export interface MintResult {
  tokenId: string
  txHash: string
}

/**
 * Mints a maize warehouse-receipt token by invoking `mint()` on the
 * maize-receipt contract.
 *
 * The custodian signs the transaction; the contract requires the caller to be a
 * registered custodian and rejects unregistered signers, non-maize commodities,
 * and zero bag-count / weight with a typed error. Any such rejection — as well
 * as submission or confirmation failures — surfaces as a {@link FarmledgeSDKError}.
 *
 * @param client          - Configured FarmledgeClient (holds server + network info)
 * @param custodian       - Keypair of the registered custodian (signs the transaction)
 * @param farmerWallet    - Address of the farmer who receives the minted token
 * @param commodity       - Commodity code (`MAIZE_WHITE` or `MAIZE_YELLOW`)
 * @param grade           - Grade label for the deposited lot
 * @param bagCount        - Number of bags deposited (must be > 0)
 * @param weightPerBagKg  - Weight of each bag in kilograms (must be > 0)
 * @param warehouseId     - Identifier of the warehouse holding the deposit
 * @returns The minted `tokenId` and the confirmed `txHash`
 * @throws  {FarmledgeSDKError} If the contract rejects the call, submission
 *          fails, the transaction fails on-chain, or confirmation times out.
 */
export async function mint(
  client: FarmledgeClient,
  custodian: Keypair,
  farmerWallet: string,
  commodity: string,
  grade: string,
  bagCount: number,
  weightPerBagKg: number,
  warehouseId: string,
): Promise<MintResult> {
  const { server, networkPassphrase, maizeContractId } = client

  // 1. Fetch the custodian account's current sequence number from the RPC
  const account = await server.getAccount(custodian.publicKey())

  // 2. Build the invoke-host-function operation that calls
  //    mint(custodian, farmer_wallet, commodity, grade, bag_count,
  //         weight_per_bag_kg, warehouse_id)
  const contract = new Contract(maizeContractId)
  const custodianAddress = Address.fromString(custodian.publicKey())
  const farmer = Address.fromString(farmerWallet)

  const builtTx = new TransactionBuilder(account, {
    fee: BASE_FEE,
    networkPassphrase,
  })
    .addOperation(
      contract.call(
        'mint',
        custodianAddress.toScVal(),
        farmer.toScVal(),
        nativeToScVal(commodity, { type: 'string' }),
        nativeToScVal(grade, { type: 'string' }),
        nativeToScVal(bagCount, { type: 'u32' }),
        nativeToScVal(weightPerBagKg, { type: 'u32' }),
        nativeToScVal(warehouseId, { type: 'string' }),
      ),
    )
    .setTimeout(30)
    .build()

  // 3. Simulate the transaction to obtain the Soroban resource footprint, then
  //    assemble the final transaction (sets the Soroban data extension).
  //    Contract validation (unauthorized custodian, invalid commodity, zero
  //    weight) surfaces here as a simulation error.
  const simResult = await server.simulateTransaction(builtTx)

  if (rpc.Api.isSimulationError(simResult)) {
    throw new FarmledgeSDKError(
      'SIMULATION_FAILED',
      `Contract rejected mint during simulation: ${simResult.error}`,
      simResult,
    )
  }

  const preparedTx = rpc.assembleTransaction(builtTx, simResult).build()

  // 4. Sign the prepared transaction with the custodian's key
  preparedTx.sign(custodian)

  // 5. Submit to the network
  const sendResult = await server.sendTransaction(preparedTx)

  if (sendResult.status === 'ERROR') {
    throw new FarmledgeSDKError(
      'SUBMISSION_FAILED',
      `Transaction submission failed: ${JSON.stringify(sendResult.errorResult)}`,
      sendResult,
    )
  }

  const txHash = sendResult.hash

  // 6. Poll until the transaction reaches a terminal state (SUCCESS or FAILED)
  const POLL_INTERVAL_MS = 1_000
  const MAX_ATTEMPTS = 30

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    await sleep(POLL_INTERVAL_MS)

    const statusResult = await server.getTransaction(txHash)

    if (statusResult.status === rpc.Api.GetTransactionStatus.SUCCESS) {
      return { tokenId: decodeTokenId(statusResult, txHash), txHash }
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

/**
 * Decodes the `String` token id returned by the contract's `mint()` from the
 * successful transaction's return value.
 */
function decodeTokenId(
  statusResult: rpc.Api.GetSuccessfulTransactionResponse,
  txHash: string,
): string {
  const returnValue = statusResult.returnValue

  if (!returnValue) {
    throw new FarmledgeSDKError(
      'MALFORMED_RESULT',
      `Transaction ${txHash} succeeded but returned no token id`,
      statusResult,
    )
  }

  const tokenId = scValToNative(returnValue)

  if (typeof tokenId !== 'string') {
    throw new FarmledgeSDKError(
      'MALFORMED_RESULT',
      `Transaction ${txHash} returned a non-string token id`,
      returnValue,
    )
  }

  return tokenId
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
