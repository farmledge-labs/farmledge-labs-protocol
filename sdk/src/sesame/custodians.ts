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
 * Registers a custodian on the sesame-receipt contract.
 *
 * Custodians must be registered on-chain before they can mint sesame tokens.
 * Only the contract admin may call this; the contract rejects any other signer
 * with Unauthorized.
 *
 * @param client           - Configured FarmledgeClient
 * @param adminKeypair     - Keypair of the contract admin (signs the transaction)
 * @param custodianAddress - Address of the account to register as a custodian
 * @returns The transaction hash once the transaction is confirmed SUCCESS
 * @throws  {TerminalError}  If simulation fails or the contract rejects the call
 * @throws  {RetryableError} If all retry attempts are exhausted
 */
export async function addCustodian(
  client: FarmledgeClient,
  adminKeypair: Keypair,
  custodianAddress: string,
): Promise<string> {
  return invokeCustodian(client, adminKeypair, custodianAddress, 'add_custodian')
}

/**
 * Removes a custodian from the sesame-receipt contract.
 *
 * Only the contract admin may call this; the contract rejects any other signer
 * with Unauthorized.
 *
 * @param client           - Configured FarmledgeClient
 * @param adminKeypair     - Keypair of the contract admin (signs the transaction)
 * @param custodianAddress - Address of the custodian to remove
 * @returns The transaction hash once the transaction is confirmed SUCCESS
 * @throws  {TerminalError}  If simulation fails or the contract rejects the call
 * @throws  {RetryableError} If all retry attempts are exhausted
 */
export async function removeCustodian(
  client: FarmledgeClient,
  adminKeypair: Keypair,
  custodianAddress: string,
): Promise<string> {
  return invokeCustodian(client, adminKeypair, custodianAddress, 'remove_custodian')
}

/**
 * Shared invoke path for custodian-management functions.
 */
async function invokeCustodian(
  client: FarmledgeClient,
  adminKeypair: Keypair,
  custodianAddress: string,
  functionName: 'add_custodian' | 'remove_custodian',
): Promise<string> {
  const { networkPassphrase, sesameContractId } = client

  const result = await executeTransaction({
    client,
    sourcePublicKey: adminKeypair.publicKey(),
    buildOp: (account) => {
      const contract = new Contract(sesameContractId)
      const adminAddr = Address.fromString(adminKeypair.publicKey())
      const custodian = Address.fromString(custodianAddress)

      return new TransactionBuilder(account, {
        fee: BASE_FEE,
        networkPassphrase,
      })
        .addOperation(
          contract.call(functionName, adminAddr.toScVal(), custodian.toScVal()),
        )
        .setTimeout(30)
        .build()
    },
    signer: keypairSigner(adminKeypair),
  })

  return result.txHash
}
