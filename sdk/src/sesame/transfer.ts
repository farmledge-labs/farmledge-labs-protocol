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
 * Transfers ownership of a sesame warehouse-receipt token from one wallet to
 * another by invoking `transfer()` on the sesame-receipt contract.
 *
 * The `from` account must be the current token owner and signs the transaction.
 * The contract rejects the call if `from` is not the owner, or if the token is
 * locked. Any such rejection surfaces as a {@link FarmledgeSDKError}.
 *
 * @param client   - Configured FarmledgeClient (holds server + network info)
 * @param from     - Keypair of the current token owner (signs the transaction)
 * @param tokenId  - The token id to transfer (format `SN-YYYY-NNNNNN`)
 * @param to       - Address of the new owner
 * @returns The transaction hash once the transaction is confirmed SUCCESS
 * @throws  {FarmledgeSDKError} If the contract rejects the call, submission
 *          fails, the transaction fails on-chain, or confirmation times out.
 */
export async function transfer(
  client: FarmledgeClient,
  from: Keypair,
  tokenId: string,
  to: string,
): Promise<string> {
  const { server, networkPassphrase, sesameContractId } = client

  // 1. Fetch the sender account's current sequence number from the RPC
  const account = await server.getAccount(from.publicKey())

  // 2. Build the invoke-host-function operation that calls
  //    transfer(token_id, from, to)
  const contract = new Contract(sesameContractId)
  const fromAddress = Address.fromString(from.publicKey())
  const toAddress = Address.fromString(to)

  const builtTx = new TransactionBuilder(account, {
    fee: BASE_FEE,
    networkPassphrase,
  })
    .addOperation(
      contract.call(
        'transfer',
        nativeToScVal(tokenId, { type: 'string' }),
        fromAddress.toScVal(),
        toAddress.toScVal(),
      ),
    )
    .setTimeout(30)
    .build()

  // 3. Simulate the transaction to obtain the Soroban resource footprint, then
  //    assemble the final transaction. The contract checks that `from` is the
  //    owner and that the token is not locked.
  const simResult = await server.simulateTransaction(builtTx)

  if (rpc.Api.isSimulationError(simResult)) {
    throw new FarmledgeSDKError(
      'SIMULATION_FAILED',
      `Contract rejected transfer during simulation: ${simResult.error}`,
      simResult,
    )
  }

  const preparedTx = rpc.assembleTransaction(builtTx, simResult).build()

  // 4. Sign the prepared transaction with the sender's key
  preparedTx.sign(from)

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
