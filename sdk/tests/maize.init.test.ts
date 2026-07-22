import { Keypair, Networks, Address, Transaction } from '@stellar/stellar-sdk'
import { rpc as StellarRpc } from '@stellar/stellar-sdk'
import { FarmledgeClient } from '../src/client'
import { init } from '../src/maize/init'

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

/** A stable admin keypair derived from a known seed, so XDR is deterministic. */
const adminKeypair = Keypair.random()

/** Fake transaction hash returned by sendTransaction. */
const FAKE_TX_HASH = 'a'.repeat(64)

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
// Build a minimal SimulateTransactionResponse that passes isSimulationError check.
// ---------------------------------------------------------------------------
function makeSimulateSuccess() {
  // `isSimulationError` checks for the presence of an `error` key.
  // If missing, it's treated as success.
  return {
    id: '1',
    latestLedger: 1000,
  } as unknown as StellarRpc.Api.SimulateTransactionResponse
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('maize init()', () => {
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
      getAccount: jest.fn().mockResolvedValue(makeAccountStub(adminKeypair.publicKey())),
      simulateTransaction: jest.fn().mockResolvedValue(makeSimulateSuccess()),
      sendTransaction: jest.fn().mockResolvedValue({
        status: 'PENDING',
        hash: FAKE_TX_HASH,
      }),
      getTransaction: jest.fn().mockResolvedValue({
        status: StellarRpc.Api.GetTransactionStatus.SUCCESS,
      }),
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

  it('returns the transaction hash on success', async () => {
    const hash = await init(client, adminKeypair)
    expect(hash).toBe(FAKE_TX_HASH)
  })

  it('calls simulateTransaction before sendTransaction', async () => {
    await init(client, adminKeypair)
    expect(mockServer.simulateTransaction).toHaveBeenCalledTimes(1)
    // simulateTransaction must be called before sendTransaction
    const simOrder = (mockServer.simulateTransaction as jest.Mock).mock.invocationCallOrder[0]
    const sendOrder = (mockServer.sendTransaction as jest.Mock).mock.invocationCallOrder[0]
    expect(simOrder).toBeLessThan(sendOrder)
  })

  it('builds the transaction with the correct function name "init"', async () => {
    await init(client, adminKeypair)

    // The first argument to simulateTransaction is the built Transaction.
    const txPassedToSim = (mockServer.simulateTransaction as jest.Mock).mock.calls[0][0]

    // Decode the first operation's function name from the XDR union value.
    // op.func is a HostFunction XDR union; .value() gives the InvokeContractArgs arm.
    const op = txPassedToSim.operations[0]
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const contractFn = (op.func as any).value()
    const functionName: string = contractFn.functionName().toString()
    expect(functionName).toBe('init')
  })

  it('passes the admin public key as the first argument', async () => {
    await init(client, adminKeypair)

    const txPassedToSim = (mockServer.simulateTransaction as jest.Mock).mock.calls[0][0]
    const op = txPassedToSim.operations[0]
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const contractFn = (op.func as any).value()
    const args = contractFn.args()

    // The first argument should encode the admin's public key as an Address ScVal
    const addressArg = Address.fromScVal(args[0])
    expect(addressArg.toString()).toBe(adminKeypair.publicKey())
  })

  it('polls getTransaction until SUCCESS and returns hash', async () => {
    // Return NOT_FOUND twice, then SUCCESS on the third poll
    ;(mockServer.getTransaction as jest.Mock)
      .mockResolvedValueOnce({ status: StellarRpc.Api.GetTransactionStatus.NOT_FOUND })
      .mockResolvedValueOnce({ status: StellarRpc.Api.GetTransactionStatus.NOT_FOUND })
      .mockResolvedValueOnce({ status: StellarRpc.Api.GetTransactionStatus.SUCCESS })

    const hash = await init(client, adminKeypair)
    expect(hash).toBe(FAKE_TX_HASH)
    expect(mockServer.getTransaction).toHaveBeenCalledTimes(3)
  })

  it('throws when the transaction fails on-chain', async () => {
    ;(mockServer.getTransaction as jest.Mock).mockResolvedValue({
      status: StellarRpc.Api.GetTransactionStatus.FAILED,
    })

    await expect(init(client, adminKeypair)).rejects.toThrow(
      /failed on-chain/i,
    )
  })

  it('throws when simulation returns an error', async () => {
    ;(mockServer.simulateTransaction as jest.Mock).mockResolvedValue({
      id: '1',
      latestLedger: 1000,
      error: 'HostError: Contract error',
    })

    await expect(init(client, adminKeypair)).rejects.toThrow(
      /simulation failed/i,
    )
  })

  it('throws when sendTransaction returns ERROR status', async () => {
    ;(mockServer.sendTransaction as jest.Mock).mockResolvedValue({
      status: 'ERROR',
      errorResult: { message: 'bad tx' },
      hash: FAKE_TX_HASH,
    })

    await expect(init(client, adminKeypair)).rejects.toThrow(
      /transaction submission failed/i,
    )
  })
})
