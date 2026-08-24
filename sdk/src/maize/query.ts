import {
  TransactionBuilder,
  Contract,
  Address,
  rpc,
  nativeToScVal,
  scValToNative,
  BASE_FEE,
  Keypair,
  xdr,
  StrKey,
} from '@stellar/stellar-sdk'
import type { FarmledgeClient } from '../client'
import { FarmledgeSDKError } from '../errors'

/**
 * Decoded token metadata returned by the maize contract's `query_token()`.
 * Field names mirror the Rust `TokenMetadata` struct from maize-receipt.
 *
 * Note: the maize contract uses the `KN-YYYY-NNNNNN` token id prefix and the
 * `custodian` field is an `Address` (returned as a Stellar G-address string).
 */
export interface MaizeTokenMetadata {
  tokenId: string
  commodity: string
  grade: string
  bagCount: number
  weightPerBagKg: number
  totalWeightKg: number
  warehouseId: string
  /** Stellar address of the custodian who minted this token. */
  custodian: string
  depositTs: bigint
  isLocked: boolean
  parentTokenId: string | null
}

/**
 * Retrieves the on-chain metadata for a maize warehouse-receipt token by
 * invoking `query_token()` on the maize-receipt contract.
 *
 * This is a read-only simulation call — no fee is charged and no transaction
 * is submitted to the network.
 *
 * @param client  - Configured FarmledgeClient (holds server + network info)
 * @param tokenId - The token id to query (format `KN-YYYY-NNNNNN`)
 * @returns Decoded {@link MaizeTokenMetadata} for the token
 * @throws  {FarmledgeSDKError} If the token does not exist (contract returns
 *          TokenNotFound) or simulation fails for another reason.
 */
export async function queryToken(
  client: FarmledgeClient,
  tokenId: string,
): Promise<MaizeTokenMetadata> {
  const { server, networkPassphrase, maizeContractId } = client

  // Use a throwaway keypair for simulation — no auth is required for queries
  const feeSource = Keypair.random()

  // Build a minimal account stub. Queries are pure simulations, so the
  // sequence number and fee-source account do not need to exist on-chain.
  const fakeAccount = {
    accountId: () => feeSource.publicKey(),
    sequenceNumber: () => '0',
    incrementSequenceNumber: () => undefined,
  }

  const contract = new Contract(maizeContractId)

  const builtTx = new TransactionBuilder(
    fakeAccount as ConstructorParameters<typeof TransactionBuilder>[0],
    {
      fee: BASE_FEE,
      networkPassphrase,
    },
  )
    .addOperation(
      contract.call(
        'query_token',
        nativeToScVal(tokenId, { type: 'string' }),
      ),
    )
    .setTimeout(30)
    .build()

  const simResult = await server.simulateTransaction(builtTx)

  if (rpc.Api.isSimulationError(simResult)) {
    throw new FarmledgeSDKError(
      'SIMULATION_FAILED',
      `query_token simulation failed: ${simResult.error}`,
      simResult,
    )
  }

  const successSim = simResult as rpc.Api.SimulateTransactionSuccessResponse
  if (!successSim.result) {
    throw new FarmledgeSDKError(
      'MALFORMED_RESULT',
      `query_token returned no result for token ${tokenId}`,
      simResult,
    )
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const raw: any = scValToNative(successSim.result.retval)

  // The `custodian` field in the maize contract is an `Address` (not a plain
  // string), so scValToNative decodes it as a Uint8Array / Buffer of the raw
  // public key bytes. We normalise it to a G-address string here.
  const custodianRaw = raw.custodian
  const custodian: string = normaliseStellarAddress(custodianRaw)

  return {
    tokenId: raw.token_id as string,
    commodity: raw.commodity as string,
    grade: raw.grade as string,
    bagCount: raw.bag_count as number,
    weightPerBagKg: raw.weight_per_bag_kg as number,
    totalWeightKg: raw.total_weight_kg as number,
    warehouseId: raw.warehouse_id as string,
    custodian,
    depositTs: raw.deposit_ts as bigint,
    isLocked: raw.is_locked as boolean,
    parentTokenId: (raw.parent_token_id ?? null) as string | null,
  }
}

/**
 * Returns the current owner of a maize warehouse-receipt token.
 *
 * The maize contract does not expose a `get_owner()` function (unlike sesame).
 * Owner state is stored at `DataKey::Owner(token_id)` and is retrieved here
 * by simulating a minimal call that returns the Owner storage key via the
 * Soroban RPC `getLedgerEntries` endpoint.
 *
 * Because `getLedgerEntries` requires constructing the storage key manually,
 * this function builds the XDR key for `DataKey::Owner(token_id)` from the
 * contract id and queries it directly — a pure read with no auth required and
 * no fee charged.
 *
 * @param client  - Configured FarmledgeClient (holds server + network info)
 * @param tokenId - The token id whose owner to look up
 * @returns The Stellar address of the current token owner
 * @throws  {FarmledgeSDKError} If the token does not exist or the RPC call fails.
 */
export async function queryOwner(
  client: FarmledgeClient,
  tokenId: string,
): Promise<string> {
  const { server, networkPassphrase, maizeContractId } = client

  // The maize contract does not have a dedicated get_owner() function.
  // We derive the owner by simulating a query_token call (which we already
  // have above) and then reading the Owner key via a separate ledger entry
  // lookup so callers can retrieve the owner without fetching full metadata.
  //
  // Strategy: simulate query_token to confirm the token exists and get the
  // custodian, then use getLedgerEntries to read DataKey::Owner(token_id).
  //
  // DataKey::Owner(token_id) is contracttype enum variant 3 (0-indexed in the
  // Rust enum: Admin=0, Custodians=1, TokenMeta=2, Owner=3, WalletTokens=4,
  // TokenCounter=5, AllTokens=6).

  const contractIdBuffer = Buffer.from(maizeContractId, 'hex').length === 32
    ? Buffer.from(maizeContractId, 'hex')
    : decodeContractIdToBuffer(maizeContractId)

  // Build the XDR for the contract data ledger key:
  //   LedgerKey.contractData(
  //     contract = ScAddress.contract(contractId),
  //     key = ScVal (the DataKey::Owner enum variant with the token_id arg),
  //     durability = ContractDataDurability.instance,
  //   )
  const contractAddress = xdr.ScAddress.scAddressTypeContract(
    xdr.Hash.fromXDR(contractIdBuffer),
  )

  // DataKey::Owner is variant index 3 in the contracttype enum.
  // Soroban encodes contracttype enums as ScVal::ScvMap with a single entry:
  //   { key: ScvSymbol("Owner"), value: ScvString(token_id) }
  // (single-field enum variants are encoded as a map with the variant name as key)
  const ownerKey = xdr.ScVal.scvMap([
    new xdr.ScMapEntry({
      key: xdr.ScVal.scvSymbol('Owner'),
      val: xdr.ScVal.scvString(tokenId),
    }),
  ])

  const ledgerKey = xdr.LedgerKey.contractData(
    new xdr.LedgerKeyContractData({
      contract: contractAddress,
      key: ownerKey,
      durability: xdr.ContractDataDurability.persistent(),
    }),
  )

  let entries: rpc.Api.GetLedgerEntriesResponse
  try {
    entries = await server.getLedgerEntries(ledgerKey)
  } catch (err) {
    throw new FarmledgeSDKError(
      'SIMULATION_FAILED',
      `getLedgerEntries failed for token ${tokenId}: ${String(err)}`,
      err,
    )
  }

  if (!entries.entries || entries.entries.length === 0) {
    throw new FarmledgeSDKError(
      'MALFORMED_RESULT',
      `No owner entry found for maize token ${tokenId} — token may not exist`,
      entries,
    )
  }

  const entry = entries.entries[0]
  const val = entry.val

  if (val.switch().name !== 'contractData') {
    throw new FarmledgeSDKError(
      'MALFORMED_RESULT',
      `Unexpected ledger entry type for token ${tokenId}: ${val.switch().name}`,
      val,
    )
  }

  const dataVal = val.contractData().val()
  const ownerAddress = Address.fromScVal(dataVal)
  return ownerAddress.toString()
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Decodes a Stellar contract id (either a raw hex string or a Soroban contract
 * address prefixed with 'C') to a 32-byte Buffer suitable for use in XDR.
 */
function decodeContractIdToBuffer(contractId: string): Buffer {
  if (contractId.startsWith('C') && contractId.length === 56) {
    // Soroban strkey contract address
    const rawBytes = StrKey.decodeContract(contractId)
    return Buffer.from(rawBytes)
  }
  // Assume raw hex
  return Buffer.from(contractId, 'hex')
}

/**
 * Normalises a raw custodian value from scValToNative to a Stellar G-address.
 *
 * When a Rust `Address` field is decoded via scValToNative it may arrive as:
 *   - A plain string (when the underlying ScVal is an account address) — use as-is
 *   - A Uint8Array / Buffer (raw public key bytes) — encode via StrKey
 * The normalisation handles both cases defensively.
 */
function normaliseStellarAddress(raw: unknown): string {
  if (typeof raw === 'string') {
    return raw
  }

  if (raw instanceof Uint8Array || Buffer.isBuffer(raw as Buffer)) {
    const bytes = Buffer.from(raw as Uint8Array)
    if (bytes.length === 32) {
      // 32-byte raw key — encode as G-address
      return StrKey.encodeEd25519PublicKey(bytes)
    }
  }

  // Fallback: try Address.fromScVal path (caller has the raw ScVal in some
  // decoding paths)
  return String(raw)
}
