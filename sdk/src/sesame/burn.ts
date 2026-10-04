import {
  TransactionBuilder,
  Contract,
  Keypair,
  Address,
  rpc,
  nativeToScVal,
  BASE_FEE,
} from '@stellar/stellar-sdk'
import type { FarmledgeClient } from '../client'
import { FarmledgeSDKError } from '../errors'

/**
 * Burns (redeems) a sesame warehouse-receipt token by invoking `burn()` on the
 * sesame-receipt contract.
 *
 * Only the custodian who originally minted the token may burn it, and only if
 * the token is not locked. The contract rejects mismatched custodians and locked
 * tokens with typed errors; these surface as {@link FarmledgeSDKError}.
 *
 * Burning is the on-chain representation of a physical commodity withdrawal —
 * the farmer returns the warehouse receipt, and the custodian releases the goods.
 *
 * @param client    - Configured FarmledgeClient (holds server + network info)
 * @param custodian - Keypair of the custodian who issued the token (signs the tx)
 * @param tokenId   - The token id to burn (format `SN-YYYY-NNNNNN`)
 * @returns The transaction hash once the transaction is confirmed SUCCESS
 * @throws  {FarmledgeSDKError} If the contract rejects the call, submission
 *          fails, the transaction fails on-chain, or confirmation times out.
 */
export async function burn(
  client: FarmledgeClient,
  custodian: Keypair,
  tokenId: string,
): Promise<string> {
  const { server, networkPassphrase, sesameContractId } = client

  // 1. Fetch the custodian account's current sequence number from the RPC
  const account = await server.getAccount(custodian.publicKey())

  // 2. Build the invoke-host-function operation that calls
  //    burn(custodian, token_id)
  const contract = new Contract(sesameContractId)
  const custodianAddress = Address.fromString(custodian.publicKey())

  const builtTx = new TransactionBuilder(account, {
    fee: BASE_FEE,
    networkPassphrase,
  })
    .addOperation(
      contract.call(
        'burn',
        custodianAddress.toScVal(),
        nativeToScVal(tokenId, { type: 'string' }),
      ),
    )
    .setTimeout(30)
    .build()

  // 3. Simulate the transaction to obtain the Soroban resource footprint, then
  //    assemble the final transaction. The contract checks that the custodian
  //    matches the token's recorded custodian and that the token is not locked.
  const simResult = await server.simulateTransaction(builtTx)

  if (rpc.Api.isSimulationError(simResult)) {
    throw new FarmledgeSDKError(
      'SIMULATION_FAILED',
      `Contract rejected burn during simulation: ${simResult.error}`,
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
