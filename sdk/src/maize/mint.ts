import {
  TransactionBuilder,
  Contract,
  Keypair,
  Address,
  nativeToScVal,
  scValToNative,
  BASE_FEE,
} from '@stellar/stellar-sdk'
import type { FarmledgeClient } from '../client'
import { FarmledgeSDKError } from '../errors'
import { executeTransaction } from '../tx/pipeline'
import { keypairSigner } from '../tx/signer'

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
  const { networkPassphrase, maizeContractId } = client

  const result = await executeTransaction({
    client,
    sourcePublicKey: custodian.publicKey(),
    buildOp: (account) => {
      const contract = new Contract(maizeContractId)
      const custodianAddress = Address.fromString(custodian.publicKey())
      const farmer = Address.fromString(farmerWallet)

      return new TransactionBuilder(account, {
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
    },
    signer: keypairSigner(custodian),
  })

  const txHash = result.txHash

  if (!result.returnValue) {
    throw new FarmledgeSDKError(
      'MALFORMED_RESULT',
      `Transaction ${txHash} succeeded but returned no token id`,
      result,
    )
  }

  const tokenId = scValToNative(result.returnValue)

  if (typeof tokenId !== 'string') {
    throw new FarmledgeSDKError(
      'MALFORMED_RESULT',
      `Transaction ${txHash} returned a non-string token id`,
      result.returnValue,
    )
  }

  return { tokenId, txHash }
}
