/**
 * pipeline.test.ts
 *
 * Tests for executeTransaction and submitSignedTransaction.
 *
 * Uses a fake RPC server (plain object with jest.fn() methods), a fake sleep
 * that records delays, and a deterministic random (always 0.5).
 *
 * rpc.assembleTransaction is mocked at the module level to return the input
 * transaction unchanged (same approach as the existing binding tests).
 */
import {
  Keypair,
  Networks,
  Transaction,
  nativeToScVal,
} from '@stellar/stellar-sdk'
import { rpc as StellarRpc } from '@stellar/stellar-sdk'
import { FarmledgeClient } from '../src/client'
import {
  RetryableError,
  TerminalError,
  StateArchivedError,
} from '../src/errors'
import {
  executeTransaction,
  submitSignedTransaction,
  type AccountLike,
} from '../src/tx/pipeline'
import { keypairSigner } from '../src/tx/signer'
import * as fs from 'fs'
import * as path from 'path'

// ---------------------------------------------------------------------------
// Mock rpc.assembleTransaction (same approach as binding tests)
// ---------------------------------------------------------------------------
jest.mock('@stellar/stellar-sdk', () => {
  const actual = jest.requireActual('@stellar/stellar-sdk')
  return {
    ...actual,
    rpc: {
      ...actual.rpc,
      assembleTransaction: jest.fn((tx: Transaction) => ({ build: () => tx })),
    },
  }
})

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------
const CONTRACT_ID = 'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABSC4'
const FAKE_TX_HASH = 'a'.repeat(64)
const TOKEN_ID = 'KN-2026-000001'

const signerKeypair = Keypair.random()
const farmerKeypair = Keypair.random()

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeAccountStub(publicKey: string): AccountLike {
  return {
    accountId: () => publicKey,
    sequenceNumber: () => '100',
    incrementSequenceNumber: () => undefined,
  }
}

function makeSimSuccess(): StellarRpc.Api.SimulateTransactionResponse {
  return {
    id: '1',
    latestLedger: 1000,
  } as unknown as StellarRpc.Api.SimulateTransactionResponse
}

function makeSimRestore(): StellarRpc.Api.SimulateTransactionResponse {
  // isSimulationRestore checks: isSimulationSuccess (requires 'transactionData' key
  // at top level) AND 'restorePreamble' in sim AND !!sim.restorePreamble.transactionData
  return {
    id: '1',
    latestLedger: 1000,
    transactionData: 'fakeTransactionData', // satisfies isSimulationSuccess
    restorePreamble: { minResourceFee: '100', transactionData: 'restoreData' },
  } as unknown as StellarRpc.Api.SimulateTransactionResponse
}

function makeSimError(msg = 'HostError: Error(Contract, #2)'): StellarRpc.Api.SimulateTransactionResponse {
  return {
    id: '1',
    latestLedger: 1000,
    error: msg,
  } as unknown as StellarRpc.Api.SimulateTransactionResponse
}

function makeGetTxSuccess(returnValue?: StellarRpc.Api.GetSuccessfulTransactionResponse['returnValue']) {
  return {
    status: StellarRpc.Api.GetTransactionStatus.SUCCESS,
    ledger: 5000,
    returnValue,
  }
}

function makeGetTxFailed() {
  return { status: StellarRpc.Api.GetTransactionStatus.FAILED }
}

function makeGetTxNotFound() {
  return { status: StellarRpc.Api.GetTransactionStatus.NOT_FOUND }
}

function makeFakeSleep() {
  const delays: number[] = []
  const sleep = async (ms: number) => { delays.push(ms) }
  return { sleep, delays }
}

const deterministicRandom = () => 0.5

/**
 * Minimal buildOp factory — builds a real Transaction using the Contract API
 * so that the mock assembleTransaction path is exercised.
 */
function makeBuildOp(networkPassphrase: string, contractId: string) {
  const {
    TransactionBuilder,
    Contract,
    Address,
    BASE_FEE,
  } = jest.requireActual('@stellar/stellar-sdk')

  return (account: AccountLike): Transaction => {
    const contract = new Contract(contractId)
    const adminAddress = Address.fromString(signerKeypair.publicKey())
    return new TransactionBuilder(account, { fee: BASE_FEE, networkPassphrase })
      .addOperation(contract.call('init', adminAddress.toScVal()))
      .setTimeout(30)
      .build()
  }
}

// ---------------------------------------------------------------------------
// Server mock factory
// ---------------------------------------------------------------------------
function makeServer(overrides: Partial<{
  getAccount: jest.Mock
  simulateTransaction: jest.Mock
  sendTransaction: jest.Mock
  getTransaction: jest.Mock
}> = {}) {
  return {
    getAccount: overrides.getAccount ?? jest.fn().mockResolvedValue(
      makeAccountStub(signerKeypair.publicKey()),
    ),
    simulateTransaction: overrides.simulateTransaction ?? jest.fn().mockResolvedValue(makeSimSuccess()),
    sendTransaction: overrides.sendTransaction ?? jest.fn().mockResolvedValue({
      status: 'PENDING',
      hash: FAKE_TX_HASH,
    }),
    getTransaction: overrides.getTransaction ?? jest.fn().mockResolvedValue(makeGetTxSuccess()),
  }
}

function makeClient(server: ReturnType<typeof makeServer>): FarmledgeClient {
  const client = new FarmledgeClient({
    rpcUrl: 'https://soroban-testnet.stellar.org',
    networkPassphrase: Networks.TESTNET,
    maizeContractId: CONTRACT_ID,
    sesameContractId: CONTRACT_ID,
  })
  ;(client as unknown as { server: unknown }).server = server
  return client
}

// ---------------------------------------------------------------------------
// Reset assembleTransaction mock before each test
// ---------------------------------------------------------------------------
beforeEach(() => {
  const { rpc } = jest.requireMock('@stellar/stellar-sdk')
  rpc.assembleTransaction.mockClear()
  rpc.assembleTransaction.mockImplementation((tx: Transaction) => ({ build: () => tx }))
})

// ===========================================================================
// executeTransaction
// ===========================================================================

describe('executeTransaction()', () => {
  const buildOp = makeBuildOp(Networks.TESTNET, CONTRACT_ID)

  // -------------------------------------------------------------------------
  // Basic success
  // -------------------------------------------------------------------------
  it('returns { txHash, ledger, returnValue, attempts: 1 } on first-attempt success', async () => {
    const { sleep } = makeFakeSleep()
    const returnValue = nativeToScVal(TOKEN_ID, { type: 'string' })
    const server = makeServer({
      getTransaction: jest.fn().mockResolvedValue(makeGetTxSuccess(returnValue)),
    })
    const client = makeClient(server)

    const result = await executeTransaction({
      client,
      sourcePublicKey: signerKeypair.publicKey(),
      buildOp,
      signer: keypairSigner(signerKeypair),
      retry: { sleep, random: deterministicRandom },
    })

    expect(result.txHash).toBeTruthy()
    expect(typeof result.txHash).toBe('string')
    expect(result.ledger).toBe(5000)
    expect(result.returnValue).toBe(returnValue)
    expect(result.attempts).toBe(1)
    expect(server.sendTransaction).toHaveBeenCalledTimes(1)
  })

  // -------------------------------------------------------------------------
  // Transient failure on attempt 1, success on attempt 2
  // -------------------------------------------------------------------------
  it('retries a TRY_AGAIN_LATER and succeeds on attempt 2, returning attempts: 2', async () => {
    const { sleep } = makeFakeSleep()
    const sendMock = jest.fn()
      .mockResolvedValueOnce({ status: 'TRY_AGAIN_LATER' })
      .mockResolvedValueOnce({ status: 'PENDING', hash: FAKE_TX_HASH })

    const server = makeServer({ sendTransaction: sendMock })
    const client = makeClient(server)

    const result = await executeTransaction({
      client,
      sourcePublicKey: signerKeypair.publicKey(),
      buildOp,
      signer: keypairSigner(signerKeypair),
      retry: { attempts: 3, sleep, random: deterministicRandom },
    })

    expect(result.attempts).toBe(2)
    expect(sendMock).toHaveBeenCalledTimes(2)
  })

  // -------------------------------------------------------------------------
  // Contract rejection is NOT retried
  // -------------------------------------------------------------------------
  it('does not retry a TerminalError from simulation — exactly one send attempt (zero sends)', async () => {
    const { sleep } = makeFakeSleep()
    const server = makeServer({
      simulateTransaction: jest.fn().mockResolvedValue(makeSimError()),
    })
    const client = makeClient(server)

    await expect(
      executeTransaction({
        client,
        sourcePublicKey: signerKeypair.publicKey(),
        buildOp,
        signer: keypairSigner(signerKeypair),
        retry: { attempts: 5, sleep, random: deterministicRandom },
      }),
    ).rejects.toBeInstanceOf(TerminalError)

    // Never reached sendTransaction
    expect(server.sendTransaction).not.toHaveBeenCalled()
  })

  // -------------------------------------------------------------------------
  // Poll timeout → idempotency check → SUCCESS (no resend)
  // -------------------------------------------------------------------------
  it('poll timeout then getTransaction→SUCCESS returns result and sendTransaction called exactly once', async () => {
    const { sleep } = makeFakeSleep()

    // Produce a poll timeout: return NOT_FOUND for MAX_POLL_ATTEMPTS (30) iterations
    // then SUCCESS on the idempotency check
    const notFoundArray = Array(30).fill(makeGetTxNotFound())
    const getTxMock = jest.fn()
    // First 30 = poll loop (NOT_FOUND = timeout)
    for (const r of notFoundArray) getTxMock.mockResolvedValueOnce(r)
    // 31st = idempotency check → SUCCESS
    getTxMock.mockResolvedValueOnce(makeGetTxSuccess())

    const server = makeServer({ getTransaction: getTxMock })
    const client = makeClient(server)

    const result = await executeTransaction({
      client,
      sourcePublicKey: signerKeypair.publicKey(),
      buildOp,
      signer: keypairSigner(signerKeypair),
      retry: { attempts: 3, sleep, random: deterministicRandom },
    })

    expect(result.attempts).toBe(1)
    // sendTransaction called exactly once — no resend after idempotency check
    expect(server.sendTransaction).toHaveBeenCalledTimes(1)
    expect(getTxMock).toHaveBeenCalledTimes(31) // 30 poll + 1 idempotency
  })

  // -------------------------------------------------------------------------
  // DUPLICATE → poll by hash, no resend
  // -------------------------------------------------------------------------
  it('DUPLICATE send status polls by hash and does not resend', async () => {
    const { sleep } = makeFakeSleep()
    const sendMock = jest.fn().mockResolvedValue({ status: 'DUPLICATE', hash: FAKE_TX_HASH })
    const getTxMock = jest.fn().mockResolvedValue(makeGetTxSuccess())

    const server = makeServer({ sendTransaction: sendMock, getTransaction: getTxMock })
    const client = makeClient(server)

    const result = await executeTransaction({
      client,
      sourcePublicKey: signerKeypair.publicKey(),
      buildOp,
      signer: keypairSigner(signerKeypair),
      retry: { sleep, random: deterministicRandom },
    })

    expect(result.attempts).toBe(1)
    // sendTransaction called exactly once — DUPLICATE does not trigger a resend
    expect(sendMock).toHaveBeenCalledTimes(1)
    expect(getTxMock).toHaveBeenCalledTimes(1)
  })

  // -------------------------------------------------------------------------
  // txBAD_SEQ → rebuild with new sequence number, then succeeds
  // -------------------------------------------------------------------------
  it('txBAD_SEQ triggers exactly one rebuild with a new sequence number, then succeeds', async () => {
    const { sleep } = makeFakeSleep()

    // First send: txBAD_SEQ error
    const badSeqResult = {
      status: 'ERROR',
      errorResult: {
        result: () => ({ switch: () => ({ name: 'txBAD_SEQ' }) }),
      },
      hash: FAKE_TX_HASH,
    }
    const sendMock = jest.fn()
      .mockResolvedValueOnce(badSeqResult)
      .mockResolvedValueOnce({ status: 'PENDING', hash: FAKE_TX_HASH })

    // getAccount returns seq 100 on first call, seq 101 on second (rebuilt)
    const getAccountMock = jest.fn()
      .mockResolvedValueOnce({ ...makeAccountStub(signerKeypair.publicKey()), sequenceNumber: () => '100' })
      .mockResolvedValueOnce({ ...makeAccountStub(signerKeypair.publicKey()), sequenceNumber: () => '101' })

    const server = makeServer({ sendTransaction: sendMock, getAccount: getAccountMock })
    const client = makeClient(server)

    const result = await executeTransaction({
      client,
      sourcePublicKey: signerKeypair.publicKey(),
      buildOp,
      signer: keypairSigner(signerKeypair),
      retry: { attempts: 3, sleep, random: deterministicRandom },
    })

    // Two sends: the BAD_SEQ one and the rebuilt one
    expect(sendMock).toHaveBeenCalledTimes(2)
    // Two account fetches: one per attempt
    expect(getAccountMock).toHaveBeenCalledTimes(2)
    expect(result.attempts).toBe(2)
  })

  // -------------------------------------------------------------------------
  // Retry budget exhaustion
  // -------------------------------------------------------------------------
  it('exhausts retry budget and rethrows the last RetryableError', async () => {
    const { sleep } = makeFakeSleep()
    const sendMock = jest.fn().mockResolvedValue({ status: 'TRY_AGAIN_LATER' })

    const server = makeServer({ sendTransaction: sendMock })
    const client = makeClient(server)

    await expect(
      executeTransaction({
        client,
        sourcePublicKey: signerKeypair.publicKey(),
        buildOp,
        signer: keypairSigner(signerKeypair),
        retry: { attempts: 3, sleep, random: deterministicRandom },
      }),
    ).rejects.toBeInstanceOf(RetryableError)

    expect(sendMock).toHaveBeenCalledTimes(3)
  })

  // -------------------------------------------------------------------------
  // Simulation restore-required → StateArchivedError with restore data
  // -------------------------------------------------------------------------
  it('throws StateArchivedError with restorePreamble when simulation returns restore-required', async () => {
    const { sleep } = makeFakeSleep()
    const server = makeServer({
      simulateTransaction: jest.fn().mockResolvedValue(makeSimRestore()),
    })
    const client = makeClient(server)

    const promise = executeTransaction({
      client,
      sourcePublicKey: signerKeypair.publicKey(),
      buildOp,
      signer: keypairSigner(signerKeypair),
      retry: { sleep, random: deterministicRandom },
    })

    await expect(promise).rejects.toBeInstanceOf(StateArchivedError)
    const err = await promise.catch((e) => e) as StateArchivedError
    expect(err.restorePreamble).toBeTruthy()

    // Never reached sendTransaction
    expect(server.sendTransaction).not.toHaveBeenCalled()
  })

  // -------------------------------------------------------------------------
  // Simulation error → TerminalError (not StateArchivedError)
  // -------------------------------------------------------------------------
  it('throws TerminalError(SIMULATION_FAILED) for a plain simulation error', async () => {
    const { sleep } = makeFakeSleep()
    const server = makeServer({
      simulateTransaction: jest.fn().mockResolvedValue(makeSimError('internal RPC error')),
    })
    const client = makeClient(server)

    await expect(
      executeTransaction({
        client,
        sourcePublicKey: signerKeypair.publicKey(),
        buildOp,
        signer: keypairSigner(signerKeypair),
        retry: { sleep, random: deterministicRandom },
      }),
    ).rejects.toMatchObject({ code: 'SIMULATION_FAILED' })
  })

  // -------------------------------------------------------------------------
  // Backoff delays grow and never exceed maxDelayMs
  // -------------------------------------------------------------------------
  it('backoff delays grow exponentially and never exceed maxDelayMs', async () => {
    const { sleep, delays } = makeFakeSleep()
    const MAX = 1500

    // 4 attempts all fail with TRY_AGAIN_LATER
    const server = makeServer({
      sendTransaction: jest.fn().mockResolvedValue({ status: 'TRY_AGAIN_LATER' }),
    })
    const client = makeClient(server)

    await expect(
      executeTransaction({
        client,
        sourcePublicKey: signerKeypair.publicKey(),
        buildOp,
        signer: keypairSigner(signerKeypair),
        retry: {
          attempts: 4,
          baseDelayMs: 500,
          maxDelayMs: MAX,
          sleep,
          random: deterministicRandom, // jitter factor 0.5
        },
      }),
    ).rejects.toBeInstanceOf(RetryableError)

    // 3 sleeps for 4 attempts
    expect(delays).toHaveLength(3)
    for (const d of delays) {
      expect(d).toBeLessThanOrEqual(MAX)
    }

    // Delays should grow (or plateau at max): first delay < second delay or both at cap
    expect(delays[0]).toBeLessThanOrEqual(delays[1] + 1) // allow equal when capped
  })
})

// ===========================================================================
// submitSignedTransaction
// ===========================================================================

describe('submitSignedTransaction()', () => {
  /**
   * Build a minimal signed XDR using the real SDK so the hash computation
   * inside the pipeline works correctly.
   */
  function makeSignedXdr(): string {
    const {
      TransactionBuilder,
      Contract,
      Address,
      BASE_FEE,
    } = jest.requireActual('@stellar/stellar-sdk')

    const account = makeAccountStub(signerKeypair.publicKey())
    const contract = new Contract(CONTRACT_ID)
    const adminAddress = Address.fromString(signerKeypair.publicKey())
    const tx = new TransactionBuilder(account, {
      fee: BASE_FEE,
      networkPassphrase: Networks.TESTNET,
    })
      .addOperation(contract.call('init', adminAddress.toScVal()))
      .setTimeout(30)
      .build()
    tx.sign(signerKeypair)
    return tx.toEnvelope().toXDR('base64')
  }

  it('succeeds and returns TransactionResult without requiring a signer', async () => {
    const { sleep } = makeFakeSleep()
    const signedXdr = makeSignedXdr()

    const server = makeServer()
    const client = makeClient(server)

    const result = await submitSignedTransaction(client, signedXdr, { sleep, random: deterministicRandom })

    expect(result.txHash).toBeTruthy()
    expect(result.attempts).toBe(1)
    expect(server.sendTransaction).toHaveBeenCalledTimes(1)
  })

  it('retries a transient TRY_AGAIN_LATER and succeeds', async () => {
    const { sleep } = makeFakeSleep()
    const signedXdr = makeSignedXdr()

    const sendMock = jest.fn()
      .mockResolvedValueOnce({ status: 'TRY_AGAIN_LATER' })
      .mockResolvedValueOnce({ status: 'PENDING', hash: FAKE_TX_HASH })

    const server = makeServer({ sendTransaction: sendMock })
    const client = makeClient(server)

    const result = await submitSignedTransaction(client, signedXdr, {
      attempts: 3,
      sleep,
      random: deterministicRandom,
    })

    expect(result.attempts).toBe(2)
    expect(sendMock).toHaveBeenCalledTimes(2)
  })

  it('does not require any signer and never calls getAccount', async () => {
    const { sleep } = makeFakeSleep()
    const signedXdr = makeSignedXdr()

    const server = makeServer()
    const client = makeClient(server)

    await submitSignedTransaction(client, signedXdr, { sleep, random: deterministicRandom })

    // submitSignedTransaction must never fetch an account
    expect(server.getAccount).not.toHaveBeenCalled()
  })
})

// ===========================================================================
// Static scan: no binding may call sendTransaction directly
// ===========================================================================

describe('binding purity', () => {
  it('no file in sdk/src/maize/ contains a direct sendTransaction call', () => {
    const maizeDir = path.resolve(__dirname, '../src/maize')
    const files = fs.readdirSync(maizeDir).filter((f) => f.endsWith('.ts'))

    const violations: string[] = []
    for (const file of files) {
      const content = fs.readFileSync(path.join(maizeDir, file), 'utf-8')
      if (content.includes('sendTransaction')) {
        violations.push(file)
      }
    }

    expect(violations).toEqual([])
  })

  it('no file in sdk/src/sesame/ contains a direct sendTransaction call', () => {
    const sesameDir = path.resolve(__dirname, '../src/sesame')
    const files = fs.readdirSync(sesameDir).filter((f) => f.endsWith('.ts'))

    const violations: string[] = []
    for (const file of files) {
      const content = fs.readFileSync(path.join(sesameDir, file), 'utf-8')
      if (content.includes('sendTransaction')) {
        violations.push(file)
      }
    }

    expect(violations).toEqual([])
  })
})
