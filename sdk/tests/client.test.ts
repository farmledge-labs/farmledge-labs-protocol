import { FarmledgeClient } from '../src/client'
import { Networks } from '@stellar/stellar-sdk'

describe('FarmledgeClient', () => {
  it('instantiates and exposes both contract IDs', () => {
    const client = new FarmledgeClient({
      rpcUrl: 'https://soroban-testnet.stellar.org',
      networkPassphrase: Networks.TESTNET,
      maizeContractId: 'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABSC4',
      sesameContractId: 'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABTOS',
    })

    expect(client).toBeInstanceOf(FarmledgeClient)
    expect(client.maizeContractId).toBe('CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABSC4')
    expect(client.sesameContractId).toBe('CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABTOS')
    expect(client.networkPassphrase).toBe(Networks.TESTNET)
    expect(client.server).toBeDefined()
  })
})
