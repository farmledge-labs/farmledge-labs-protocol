import {
  TransactionBuilder,
  Contract,
  Keypair,
  Address,
  rpc,
  BASE_FEE,
} from '@stellar/stellar-sdk'
import type { FarmledgeClient } from '../client'
import { FarmledgeSDKError } from '../errors'

/**
 * Initialises the sesame-receipt contract by setting the admin address.
 *
 * This must be called exactly once, immediately after deployment.
 * Subsequent calls will be rejected by the contract with AlreadyInitialized.
 *
 * @param client       - Configured FarmledgeClient (holds server + network info)
 * @param adminKeypair - Keypair of the account that will become contract admin
 * @returns The transaction hash once the transaction is confirmed SUCCESS
 * @throws  {FarmledgeSDKError} If simulation fails, the transaction is rejected
 *          on-chain, or confirmation times out.
 */
export async function init(
  client: FarmledgeClient,
  adminKeypair: Keypair,
): Promise<string> {
  const { server, networkPassphrase, sesameContractId } = client

  // 1. Fetch the admin account's current sequence number from the RPC
  const account = await server.getAccount(adminKeypair.publicKey())

  // 2. Build the invoke-host-function operation that calls init(admin)
  const contract = new Contract(sesameContractId)
  const adminAddress = Address.fromString(adminKeypair.publicKey())

  const builtTx = new TransactionBuilder(account, {
    fee: BASE_FEE,
    networkPassphrase,
  })
    .addOperation(contract.call('init', adminAddress.toScVal()))
    .setTimeout(30)
    .build()

  // 3. Simulate the transaction to obtain the Soroban resource footprint,
  //    then assemble the final transaction (sets the Soroban data extension)
  const simResult = await server.simulateTransaction(builtTx)

  if (rpc.Api.isSimulationError(simResult)) {
    throw new FarmledgeSDKError(
      'SIMULATION_FAILED',
      `Simulation failed: ${simResult.error}`,
      simResult,
    )
  }

  const preparedTx = rpc.assembleTransaction(builtTx, simResult).build()

  // 4. Sign the prepared transaction
  preparedTx.sign(adminKeypair)

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
      return txHash
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
