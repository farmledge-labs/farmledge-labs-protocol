/**
 * STELLAR-5 — Reconciliation Job
 *
 * OVERVIEW
 * ────────
 * The Stellar blockchain is the authoritative source of truth for token
 * ownership and metadata.  This job runs every 15 minutes via node-cron and
 * corrects any drift that has accumulated between the local in-memory DB and
 * the live chain state.
 *
 * The DB is NEVER written to the chain — corrections only flow from chain → DB.
 *
 * RECONCILIATION LOGIC
 * ────────────────────
 * For every token currently tracked in the DB:
 *  1. Query the chain for the live token owner (`queryOwner`).
 *  2. If the owner has changed, update the DB record.
 *  3. Query the chain for the live token metadata (`queryToken`).
 *  4. If any metadata field has changed, update the DB record.
 *
 * If a chain query returns "token not found" (contract error that signals the
 * token no longer exists), the DB record is removed.
 *
 * DESIGN PRINCIPLES
 * ─────────────────
 * • The core logic (`runReconciliation`) is a pure async function that accepts
 *   all dependencies via injection — no module-level side effects.
 * • The cron scheduler (`startReconciliationJob`) is the only impure entry
 *   point; it wires the real deps and schedules the job.
 * • Both are exported so unit tests can invoke `runReconciliation` directly
 *   with mocked deps.
 */

import cron from 'node-cron'
import {
  sesameQueryToken,
  sesameQueryOwner,
} from '@farmledge/protocol-sdk'
import type { FarmledgeClient } from '@farmledge/protocol-sdk'
import type { TokenRecord } from '@farmledge/protocol-sdk'

// ─── Types ────────────────────────────────────────────────────────────────────

/**
 * Minimal subset of the token DB interface required by the reconciler.
 * The real in-memory store is a `Map<string, TokenRecord>` accessed through
 * helper functions.  Tests can supply a plain object implementing this shape.
 */
export interface TokenStore {
  /** Return all token IDs currently tracked in the DB. */
  listTokenIds(): string[]
  /** Return the DB record for a given token ID, or undefined if missing. */
  getToken(tokenId: string): TokenRecord | undefined
  /** Overwrite the DB record for a given token ID. */
  setToken(tokenId: string, record: TokenRecord): void
  /** Remove a token from the DB (e.g. because it no longer exists on-chain). */
  deleteToken(tokenId: string): void
}

/**
 * Summary of what the reconciler did on a single run.
 * Returned from `runReconciliation` to aid tests and logging.
 */
export interface ReconciliationSummary {
  /** Total tokens inspected. */
  checked: number
  /** Tokens whose owner was corrected. */
  ownerCorrected: number
  /** Tokens whose metadata was corrected. */
  metadataCorrected: number
  /** Tokens removed because they no longer exist on chain. */
  deleted: number
  /** Per-token errors that did not abort the run. */
  errors: Array<{ tokenId: string; error: string }>
}

// ─── Chain query helpers (injectable for tests) ───────────────────────────────

/**
 * Signatures of the SDK query functions this job depends on.
 * Injected rather than imported directly so tests can mock them without
 * monkey-patching module-level references.
 */
export type QueryTokenFn = typeof sesameQueryToken
export type QueryOwnerFn = typeof sesameQueryOwner

export interface ReconciliationDeps {
  client: FarmledgeClient
  store: TokenStore
  queryToken: QueryTokenFn
  queryOwner: QueryOwnerFn
}

// ─── Core reconciliation logic ────────────────────────────────────────────────

/**
 * Run one reconciliation pass over all tokens in `store`.
 *
 * For each token:
 *  - Query live chain owner; correct DB if drifted.
 *  - Query live chain metadata; correct DB if drifted.
 *  - Remove DB record if the token no longer exists on chain.
 *
 * Errors per token are collected and returned in the summary rather than
 * aborting the entire run — a bad token should not block reconciliation of
 * the rest of the store.
 *
 * @param deps - Injected dependencies (client, store, SDK query functions).
 * @returns   A {@link ReconciliationSummary} describing what was corrected.
 */
export async function runReconciliation(
  deps: ReconciliationDeps
): Promise<ReconciliationSummary> {
  const { client, store, queryToken, queryOwner } = deps

  const summary: ReconciliationSummary = {
    checked: 0,
    ownerCorrected: 0,
    metadataCorrected: 0,
    deleted: 0,
    errors: [],
  }

  const tokenIds = store.listTokenIds()
  summary.checked = tokenIds.length

  for (const tokenId of tokenIds) {
    const dbRecord = store.getToken(tokenId)
    if (!dbRecord) {
      // Removed mid-iteration by a concurrent request — skip silently.
      continue
    }

    try {
      // ── 1. Reconcile owner ────────────────────────────────────────────────
      let chainOwner: string
      try {
        chainOwner = await queryOwner(client, tokenId)
      } catch (err: unknown) {
        if (isTokenNotFoundError(err)) {
          // Token no longer exists on-chain — remove from DB.
          store.deleteToken(tokenId)
          summary.deleted += 1
          continue
        }
        throw err
      }

      let updatedRecord = { ...dbRecord }
      let ownerChanged = false

      if (chainOwner !== dbRecord.owner) {
        updatedRecord = { ...updatedRecord, owner: chainOwner }
        ownerChanged = true
        summary.ownerCorrected += 1
      }

      // ── 2. Reconcile metadata ─────────────────────────────────────────────
      let metadataChanged = false
      try {
        const chainMeta = await queryToken(client, tokenId)

        // Map SesameTokenMetadata → TokenRecord.receipt fields.
        // We compare the fields that appear in WarehouseReceipt.
        const liveReceipt = mapMetadataToReceipt(tokenId, chainMeta)

        if (!receiptsEqual(dbRecord.receipt, liveReceipt)) {
          updatedRecord = { ...updatedRecord, receipt: liveReceipt }
          metadataChanged = true
          summary.metadataCorrected += 1
        }
      } catch (err: unknown) {
        // Token owner reconciled but metadata unavailable — non-fatal.
        // Log and continue with owner correction only.
        summary.errors.push({
          tokenId,
          error: `metadata query failed: ${errorMessage(err)}`,
        })
      }

      // ── 3. Persist corrections ────────────────────────────────────────────
      if (ownerChanged || metadataChanged) {
        store.setToken(tokenId, updatedRecord)
      }
    } catch (err: unknown) {
      summary.errors.push({
        tokenId,
        error: errorMessage(err),
      })
    }
  }

  return summary
}

// ─── Scheduler ────────────────────────────────────────────────────────────────

/**
 * Schedule the reconciliation job to run every 15 minutes.
 *
 * This function has side effects (schedules a cron task, logs to console) and
 * is intentionally the only impure entry point.  Do not call it in tests —
 * test `runReconciliation` directly instead.
 *
 * @param deps - Production dependencies (real Stellar client and live store).
 * @returns    The scheduled cron task (can be stopped with `.stop()`).
 */
export function startReconciliationJob(
  deps: ReconciliationDeps
): ReturnType<typeof cron.schedule> {
  const SCHEDULE = '*/15 * * * *' // every 15 minutes

  const task = cron.schedule(SCHEDULE, async () => {
    const startedAt = new Date().toISOString()
    console.log(`[reconcile] run started at ${startedAt}`)

    try {
      const summary = await runReconciliation(deps)

      console.log(
        `[reconcile] done — checked=${summary.checked} ` +
          `ownerCorrected=${summary.ownerCorrected} ` +
          `metadataCorrected=${summary.metadataCorrected} ` +
          `deleted=${summary.deleted} ` +
          `errors=${summary.errors.length}`
      )

      if (summary.errors.length > 0) {
        for (const e of summary.errors) {
          console.error(`[reconcile] token ${e.tokenId}: ${e.error}`)
        }
      }
    } catch (err: unknown) {
      console.error(`[reconcile] fatal error: ${errorMessage(err)}`)
    }
  })

  console.log(`[reconcile] job scheduled (${SCHEDULE})`)
  return task
}

// ─── Private helpers ──────────────────────────────────────────────────────────

/**
 * Heuristic to detect "token not found" errors from the Soroban contract.
 * The contract encodes this as a simulation error whose message contains
 * "TokenNotFound" or "Error(Contract, #1)" (the first contract error code).
 */
function isTokenNotFoundError(err: unknown): boolean {
  if (!(err instanceof Error)) return false
  return (
    err.message.includes('TokenNotFound') ||
    err.message.includes('Error(Contract, #1)') ||
    err.message.includes('token not found')
  )
}

/** Extract a plain string message from any thrown value. */
function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/**
 * Map SesameTokenMetadata → WarehouseReceipt.
 *
 * This projection lets us store only the fields we care about in the DB
 * while keeping the receipt shape consistent with WarehouseReceipt.
 */
function mapMetadataToReceipt(
  tokenId: string,
  meta: Awaited<ReturnType<QueryTokenFn>>
): TokenRecord['receipt'] {
  return {
    id: tokenId,
    commodity: meta.commodity,
    // SesameTokenMetadata uses total weight; WarehouseReceipt uses quantity.
    quantity: meta.totalWeightKg,
    unit: 'kg',
    gradeCode: meta.grade,
    custodian: meta.custodian,
    // depositor is not directly on chain metadata; use warehouseId as proxy.
    depositor: meta.warehouseId,
    // depositTs is a bigint (seconds); WarehouseReceipt uses a number (ms).
    issuedAt: Number(meta.depositTs) * 1000,
    // No explicit expiry on sesame metadata; default to 0 (unknown).
    expiresAt: 0,
  }
}

/**
 * Deep-compare two WarehouseReceipt objects for equality.
 * Uses only the fields present in the WarehouseReceipt interface.
 */
function receiptsEqual(
  a: TokenRecord['receipt'],
  b: TokenRecord['receipt']
): boolean {
  return (
    a.id === b.id &&
    a.commodity === b.commodity &&
    a.quantity === b.quantity &&
    a.unit === b.unit &&
    a.gradeCode === b.gradeCode &&
    a.custodian === b.custodian &&
    a.depositor === b.depositor &&
    a.issuedAt === b.issuedAt &&
    a.expiresAt === b.expiresAt
  )
}
