/**
 * Environment configuration for Stellar / Soroban connectivity.
 *
 * Required environment variables:
 *   STELLAR_NETWORK         - "testnet" | "mainnet"
 *   STELLAR_RPC_URL         - Soroban RPC endpoint  (e.g. https://soroban-testnet.stellar.org)
 *   MAIZE_CONTRACT_ID       - Deployed maize-receipt contract address
 *   SESAME_CONTRACT_ID      - Deployed sesame-receipt contract address
 *
 * Optional:
 *   HORIZON_URL             - Horizon REST endpoint (defaults per network)
 */

export type StellarNetwork = 'testnet' | 'mainnet'

// Passphrase constants sourced from Stellar network definitions — kept here so
// this module has no runtime dependency on @stellar/stellar-sdk.
const NETWORK_PASSPHRASES = {
  testnet: 'Test SDF Network ; September 2015',
  mainnet: 'Public Global Stellar Network ; September 2015',
} as const

const DEFAULTS = {
  testnet: {
    rpcUrl: 'https://soroban-testnet.stellar.org',
    horizonUrl: 'https://horizon-testnet.stellar.org',
    networkPassphrase: NETWORK_PASSPHRASES.testnet,
  },
  mainnet: {
    rpcUrl: 'https://mainnet.stellar.validationcloud.io/v1/XGWqOqGmtB4P4T9P4TkUvA',
    horizonUrl: 'https://horizon.stellar.org',
    networkPassphrase: NETWORK_PASSPHRASES.mainnet,
  },
} as const

function getNetwork(): StellarNetwork {
  const raw = (process.env['STELLAR_NETWORK'] ?? 'testnet').toLowerCase()
  if (raw !== 'testnet' && raw !== 'mainnet') {
    throw new Error(`STELLAR_NETWORK must be "testnet" or "mainnet", got: "${raw}"`)
  }
  return raw
}

export const STELLAR_NETWORK: StellarNetwork = getNetwork()

const networkDefaults = DEFAULTS[STELLAR_NETWORK]

/** Soroban RPC URL — override via STELLAR_RPC_URL */
export const STELLAR_RPC_URL: string =
  process.env['STELLAR_RPC_URL'] ?? networkDefaults.rpcUrl

/** Horizon REST URL — override via HORIZON_URL */
export const HORIZON_URL: string =
  process.env['HORIZON_URL'] ?? networkDefaults.horizonUrl

/** Stellar network passphrase derived from STELLAR_NETWORK */
export const NETWORK_PASSPHRASE: string = networkDefaults.networkPassphrase

/**
 * Contract IDs — must be set explicitly; no safe default exists.
 * In development you can set these to placeholder values; they only
 * matter when transactions are actually submitted.
 */
export const MAIZE_CONTRACT_ID: string =
  process.env['MAIZE_CONTRACT_ID'] ?? ''

export const SESAME_CONTRACT_ID: string =
  process.env['SESAME_CONTRACT_ID'] ?? ''
