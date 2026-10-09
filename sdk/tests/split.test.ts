import {
  Keypair,
  Networks,
  Address,
  Transaction,
  nativeToScVal,
  scValToNative,
} from '@stellar/stellar-sdk'
import { rpc as StellarRpc } from '@stellar/stellar-sdk'
import { FarmledgeClient } from '../src/client'
import {
  FarmledgeSDKError,
  InvalidAmountError,
  InvalidWeightError,
  TokenLockedError,
  TokenNotFoundError,
  ContractInvocationError,
} from '../src/errors'
import { splitToken } from '../src/maize/split'

// Mock rpc.assembleTransaction to avoid dealing with real XDR parsing
jest.mock('@stellar/stellar-sdk', () => {
  const actual = jest.requireActual('@stellar/stellar-sdk')
  return {
    ...actual,
    rpc: {
      ...actual.rpc,
      assembleTransaction: jest.fn((tx: Transaction) => {
        // Return a fake "assembled" transaction that's just the input tx
        // with a build() method
        return { build: () => tx }
      }),
    },
  }
})

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MAIZE_CONTRACT_ID = 'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABSC4'

const signerKeypair = Keypair.random()

const FAKE_TX_HASH = 'b'.repeat(64)

const PARENT_TOKEN_ID = 'KN-2026-000001'
const CHILD_A_TOKEN_ID = 'KN-2026-000002'
const CHILD_B_TOKEN_ID = 'KN-2026-000003'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeAccountStub(publicKey: string) {
  return {
    accountId: () => publicKey,
    sequenceNumber: () => '200',
    incrementSequenceNumber: () => undefined,
  }
}

function makeSimulateSuccess() {
  return {
    id: '1',
    latestLedger: 1000,
  } as unknown as StellarRpc.Api.SimulateTransactionResponse
}

/**
 * Builds a getTransaction SUCCESS response whose returnValue encodes the
 * (child_a_id, child_b_id) tuple the contract returns from split().
 *
 * The Soroban SDK encodes a Rust (String, String) tuple as a Vec<ScVal>.
 * scValToNative converts it to a JS array.
 */
function makeGetTransactionSplitSuccess() {
  return {
    status: StellarRpc.Api.GetTransactionStatus.SUCCESS,
    returnValue: nativeToScVal([CHILD_A_TOKEN_ID, CHILD_B_TOKEN_ID]),
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('maize splitToken()', () => {
  let client: FarmledgeClient
  let mockServer: jest.Mocked<Partial<StellarRpc.Server>>

  beforeEach(() => {
    // Reset mock implementations
    const { rpc } = jest.requireMock('@stellar/stellar-sdk')
    rpc.assembleTransaction.mockClear()
    rpc.assembleTransaction.mockImplementation((tx: Transaction) => ({
      build: () => tx,
    }))

    mockServer = {
      getAccount: jest
        .fn()
        .mockResolvedValue(makeAccountStub(signerKeypair.publicKey())),
      simulateTransaction: jest.fn().mockResolvedValue(makeSimulateSuccess()),
      sendTransaction: jest.fn().mockResolvedValue({
        status: 'PENDING',
        hash: FAKE_TX_HASH,
      }),
      getTransaction: jest.fn().mockResolvedValue(makeGetTransactionSplitSuccess()),
    }

    client = new FarmledgeClient({
      rpcUrl: 'https://soroban-testnet.stellar.org',
      networkPassphrase: Networks.TESTNET,
      maizeContractId: MAIZE_CONTRACT_ID,
      sesameContractId: 'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABTOS',
    })
    ;(client as unknown as { server: unknown }).server = mockServer
  })

  // -------------------------------------------------------------------------
  // Success case
  // -------------------------------------------------------------------------

  it('returns parentTokenId, both child token ids, and txHash on success', async () => {
    const result = await splitToken(client, {
      tokenId: PARENT_TOKEN_ID,
      amountKg: 1500,
      signer: signerKeypair,
    })

    expect(result).toEqual({
      parentTokenId: PARENT_TOKEN_ID,
      childA: { tokenId: CHILD_A_TOKEN_ID },
      childB: { tokenId: CHILD_B_TOKEN_ID },
      txHash: FAKE_TX_HASH,
    })
  })

  it('builds the transaction calling "split" with the correct args', async () => {
    await splitToken(client, {
      tokenId: PARENT_TOKEN_ID,
      amountKg: 1000,
      signer: signerKeypair,
    })

    const txPassedToSim = (mockServer.simulateTransaction as jest.Mock).mock
      .calls[0][0]
    const op = txPassedToSim.operations[0]
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const contractFn = (op.func as any).value()

    const functionName: string = contractFn.functionName().toString()
    expect(functionName).toBe('split')

    const args = contractFn.args()
    // args[0] = token_id (String), args[1] = amount_kg (u32)
    expect(scValToNative(args[0])).toBe(PARENT_TOKEN_ID)
    expect(scValToNative(args[1])).toBe(1000)
  })

  it('correctly decodes both child ids from the (String, String) return value', async () => {
    const customChildA = 'KN-2026-000010'
    const customChildB = 'KN-2026-000011'
    ;(mockServer.getTransaction as jest.Mock).mockResolvedValue({
      status: StellarRpc.Api.GetTransactionStatus.SUCCESS,
      returnValue: nativeToScVal([customChildA, customChildB]),
    })

    const result = await splitToken(client, {
      tokenId: PARENT_TOKEN_ID,
      amountKg: 500,
      signer: signerKeypair,
    })

    expect(result.childA.tokenId).toBe(customChildA)
    expect(result.childB.tokenId).toBe(customChildB)
  })

  // -------------------------------------------------------------------------
  // Client-side validation — RPC must NEVER be called
  // -------------------------------------------------------------------------

  describe('InvalidAmountError — no RPC call made', () => {
    const invalidCases: Array<[string, number]> = [
      ['zero', 0],
      ['negative (-5)', -5],
      ['fractional (1.5)', 1.5],
      ['exceeds u32 max (2**32)', 2 ** 32],
    ]

    test.each(invalidCases)('amountKg %s throws InvalidAmountError', async (_label, amountKg) => {
      const promise = splitToken(client, {
        tokenId: PARENT_TOKEN_ID,
        amountKg,
        signer: signerKeypair,
      })

      await expect(promise).rejects.toBeInstanceOf(InvalidAmountError)
      // The RPC must never be contacted
      expect(mockServer.getAccount).not.toHaveBeenCalled()
      expect(mockServer.simulateTransaction).not.toHaveBeenCalled()
      expect(mockServer.sendTransaction).not.toHaveBeenCalled()
    })
  })

  // -------------------------------------------------------------------------
  // Contract-level error mapping from simulation
  // -------------------------------------------------------------------------

  it('maps ContractError #3 (TokenNotFound) → TokenNotFoundError', async () => {
    ;(mockServer.simulateTransaction as jest.Mock).mockResolvedValue({
      id: '1',
      latestLedger: 1000,
      error: 'HostError: Error(Contract, #3)',
    })

    const promise = splitToken(client, {
      tokenId: PARENT_TOKEN_ID,
      amountKg: 1500,
      signer: signerKeypair,
    })

    await expect(promise).rejects.toBeInstanceOf(TokenNotFoundError)
    expect(mockServer.sendTransaction).not.toHaveBeenCalled()
  })

  it('maps ContractError #4 (TokenLocked) → TokenLockedError', async () => {
    ;(mockServer.simulateTransaction as jest.Mock).mockResolvedValue({
      id: '1',
      latestLedger: 1000,
      error: 'HostError: Error(Contract, #4)',
    })

    const promise = splitToken(client, {
      tokenId: PARENT_TOKEN_ID,
      amountKg: 1500,
      signer: signerKeypair,
    })

    await expect(promise).rejects.toBeInstanceOf(TokenLockedError)
    expect(mockServer.sendTransaction).not.toHaveBeenCalled()
  })

  it('maps ContractError #6 (InvalidWeight) → InvalidWeightError', async () => {
    ;(mockServer.simulateTransaction as jest.Mock).mockResolvedValue({
      id: '1',
      latestLedger: 1000,
      error: 'HostError: Error(Contract, #6)',
    })

    const promise = splitToken(client, {
      tokenId: PARENT_TOKEN_ID,
      amountKg: 9999999, // >= total_weight on-chain
      signer: signerKeypair,
    })

    await expect(promise).rejects.toBeInstanceOf(InvalidWeightError)
    expect(mockServer.sendTransaction).not.toHaveBeenCalled()
  })

  it('maps an unknown contract error code → ContractInvocationError with raw code', async () => {
    ;(mockServer.simulateTransaction as jest.Mock).mockResolvedValue({
      id: '1',
      latestLedger: 1000,
      error: 'HostError: Error(Contract, #99)',
    })

    const promise = splitToken(client, {
      tokenId: PARENT_TOKEN_ID,
      amountKg: 1500,
      signer: signerKeypair,
    })

    await expect(promise).rejects.toBeInstanceOf(ContractInvocationError)
    const err = await promise.catch((e) => e as ContractInvocationError)
    expect((err as ContractInvocationError).contractCode).toBe(99)
    expect(mockServer.sendTransaction).not.toHaveBeenCalled()
  })

  it('throws FarmledgeSDKError(SIMULATION_FAILED) for non-contract simulation errors', async () => {
    ;(mockServer.simulateTransaction as jest.Mock).mockResolvedValue({
      id: '1',
      latestLedger: 1000,
      error: 'internal RPC error',
    })

    const promise = splitToken(client, {
      tokenId: PARENT_TOKEN_ID,
      amountKg: 1500,
      signer: signerKeypair,
    })

    await expect(promise).rejects.toBeInstanceOf(FarmledgeSDKError)
    await expect(promise).rejects.toMatchObject({ code: 'SIMULATION_FAILED' })
    expect(mockServer.sendTransaction).not.toHaveBeenCalled()
  })

  // -------------------------------------------------------------------------
  // Submission / on-chain failure
  // -------------------------------------------------------------------------

  it('throws FarmledgeSDKError(SUBMISSION_FAILED) when sendTransaction returns ERROR', async () => {
    ;(mockServer.sendTransaction as jest.Mock).mockResolvedValue({
      status: 'ERROR',
      errorResult: { code: -1 },
    })

    const promise = splitToken(client, {
      tokenId: PARENT_TOKEN_ID,
      amountKg: 1500,
      signer: signerKeypair,
    })

    await expect(promise).rejects.toBeInstanceOf(FarmledgeSDKError)
    await expect(promise).rejects.toMatchObject({ code: 'SUBMISSION_FAILED' })
  })

  it('throws FarmledgeSDKError(TRANSACTION_FAILED) when getTransaction returns FAILED', async () => {
    ;(mockServer.getTransaction as jest.Mock).mockResolvedValue({
      status: StellarRpc.Api.GetTransactionStatus.FAILED,
    })

    const promise = splitToken(client, {
      tokenId: PARENT_TOKEN_ID,
      amountKg: 1500,
      signer: signerKeypair,
    })

    await expect(promise).rejects.toBeInstanceOf(FarmledgeSDKError)
    await expect(promise).rejects.toMatchObject({ code: 'TRANSACTION_FAILED' })
  })
})
