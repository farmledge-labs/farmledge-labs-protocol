/**
 * Configured FarmledgeClient singleton.
 *
 * All deposits, transfers, and locks in this service go through this client
 * rather than talking to Soroban directly.
 *
 * Configuration is read from environment variables via env.ts:
 *   STELLAR_NETWORK     - "testnet" | "mainnet"  (default: "testnet")
 *   STELLAR_RPC_URL     - Soroban RPC endpoint   (optional, has per-network default)
 *   HORIZON_URL         - Horizon endpoint        (optional, has per-network default)
 *   MAIZE_CONTRACT_ID   - Deployed maize-receipt contract address
 *   SESAME_CONTRACT_ID  - Deployed sesame-receipt contract address
 */

import { FarmledgeClient } from '@farmledge/protocol-sdk'
import {
  STELLAR_RPC_URL,
  NETWORK_PASSPHRASE,
  MAIZE_CONTRACT_ID,
  SESAME_CONTRACT_ID,
} from './env'

export const stellarClient = new FarmledgeClient({
  rpcUrl: STELLAR_RPC_URL,
  networkPassphrase: NETWORK_PASSPHRASE,
  maizeContractId: MAIZE_CONTRACT_ID,
  sesameContractId: SESAME_CONTRACT_ID,
})
