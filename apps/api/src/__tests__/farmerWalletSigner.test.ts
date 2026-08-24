/**
 * Tests for farmerWalletSigner.service.ts
 *
 * Coverage:
 *  1. Encryption round-trip — encrypt then decrypt returns the original secret.
 *  2. signAsFarmer adds a valid signature to a Stellar transaction.
 *  3. Decrypted key never appears in console output (log-leak check).
 *  4. Auth-tag tampering causes decryption to throw before the key is used.
 *  5. Invalid encryption key length throws a clear error.
 */

import { Keypair, Transaction, TransactionBuilder, Networks, BASE_FEE } from '@stellar/stellar-base'
import { encryptPrivateKey, signAsFarmer } from '../services/farmerWalletSigner.service'
import type { Farmer } from '../models/farmer.model'

// ── Test encryption key (32 bytes, hex) ──────────────────────────────────────
const TEST_KEY_HEX = 'a'.repeat(64) // 32 bytes of 0xaa — deterministic for tests

beforeAll(() => {
  process.env['FARMER_KEY_ENCRYPTION_SECRET'] = TEST_KEY_HEX
})

afterAll(() => {
  delete process.env['FARMER_KEY_ENCRYPTION_SECRET']
})

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Build a minimal, valid Stellar transaction. */
function buildTransaction(sourcePublicKey: string): Transaction {
  const account = { accountId: () => sourcePublicKey, sequenceNumber: () => '1', incrementSequenceNumber() {} } as unknown as import('@stellar/stellar-base').Account
  return new TransactionBuilder(account, {
    fee: BASE_FEE,
    networkPassphrase: Networks.TESTNET,
  })
    .setTimeout(30)
    .build() as Transaction
}

// ─── 1. Encryption round-trip ────────────────────────────────────────────────

describe('encryptPrivateKey', () => {
  it('round-trip: encrypting then decrypting returns the original secret', () => {
    const keypair = Keypair.random()
    const original = keypair.secret()

    const blob = encryptPrivateKey(original)

    // Blob must not contain the plaintext secret
    expect(blob).not.toContain(original)

    // Reconstructing via signAsFarmer proves round-trip without exposing decrypt
    const farmer: Farmer = {
      id: 'test-farmer-1',
      publicKey: keypair.publicKey(),
      encryptedPrivateKey: blob,
    }
    const tx = buildTransaction(keypair.publicKey())
    expect(() => signAsFarmer(farmer, tx)).not.toThrow()

    // Verify the signature is valid for the keypair
    const hash = tx.hash()
    const sig = tx.signatures[0]!.signature()
    expect(keypair.verify(hash, sig)).toBe(true)
  })

  it('produces different ciphertexts for repeated encryptions of the same key (IV randomness)', () => {
    const secret = Keypair.random().secret()
    const blob1 = encryptPrivateKey(secret)
    const blob2 = encryptPrivateKey(secret)
    expect(blob1).not.toBe(blob2)
  })

  it('blob format is <iv>:<authTag>:<ciphertext> (3 colon-separated segments)', () => {
    const blob = encryptPrivateKey(Keypair.random().secret())
    const parts = blob.split(':')
    expect(parts).toHaveLength(3)
    parts.forEach((part) => expect(part.length).toBeGreaterThan(0))
  })
})

// ─── 2. signAsFarmer ─────────────────────────────────────────────────────────

describe('signAsFarmer', () => {
  it('adds exactly one signature to an unsigned transaction', () => {
    const keypair = Keypair.random()
    const farmer: Farmer = {
      id: 'test-farmer-2',
      publicKey: keypair.publicKey(),
      encryptedPrivateKey: encryptPrivateKey(keypair.secret()),
    }
    const tx = buildTransaction(keypair.publicKey())

    expect(tx.signatures).toHaveLength(0)
    signAsFarmer(farmer, tx)
    expect(tx.signatures).toHaveLength(1)
  })

  it('throws if the encrypted blob is tampered with (auth tag mismatch)', () => {
    const keypair = Keypair.random()
    const blob = encryptPrivateKey(keypair.secret())

    // Flip a character in the ciphertext segment (last part)
    const parts = blob.split(':')
    const cipherB64 = parts[2]!
    const tampered = cipherB64.slice(0, -1) + (cipherB64.slice(-1) === 'A' ? 'B' : 'A')
    const tamperedBlob = [parts[0], parts[1], tampered].join(':')

    const farmer: Farmer = {
      id: 'test-farmer-tampered',
      publicKey: keypair.publicKey(),
      encryptedPrivateKey: tamperedBlob,
    }
    const tx = buildTransaction(keypair.publicKey())

    expect(() => signAsFarmer(farmer, tx)).toThrow()
  })
})

// ─── 3. Decrypted key never appears in logs ───────────────────────────────────

describe('key leak prevention', () => {
  it('the decrypted private key is never written to console.log or console.error', () => {
    const keypair = Keypair.random()
    const secret = keypair.secret()
    const farmer: Farmer = {
      id: 'test-farmer-leak',
      publicKey: keypair.publicKey(),
      encryptedPrivateKey: encryptPrivateKey(secret),
    }

    const logSpy = jest.spyOn(console, 'log').mockImplementation(() => {})
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {})
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {})

    const tx = buildTransaction(keypair.publicKey())
    signAsFarmer(farmer, tx)

    const allCalls = [
      ...logSpy.mock.calls,
      ...errorSpy.mock.calls,
      ...warnSpy.mock.calls,
    ]
      .flat()
      .map(String)
      .join(' ')

    expect(allCalls).not.toContain(secret)

    logSpy.mockRestore()
    errorSpy.mockRestore()
    warnSpy.mockRestore()
  })
})

// ─── 4. Missing or bad encryption key ────────────────────────────────────────

describe('configuration errors', () => {
  it('throws a descriptive error when FARMER_KEY_ENCRYPTION_SECRET is wrong length', () => {
    const original = process.env['FARMER_KEY_ENCRYPTION_SECRET']
    process.env['FARMER_KEY_ENCRYPTION_SECRET'] = 'tooshort'

    // Jest module cache means getEncryptionKey() is called at call-time
    expect(() => encryptPrivateKey('STEST')).toThrow(/FARMER_KEY_ENCRYPTION_SECRET/)

    process.env['FARMER_KEY_ENCRYPTION_SECRET'] = original
  })
})
