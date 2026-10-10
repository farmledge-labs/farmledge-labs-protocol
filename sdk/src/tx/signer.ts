import { Keypair, Transaction, xdr } from '@stellar/stellar-sdk'

/**
 * A function that signs a transaction XDR and returns the signed XDR.
 *
 * Implementations can wrap a local {@link Keypair}, a browser wallet such as
 * Freighter, a hardware wallet (Ledger), or a remote signing service.
 *
 * @param transactionXdr    - Base64-encoded XDR of the unsigned transaction
 * @param networkPassphrase - The network passphrase (used to compute the
 *                            transaction hash that is signed)
 * @returns Base64-encoded XDR of the signed transaction
 */
export type Signer = (
  transactionXdr: string,
  networkPassphrase: string,
) => Promise<string>

/**
 * Creates a {@link Signer} that signs transactions with the given {@link Keypair}.
 *
 * This is the standard signer for server-side custodian flows where the private
 * key is available in memory. For browser-wallet or hardware-wallet flows, use
 * a wallet-specific signer that implements the same `Signer` interface.
 *
 * @param keypair - The Keypair whose secret key will sign transactions
 * @returns A Signer function backed by the given Keypair
 *
 * @example
 * ```ts
 * const signer = keypairSigner(Keypair.fromSecret('S...'))
 * const result = await executeTransaction({ client, buildOp, signer })
 * ```
 */
export function keypairSigner(keypair: Keypair): Signer {
  return async (transactionXdr: string, networkPassphrase: string): Promise<string> => {
    const tx = new Transaction(
      xdr.TransactionEnvelope.fromXDR(transactionXdr, 'base64'),
      networkPassphrase,
    )
    tx.sign(keypair)
    return tx.toEnvelope().toXDR('base64')
  }
}
