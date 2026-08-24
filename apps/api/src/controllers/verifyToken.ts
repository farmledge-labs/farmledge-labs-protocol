/**
 * verifyToken — deep on-chain verification report for a warehouse-receipt token.
 *
 * This is the only endpoint in Farmledge that surfaces NGN values.
 * Every other view shows physical quantity only. The NGN estimate here is
 * provided solely for lenders making collateral decisions.
 *
 * Report components
 * -----------------
 * 1. On-chain metadata  — live `query_token()` / `get_token_metadata()` call
 * 2. Owner              — current on-chain owner of the token
 * 3. Custodian status   — whether the minting custodian is still registered
 * 4. Warehouse status   — format validation + known-registry check
 * 5. Lock status        — is the token locked (pledged to another lender)?
 * 6. Split provenance   — does the token have a parent?
 * 7. Estimated value    — totalWeightKg × spot price (NGN) — lender use only
 */

import {
  maizeQueryToken,
  maizeQueryOwner,
  sesameQueryToken,
  sesameQueryOwner,
  type MaizeTokenMetadata,
  type SesameTokenMetadata,
} from '@farmledge/protocol-sdk'
import { xdr, StrKey } from '@stellar/stellar-sdk'
import { stellarClient } from '../lib/stellar'
import { getSpotPriceNgn, type Commodity } from '../lib/prices'
import type { FarmledgeClient } from '@farmledge/protocol-sdk'

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type ContractType = 'maize' | 'sesame'

/** Every possible outcome for the token existence check. */
export type TokenExistsStatus = 'FOUND' | 'NOT_FOUND'

/** Whether the minting custodian address is currently registered on-chain. */
export type CustodianStatus =
  | 'ACTIVE'       // address is still in the Custodians map
  | 'DEREGISTERED' // address was removed from the registry
  | 'UNKNOWN'      // registry check failed (RPC error — report is still returned)

/**
 * Warehouse certificate status.
 *
 * We cannot make external HTTP calls to a regulatory registry, so verification
 * is based on format validation and known-warehouse checks.
 */
export type WarehouseCertStatus =
  | 'FORMAT_VALID'      // warehouseId matches the expected `WH-XX-NNN` pattern
  | 'FORMAT_INVALID'    // warehouseId does not match the expected pattern
  | 'PENDING_VERIFICATION' // format is valid but the warehouse is not in the known list

/** Lock status of the token — a locked token cannot be transferred or burned. */
export type LockStatus = 'UNLOCKED' | 'LOCKED'

/** Full deep verification report returned by verifyToken(). */
export interface VerifyTokenReport {
  /**
   * The token id that was verified.
   */
  tokenId: string

  /**
   * Whether the token was found on-chain at the moment of the query.
   * When `NOT_FOUND`, all other fields except `tokenId` and `contractType`
   * are null.
   */
  tokenExists: TokenExistsStatus

  /** Which contract this token belongs to, derived from the token id prefix. */
  contractType: ContractType

  /**
   * Live on-chain metadata fetched directly from the contract.
   * Null when the token does not exist.
   */
  onChainMetadata: MaizeTokenMetadata | SesameTokenMetadata | null

  /**
   * Current owner of the token (Stellar G-address).
   * Null when the token does not exist or the owner lookup fails.
   */
  currentOwner: string | null

  /**
   * Whether the minting custodian address is still registered on-chain.
   * `UNKNOWN` when the registry check fails for reasons other than deregistration.
   */
  custodianStatus: CustodianStatus | null

  /**
   * The Stellar address of the custodian who minted this token.
   * Null when the token does not exist.
   */
  custodianAddress: string | null

  /**
   * Warehouse certificate status derived from format validation.
   * Null when the token does not exist.
   */
  warehouseCertStatus: WarehouseCertStatus | null

  /**
   * The warehouse id recorded in the token metadata.
   * Null when the token does not exist.
   */
  warehouseId: string | null

  /** Lock status. Null when the token does not exist. */
  lockStatus: LockStatus | null

  /**
   * Whether this token was created by a split() operation.
   * When true, `parentTokenId` holds the original token's id.
   */
  isSplitChild: boolean | null

  /**
   * The id of the parent token if this is a split child, otherwise null.
   */
  parentTokenId: string | null

  /**
   * Estimated collateral value in Nigerian Naira.
   *
   * Calculated as:   totalWeightKg × spotPriceNgn(commodity)
   *
   * IMPORTANT: This figure is indicative only, based on AFEX/ACE market rates
   * sourced from environment configuration. It is not a guaranteed execution
   * price and must not be used as the sole basis for credit decisions.
   *
   * Null when the token does not exist or the commodity is not recognised.
   */
  estimatedValueNgn: number | null

  /**
   * Spot price used to compute estimatedValueNgn (NGN per kg).
   * Null when estimatedValueNgn is null.
   */
  spotPriceNgnPerKg: number | null

  /**
   * Unix timestamp (ms) at which this report was generated.
   */
  verifiedAt: number

  /**
   * Human-readable summary of any non-fatal warnings encountered during
   * verification (e.g. custodian registry check failed, unknown commodity).
   */
  warnings: string[]
}

// ---------------------------------------------------------------------------
// Main function
// ---------------------------------------------------------------------------

/**
 * Produces a deep verification report for any warehouse-receipt token.
 *
 * The contract (maize vs sesame) is inferred from the token id prefix:
 *   - `KN-*`  → maize-receipt contract
 *   - `SN-*`  → sesame-receipt contract
 *
 * All on-chain checks are done via simulation — no fee is charged and no
 * transaction is submitted.
 *
 * @param tokenId - Token id to verify (e.g. `KN-2026-000042` or `SN-2026-000007`)
 * @param client  - Optional FarmledgeClient override; defaults to the
 *                  singleton from lib/stellar.ts (useful for testing)
 * @returns A fully-populated {@link VerifyTokenReport}
 */
export async function verifyToken(
  tokenId: string,
  client: FarmledgeClient = stellarClient,
): Promise<VerifyTokenReport> {
  const warnings: string[] = []
  const verifiedAt = Date.now()

  // --- 1. Determine which contract to query --------------------------------
  const contractType = detectContractType(tokenId)
  if (!contractType) {
    // Unrecognised prefix — return a minimal NOT_FOUND report
    return {
      tokenId,
      tokenExists: 'NOT_FOUND',
      contractType: 'maize', // placeholder — prefix is invalid
      onChainMetadata: null,
      currentOwner: null,
      custodianStatus: null,
      custodianAddress: null,
      warehouseCertStatus: null,
      warehouseId: null,
      lockStatus: null,
      isSplitChild: null,
      parentTokenId: null,
      estimatedValueNgn: null,
      spotPriceNgnPerKg: null,
      verifiedAt,
      warnings: [`Token id "${tokenId}" has an unrecognised prefix. Expected KN-* (maize) or SN-* (sesame).`],
    }
  }

  // --- 2. Live on-chain metadata query -------------------------------------
  let metadata: MaizeTokenMetadata | SesameTokenMetadata | null = null

  try {
    if (contractType === 'maize') {
      metadata = await maizeQueryToken(client, tokenId)
    } else {
      metadata = await sesameQueryToken(client, tokenId)
    }
  } catch (err) {
    // If the simulation returns TokenNotFound the contract throws; treat any
    // error as NOT_FOUND and record a warning in case it was an RPC issue.
    const msg = err instanceof Error ? err.message : String(err)
    warnings.push(`On-chain metadata query failed: ${msg}`)
    return {
      tokenId,
      tokenExists: 'NOT_FOUND',
      contractType,
      onChainMetadata: null,
      currentOwner: null,
      custodianStatus: null,
      custodianAddress: null,
      warehouseCertStatus: null,
      warehouseId: null,
      lockStatus: null,
      isSplitChild: null,
      parentTokenId: null,
      estimatedValueNgn: null,
      spotPriceNgnPerKg: null,
      verifiedAt,
      warnings,
    }
  }

  // Token found — extract shared fields (both metadata shapes have these)
  const custodianAddress: string = metadata.custodian
  const warehouseId: string = metadata.warehouseId
  const isLocked: boolean = metadata.isLocked
  const totalWeightKg: number = metadata.totalWeightKg
  const parentTokenId: string | null = metadata.parentTokenId ?? null

  // --- 3. Owner lookup ------------------------------------------------------
  let currentOwner: string | null = null
  try {
    if (contractType === 'maize') {
      currentOwner = await maizeQueryOwner(client, tokenId)
    } else {
      currentOwner = await sesameQueryOwner(client, tokenId)
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    warnings.push(`Owner lookup failed (non-fatal): ${msg}`)
  }

  // --- 4. Custodian status --------------------------------------------------
  let custodianStatus: CustodianStatus = 'UNKNOWN'
  try {
    const isRegistered = await checkCustodianRegistered(
      client,
      contractType,
      custodianAddress,
    )
    custodianStatus = isRegistered ? 'ACTIVE' : 'DEREGISTERED'
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    warnings.push(`Custodian registry check failed (non-fatal): ${msg}`)
  }

  // --- 5. Warehouse cert status --------------------------------------------
  const warehouseCertStatus = evaluateWarehouseCertStatus(warehouseId)

  // --- 6. Estimated value --------------------------------------------------
  let estimatedValueNgn: number | null = null
  let spotPriceNgnPerKg: number | null = null

  const commodity = metadata.commodity as string
  if (isSupportedCommodity(commodity)) {
    try {
      spotPriceNgnPerKg = getSpotPriceNgn(commodity as Commodity)
      estimatedValueNgn = Math.round(totalWeightKg * spotPriceNgnPerKg)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      warnings.push(`NGN price lookup failed (non-fatal): ${msg}`)
    }
  } else {
    warnings.push(
      `Commodity "${commodity}" is not in the recognised price list — estimatedValueNgn omitted`,
    )
  }

  // --- 7. Assemble report ---------------------------------------------------
  return {
    tokenId,
    tokenExists: 'FOUND',
    contractType,
    onChainMetadata: metadata,
    currentOwner,
    custodianStatus,
    custodianAddress,
    warehouseCertStatus,
    warehouseId,
    lockStatus: isLocked ? 'LOCKED' : 'UNLOCKED',
    isSplitChild: parentTokenId !== null,
    parentTokenId,
    estimatedValueNgn,
    spotPriceNgnPerKg,
    verifiedAt,
    warnings,
  }
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Detects the contract type from the token id prefix.
 * Returns null for unrecognised prefixes.
 */
function detectContractType(tokenId: string): ContractType | null {
  if (tokenId.startsWith('KN-')) return 'maize'
  if (tokenId.startsWith('SN-')) return 'sesame'
  return null
}

/**
 * Checks whether a custodian address is currently registered in the on-chain
 * custodians map.
 *
 * The Custodians map is stored at `DataKey::Custodians` (instance storage,
 * no per-key argument). We fetch the entire map via `getLedgerEntries` and
 * check whether the custodian's address appears as a key with value `true`.
 *
 * Both contracts use the same `DataKey::Custodians` layout (enum variant 1,
 * no inner data — a unit variant encoded as an ScvSymbol "Custodians").
 */
async function checkCustodianRegistered(
  client: FarmledgeClient,
  contractType: ContractType,
  custodianAddress: string,
): Promise<boolean> {
  const contractId =
    contractType === 'maize' ? client.maizeContractId : client.sesameContractId

  const contractIdBuffer = decodeContractIdToBuffer(contractId)
  const contractAddressXdr = xdr.ScAddress.scAddressTypeContract(
    xdr.Hash.fromXDR(contractIdBuffer),
  )

  // DataKey::Custodians is a unit enum variant (no inner data).
  // Soroban encodes unit contracttype variants as ScvSymbol("<VariantName>").
  const custodianMapKey = xdr.ScVal.scvSymbol('Custodians')

  const ledgerKey = xdr.LedgerKey.contractData(
    new xdr.LedgerKeyContractData({
      contract: contractAddressXdr,
      key: custodianMapKey,
      durability: xdr.ContractDataDurability.persistent(),
    }),
  )

  const entries = await client.server.getLedgerEntries(ledgerKey)

  if (!entries.entries || entries.entries.length === 0) {
    // No custodians have been registered yet — definitely not registered
    return false
  }

  const entry = entries.entries[0]
  const entryVal = entry.val

  if (entryVal.switch().name !== 'contractData') {
    return false
  }

  // The stored value is a Map<Address, bool>
  // scValToNative on a Soroban Map returns a Map<string, unknown>
  // We iterate the raw ScvMap to check for a matching address key.
  const mapVal = entryVal.contractData().val()

  if (mapVal.switch().name !== 'scvMap') {
    return false
  }

  const mapEntries = mapVal.map() ?? []

  // The custodian address stored in the Map key is an Address (account or
  // contract). We normalise both sides to G-address strings for comparison.
  for (const mapEntry of mapEntries) {
    try {
      const keyAddr = addressFromScVal(mapEntry.key())
      if (keyAddr === custodianAddress) {
        // Value should be ScvBool(true)
        const val = mapEntry.val()
        return val.switch().name === 'scvBool' && val.b() === true
      }
    } catch {
      // Skip entries we cannot decode
    }
  }

  return false
}

/**
 * Evaluates the warehouse certificate status from the warehouseId string.
 *
 * The expected format is `WH-<2-letter-state-code>-<digits>` (e.g. WH-KD-001).
 * Without an external registry this is format validation only.
 */
function evaluateWarehouseCertStatus(warehouseId: string): WarehouseCertStatus {
  // Expected pattern: WH-XX-NNN (letters, digits, hyphens, 2+ chars per segment)
  const WAREHOUSE_ID_PATTERN = /^WH-[A-Z]{2,}-\d{3,}$/i

  if (!WAREHOUSE_ID_PATTERN.test(warehouseId)) {
    return 'FORMAT_INVALID'
  }

  // Format is valid. Without a live registry call we cannot confirm the cert
  // is current, so we flag it for downstream verification.
  return 'PENDING_VERIFICATION'
}

/**
 * Narrows a commodity string to the supported Commodity union type.
 */
function isSupportedCommodity(commodity: string): commodity is Commodity {
  return (
    commodity === 'MAIZE_WHITE' ||
    commodity === 'MAIZE_YELLOW' ||
    commodity === 'SESAME'
  )
}

/**
 * Decodes a Stellar contract id (raw hex or Soroban C-address) to a 32-byte
 * Buffer suitable for XDR construction.
 */
function decodeContractIdToBuffer(contractId: string): Buffer {
  if (contractId.startsWith('C') && contractId.length === 56) {
    return Buffer.from(StrKey.decodeContract(contractId))
  }
  return Buffer.from(contractId, 'hex')
}

/**
 * Extracts a Stellar G-address (or contract C-address) string from an ScVal
 * that represents an address.
 */
function addressFromScVal(val: xdr.ScVal): string {
  const name = val.switch().name
  if (name === 'scvAddress') {
    const addr = val.address()
    const addrType = addr.switch().name
    if (addrType === 'scAddressTypeAccount') {
      const accountId = addr.accountId()
      const publicKey = accountId.ed25519()
      return StrKey.encodeEd25519PublicKey(publicKey)
    }
    if (addrType === 'scAddressTypeContract') {
      const hash = addr.contractId()
      return StrKey.encodeContract(hash)
    }
  }
  throw new Error(`Cannot extract address from ScVal type: ${name}`)
}
