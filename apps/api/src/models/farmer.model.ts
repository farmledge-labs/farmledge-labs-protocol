/**
 * Farmer model.
 *
 * Farmledge holds farmer private keys on behalf of smallholder farmers so
 * they never need to manage a seed phrase themselves.  The private key is
 * NEVER stored in plaintext — only the AES-256-GCM ciphertext is persisted.
 */

export interface Farmer {
  /** Unique farmer identifier (e.g. UUID). */
  id: string

  /** Stellar public key (G…) — safe to store and log. */
  publicKey: string

  /**
   * AES-256-GCM encrypted private key.
   *
   * Format (colon-separated, base-64 encoded):
   *   <iv_b64>:<authTag_b64>:<ciphertext_b64>
   *
   * See farmerWalletSigner.service.ts for encrypt/decrypt helpers.
   */
  encryptedPrivateKey: string
}
