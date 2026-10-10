import {
  TransactionBuilder,
  Contract,
  Keypair,
  Address,
  BASE_FEE,
} from '@stellar/stellar-sdk'
import type { FarmledgeClient } from '../client'
import { executeTransaction } from '../tx/pipeline'
import { keypairSigner } from '../tx/signer'

/**
 * Initialises the sesame-receipt contract by setting the admin address.
 *
 * This must be called exactly once, immediately after deployment.
 * Subsequent calls will be rejected by the contract with AlreadyInitialized.
 *
 * @param client       - Configured FarmledgeClient (holds server + network info)
 * @param adminKeypair - Keypair of the account that will become contract admin
 * @returns The transaction hash once the transaction is confirmed SUCCESS
 * @throws  {TerminalError}  If simulation fails or the transaction is rejected on-chain
 * @throws  {RetryableError} If all retry attempts are exhausted
 */
export async function init(
  client: FarmledgeClient,
  adminKeypair: Keypair,
): Promise<string> {
  const { networkPassphrase, sesameContractId } = client

  const result = await executeTransaction({
    client,
    sourcePublicKey: adminKeypair.publicKey(),
    buildOp: (account) => {
      const contract = new Contract(sesameContractId)
      const adminAddress = Address.fromString(adminKeypair.publicKey())

      return new TransactionBuilder(account, {
        fee: BASE_FEE,
        networkPassphrase,
      })
        .addOperation(contract.call('init', adminAddress.toScVal()))
        .setTimeout(30)
        .build()
    },
    signer: keypairSigner(adminKeypair),
  })

  return result.txHash
}
