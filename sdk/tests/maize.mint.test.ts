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
import { FarmledgeSDKError } from '../src/errors'
import { mint } from '../src/maize/mint'

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
// Helpers — minimal stubs that satisfy the Stellar SDK type shapes
// ---------------------------------------------------------------------------

/** A well-formed testnet contract ID (56-char C... Stellar address). */
const MAIZE_CONTRACT_ID = 'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABSC4'

/** A custodian (signer) and the farmer wallet that receives the token. */
const custodianKeypair = Keypair.random()
const farmerKeypair = Keypair.random()

/** Fake transaction hash returned by sendTransaction. */
const FAKE_TX_HASH = 'a'.repeat(64)

/** The token id the contract "returns" from mint(). */
const MINTED_TOKEN_ID = 'KN-2026-000001'

// ---------------------------------------------------------------------------
// Build a minimal Account stub that TransactionBuilder accepts.
// ---------------------------------------------------------------------------
function makeAccountStub(publicKey: string) {
  return {
    accountId: () => publicKey,
    sequenceNumber: () => '100',
    incrementSequenceNumber: () => undefined,
  }
}

// ---------------------------------------------------------------------------
// Build a minimal SimulateTransactionResponse that passes isSimulationError.
// ---------------------------------------------------------------------------
function makeSimulateSuccess() {
  // `isSimulationError` checks for the presence of an `error` key.
  // If missing, it's treated as success.
  return {
    id: '1',
    latestLedger: 1000,
  } as unknown as StellarRpc.Api.SimulateTransactionResponse
}

/** A SUCCESS getTransaction response carrying the encoded token id. */
function makeGetTransactionSuccess() {
  return {
    status: StellarRpc.Api.GetTransactionStatus.SUCCESS,
    returnValue: nativeToScVal(MINTED_TOKEN_ID, { type: 'string' }),
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('maize mint()', () => {
  let client: FarmledgeClient
  let mockServer: jest.Mocked<Partial<StellarRpc.Server>>

  beforeEach(() => {
    // Reset the mock implementation
    const { rpc } = jest.requireMock('@stellar/stellar-sdk')
    rpc.assembleTransaction.mockClear()
    rpc.assembleTransaction.mockImplementation((tx: Transaction) => ({
      build: () => tx,
    }))

    // Build a partial mock for rpc.Server
    mockServer = {
      getAccount: jest
        .fn()
        .mockResolvedValue(makeAccountStub(custodianKeypair.publicKey())),
      simulateTransaction: jest.fn().mockResolvedValue(makeSimulateSuccess()),
      sendTransaction: jest.fn().mockResolvedValue({
        status: 'PENDING',
        hash: FAKE_TX_HASH,
      }),
      getTransaction: jest
        .fn()
        .mockResolvedValue(makeGetTransactionSuccess()),
    }

    // Create client and replace its server with our mock
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
  it('returns the minted tokenId and txHash on success', async () => {
    const result = await mint(
      client,
      custodianKeypair,
      farmerKeypair.publicKey(),
      'MAIZE_WHITE',
      'Grade A',
      10,
      50,
      'warehouse-1',
    )

    expect(result).toEqual({ tokenId: MINTED_TOKEN_ID, txHash: FAKE_TX_HASH })
  })

  it('builds the transaction calling "mint" with the correct args', async () => {
    await mint(
      client,
      custodianKeypair,
      farmerKeypair.publicKey(),
      'MAIZE_WHITE',
      'Grade A',
      10,
      50,
      'warehouse-1',
    )

    // The first argument to simulateTransaction is the built Transaction.
    const txPassedToSim = (mockServer.simulateTransaction as jest.Mock).mock
      .calls[0][0]
    const op = txPassedToSim.operations[0]
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const contractFn = (op.func as any).value()

    const functionName: string = contractFn.functionName().toString()
    expect(functionName).toBe('mint')

    const args = contractFn.args()
    // args[0] = custodian, args[1] = farmer wallet
    expect(Address.fromScVal(args[0]).toString()).toBe(
      custodianKeypair.publicKey(),
    )
    expect(Address.fromScVal(args[1]).toString()).toBe(
      farmerKeypair.publicKey(),
    )
    // args[2..6] = commodity, grade, bagCount, weightPerBagKg, warehouseId
    expect(scValToNative(args[2])).toBe('MAIZE_WHITE')
    expect(scValToNative(args[3])).toBe('Grade A')
    expect(scValToNative(args[4])).toBe(10)
    expect(scValToNative(args[5])).toBe(50)
    expect(scValToNative(args[6])).toBe('warehouse-1')
  })

  // -------------------------------------------------------------------------
  // Contract-rejection case
  // -------------------------------------------------------------------------
  it('throws a typed FarmledgeSDKError when the contract rejects the mint', async () => {
    // e.g. an unregistered custodian or invalid commodity is rejected during
    // simulation with a HostError.
    ;(mockServer.simulateTransaction as jest.Mock).mockResolvedValue({
      id: '1',
      latestLedger: 1000,
      error: 'HostError: Error(Contract, #2)', // Unauthorized
    })

    const promise = mint(
      client,
      custodianKeypair,
      farmerKeypair.publicKey(),
      'MAIZE_WHITE',
      'Grade A',
      10,
      50,
      'warehouse-1',
    )

    await expect(promise).rejects.toBeInstanceOf(FarmledgeSDKError)
    await expect(promise).rejects.toMatchObject({ code: 'SIMULATION_FAILED' })
    // sendTransaction must never be reached once the contract rejects.
    expect(mockServer.sendTransaction).not.toHaveBeenCalled()
  })
})
