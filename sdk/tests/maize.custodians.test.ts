import { Keypair, Networks, Address, Transaction } from '@stellar/stellar-sdk'
import { rpc as StellarRpc } from '@stellar/stellar-sdk'
import { FarmledgeClient } from '../src/client'
import { addCustodian, removeCustodian } from '../src/maize/custodians'

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

/** A stable admin keypair, and a custodian to add/remove. */
const adminKeypair = Keypair.random()
const custodianKeypair = Keypair.random()

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

describe('maize custodians', () => {
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
        .mockResolvedValue(makeAccountStub(adminKeypair.publicKey())),
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

  it('addCustodian builds "add_custodian" with admin + custodian args and returns the hash', async () => {
    const hash = await addCustodian(
      client,
      adminKeypair,
      custodianKeypair.publicKey(),
    )
    expect(hash).toBe(FAKE_TX_HASH)

    // The first argument to simulateTransaction is the built Transaction.
    const txPassedToSim = (mockServer.simulateTransaction as jest.Mock).mock
      .calls[0][0]
    const op = txPassedToSim.operations[0]
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const contractFn = (op.func as any).value()

    const functionName: string = contractFn.functionName().toString()
    expect(functionName).toBe('add_custodian')

    // args[0] = admin address, args[1] = custodian address
    const args = contractFn.args()
    expect(Address.fromScVal(args[0]).toString()).toBe(adminKeypair.publicKey())
    expect(Address.fromScVal(args[1]).toString()).toBe(
      custodianKeypair.publicKey(),
    )
  })

  it('removeCustodian builds "remove_custodian" with admin + custodian args and returns the hash', async () => {
    const hash = await removeCustodian(
      client,
      adminKeypair,
      custodianKeypair.publicKey(),
    )
    expect(hash).toBe(FAKE_TX_HASH)

    const txPassedToSim = (mockServer.simulateTransaction as jest.Mock).mock
      .calls[0][0]
    const op = txPassedToSim.operations[0]
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const contractFn = (op.func as any).value()

    const functionName: string = contractFn.functionName().toString()
    expect(functionName).toBe('remove_custodian')

    const args = contractFn.args()
    expect(Address.fromScVal(args[0]).toString()).toBe(adminKeypair.publicKey())
    expect(Address.fromScVal(args[1]).toString()).toBe(
      custodianKeypair.publicKey(),
    )
  })
})
