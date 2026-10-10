import {
  TransactionBuilder,
  Contract,
  Keypair,
  Address,
  nativeToScVal,
  BASE_FEE,
} from '@stellar/stellar-sdk'
import type { FarmledgeClient } from '../client'
import { executeTransaction } from '../tx/pipeline'
import { keypairSigner } from '../tx/signer'

/**
 * Transfers ownership of a sesame warehouse-receipt token from one wallet to
 * another by invoking `transfer()` on the sesame-receipt contract.
 *
 * The `from` account must be the current token owner and signs the transaction.
 * The contract rejects the call if `from` is not the owner, or if the token is
 * locked. Any such rejection surfaces as a {@link TerminalError}.
 *
 * @param client   - Configured FarmledgeClient (holds server + network info)
 * @param from     - Keypair of the current token owner (signs the transaction)
 * @param tokenId  - The token id to transfer (format `SN-YYYY-NNNNNN`)
 * @param to       - Address of the new owner
 * @returns The transaction hash once the transaction is confirmed SUCCESS
 * @throws  {TerminalError}  If the contract rejects the call or the tx fails
 * @throws  {RetryableError} If all retry attempts are exhausted
 */
export async function transfer(
  client: FarmledgeClient,
  from: Keypair,
  tokenId: string,
  to: string,
): Promise<string> {
  const { networkPassphrase, sesameContractId } = client

  const result = await executeTransaction({
    client,
    sourcePublicKey: from.publicKey(),
    buildOp: (account) => {
      const contract = new Contract(sesameContractId)
      const fromAddress = Address.fromString(from.publicKey())
      const toAddress = Address.fromString(to)

      return new TransactionBuilder(account, {
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
    },
    signer: keypairSigner(from),
  })

  return result.txHash
}
