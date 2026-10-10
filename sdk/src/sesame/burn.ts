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
 * Burns (redeems) a sesame warehouse-receipt token by invoking `burn()` on the
 * sesame-receipt contract.
 *
 * Only the custodian who originally minted the token may burn it, and only if
 * the token is not locked. The contract rejects mismatched custodians and locked
 * tokens; these surface as {@link TerminalError}.
 *
 * Burning is the on-chain representation of a physical commodity withdrawal —
 * the farmer returns the warehouse receipt and the custodian releases the goods.
 *
 * @param client    - Configured FarmledgeClient (holds server + network info)
 * @param custodian - Keypair of the custodian who issued the token (signs the tx)
 * @param tokenId   - The token id to burn (format `SN-YYYY-NNNNNN`)
 * @returns The transaction hash once the transaction is confirmed SUCCESS
 * @throws  {TerminalError}  If the contract rejects the call or the tx fails
 * @throws  {RetryableError} If all retry attempts are exhausted
 */
export async function burn(
  client: FarmledgeClient,
  custodian: Keypair,
  tokenId: string,
): Promise<string> {
  const { networkPassphrase, sesameContractId } = client

  const result = await executeTransaction({
    client,
    sourcePublicKey: custodian.publicKey(),
    buildOp: (account) => {
      const contract = new Contract(sesameContractId)
      const custodianAddress = Address.fromString(custodian.publicKey())

      return new TransactionBuilder(account, {
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
    },
    signer: keypairSigner(custodian),
  })

  return result.txHash
}
