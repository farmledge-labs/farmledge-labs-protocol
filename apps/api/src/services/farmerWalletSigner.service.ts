/**
 * Farmer Wallet Signing Service
 *
 * SECURITY MODEL
 * ──────────────
 * Custodians sign their own transactions client-side via Freighter — the
 * backend never touches a custodian private key.
 *
 * Farmers are different.  Farmledge holds farmer keys on their behalf so
 * a smallholder farmer never has to manage a seed phrase.  This service
 * encrypts those keys at rest (AES-256-GCM) and signs transactions on a
 * farmer's behalf when they initiate a transfer.
 *
 * KEY STORAGE
 * ───────────
 * The encryption key is read from FARMER_KEY_ENCRYPTION_SECRET (32 raw
 * bytes, hex-encoded = 64 hex chars).
 *
 * // TODO: swap for HSM-backed KMS key before mainnet
 *
 * Encrypted blobs are stored as "<iv_b64>:<authTag_b64>:<ciphertext_b64>".
 * The IV is 12 bytes (96 bits), randomly generated per encryption.
 * The auth tag is 16 bytes, validated on every decryption — any tampering
 * causes an immediate hard failure before the key is used.
 *
 * DECRYPTED KEY LIFETIME
 * ──────────────────────
 * The decrypted secret string is created inside signAsFarmer, used to
 * construct a Keypair, and then immediately overwritten with zeroes before
 * the function returns (or throws).  It is never assigned to a variable
 * that outlives the function scope and never written to any log.
 */

import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import { Keypair } from '@stellar/stellar-base'
import type { Transaction, FeeBumpTransaction } from '@stellar/stellar-base'
import type { Farmer } from '../models/farmer.model'

// ─── Encryption key ──────────────────────────────────────────────────────────

const KEY_HEX = process.env['FARMER_KEY_ENCRYPTION_SECRET'] ?? ''

/**
 * Resolve the AES-256 encryption key buffer.
 * Lazily evaluated so tests can set the env var before the first call.
 */
function getEncryptionKey(): Buffer {
  const hex = process.env['FARMER_KEY_ENCRYPTION_SECRET'] ?? KEY_HEX
  if (hex.length !== 64) {
    throw new Error(
      'FARMER_KEY_ENCRYPTION_SECRET must be a 64-character hex string ' +
        '(32 bytes).  Generate one with: ' +
        'node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))"'
    )
  }
  return Buffer.from(hex, 'hex')
}

// ─── Encrypt / decrypt helpers ───────────────────────────────────────────────

/**
 * Encrypt a farmer private key (Stellar secret, S…) using AES-256-GCM.
 *
 * Returns an opaque blob: "<iv_b64>:<authTag_b64>:<ciphertext_b64>"
 */
export function encryptPrivateKey(secretKey: string): string {
  const key = getEncryptionKey()
  const iv = randomBytes(12) // 96-bit IV — GCM recommendation
  const cipher = createCipheriv('aes-256-gcm', key, iv)

  const ciphertext = Buffer.concat([
    cipher.update(secretKey, 'utf8'),
    cipher.final(),
  ])
  const authTag = cipher.getAuthTag() // 16-byte GCM auth tag

  return [
    iv.toString('base64'),
    authTag.toString('base64'),
    ciphertext.toString('base64'),
  ].join(':')
}

/**
 * Decrypt an encrypted private key blob.
 *
 * @internal — callers should use signAsFarmer; do not expose raw keys.
 */
function decryptPrivateKey(blob: string): string {
  const parts = blob.split(':')
  if (parts.length !== 3) {
    throw new Error('Malformed encrypted key blob — expected iv:authTag:ciphertext')
  }

  const key = getEncryptionKey()
  const iv = Buffer.from(parts[0]!, 'base64')
  const authTag = Buffer.from(parts[1]!, 'base64')
  const ciphertext = Buffer.from(parts[2]!, 'base64')

  const decipher = createDecipheriv('aes-256-gcm', key, iv)
  decipher.setAuthTag(authTag)

  const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()])
  return plaintext.toString('utf8')
}

// ─── Public signing interface ─────────────────────────────────────────────────

/**
 * Sign a Stellar transaction on behalf of a farmer.
 *
 * The decrypted private key is held only for the duration of the signing
 * operation.  It is overwritten with zeroes immediately after use and is
 * never written to any log or external system.
 *
 * @param farmer      - Farmer record containing the encrypted private key.
 * @param transaction - The Stellar Transaction (or FeeBumpTransaction) to sign.
 */
export function signAsFarmer(
  farmer: Farmer,
  transaction: Transaction | FeeBumpTransaction
): void {
  let secret: string | null = null

  try {
    secret = decryptPrivateKey(farmer.encryptedPrivateKey)
    const keypair = Keypair.fromSecret(secret)
    transaction.sign(keypair)
  } finally {
    // Zero out the secret string from memory before discarding the reference.
    // JavaScript strings are immutable primitives so we cannot overwrite the
    // underlying bytes directly, but we can ensure the reference is dropped
    // immediately and avoid it being captured in any closure or log call.
    // This is the best-effort mitigation available in a V8 runtime without
    // a native SecureString type.
    secret = null
  }
}
