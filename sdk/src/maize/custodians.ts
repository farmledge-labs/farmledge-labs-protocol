import {
  TransactionBuilder,
  Contract,
  Keypair,
  Address,
  rpc,
  BASE_FEE,
} from '@stellar/stellar-sdk'
import type { FarmledgeClient } from '../client'

/**
 * Registers a custodian on the maize-receipt contract.
 *
 * Custodians must be registered on-chain before they can mint. Only the
 * contract admin may call this; the contract rejects any other signer with
 * Unauthorized.
 *
 * @param client         - Configured FarmledgeClient (holds server + network info)
 * @param adminKeypair   - Keypair of the contract admin (signs the transaction)
 * @param custodianAddress - Address of the account to register as a custodian
 * @returns The transaction hash once the transaction is confirmed SUCCESS
 * @throws  If the transaction fails or the RPC poll times out
 */
export async function addCustodian(
  client: FarmledgeClient,
  adminKeypair: Keypair,
  custodianAddress: string,
): Promise<string> {
  return invokeCustodian(client, adminKeypair, custodianAddress, 'add_custodian')
}

/**
 * Removes a custodian from the maize-receipt contract.
 *
 * Only the contract admin may call this; the contract rejects any other signer
 * with Unauthorized.
 *
 * @param client         - Configured FarmledgeClient (holds server + network info)
 * @param adminKeypair   - Keypair of the contract admin (signs the transaction)
 * @param custodianAddress - Address of the custodian to remove
 * @returns The transaction hash once the transaction is confirmed SUCCESS
 * @throws  If the transaction fails or the RPC poll times out
 */
export async function removeCustodian(
  client: FarmledgeClient,
  adminKeypair: Keypair,
  custodianAddress: string,
): Promise<string> {
  return invokeCustodian(
    client,
    adminKeypair,
    custodianAddress,
    'remove_custodian',
  )
}

/**
 * Shared invoke path for the custodian-management contract functions.
 * Both add_custodian and remove_custodian take (admin, custodian) and differ
 * only by the invoked function name.
 */
async function invokeCustodian(
  client: FarmledgeClient,
  adminKeypair: Keypair,
  custodianAddress: string,
  functionName: 'add_custodian' | 'remove_custodian',
): Promise<string> {
  const { server, networkPassphrase, maizeContractId } = client

  // 1. Fetch the admin account's current sequence number from the RPC
  const account = await server.getAccount(adminKeypair.publicKey())

  // 2. Build the invoke-host-function operation that calls
  //    <functionName>(admin, custodian)
  const contract = new Contract(maizeContractId)
  const adminAddress = Address.fromString(adminKeypair.publicKey())
  const custodian = Address.fromString(custodianAddress)

  const builtTx = new TransactionBuilder(account, {
    fee: BASE_FEE,
    networkPassphrase,
  })
    .addOperation(
      contract.call(functionName, adminAddress.toScVal(), custodian.toScVal()),
    )
    .setTimeout(30)
    .build()

  // 3. Simulate the transaction to obtain the Soroban resource footprint,
  //    then assemble the final transaction (sets the Soroban data extension)
  const simResult = await server.simulateTransaction(builtTx)

  if (rpc.Api.isSimulationError(simResult)) {
    throw new Error(`Simulation failed: ${simResult.error}`)
  }

  const preparedTx = rpc.assembleTransaction(builtTx, simResult).build()

  // 4. Sign the prepared transaction
  preparedTx.sign(adminKeypair)

  // 5. Submit to the network
  const sendResult = await server.sendTransaction(preparedTx)

  if (sendResult.status === 'ERROR') {
    throw new Error(
      `Transaction submission failed: ${JSON.stringify(sendResult.errorResult)}`,
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
      throw new Error(`Transaction ${txHash} failed on-chain`)
    }

    // NOT_FOUND means the transaction is still pending — keep polling
  }

  throw new Error(
    `Transaction ${txHash} did not confirm within ${MAX_ATTEMPTS} seconds`,
  )
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
