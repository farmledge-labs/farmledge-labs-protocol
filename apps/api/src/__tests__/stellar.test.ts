import { FarmledgeClient } from '@farmledge/protocol-sdk'

describe('stellarClient', () => {
  it('instantiates without throwing', () => {
    // Module-level instantiation happens on require(); if it threw the import
    // itself would fail.  We re-import here to make the assertion explicit.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { stellarClient } = require('../lib/stellar') as {
      stellarClient: FarmledgeClient
    }
    expect(stellarClient).toBeInstanceOf(FarmledgeClient)
  })

  it('exposes rpcUrl via server property', () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { stellarClient } = require('../lib/stellar') as {
      stellarClient: FarmledgeClient
    }
    expect(stellarClient.server).toBeDefined()
  })

  it('reads networkPassphrase from env config', () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { stellarClient } = require('../lib/stellar') as {
      stellarClient: FarmledgeClient
    }
    // In test the default network is testnet
    expect(typeof stellarClient.networkPassphrase).toBe('string')
    expect(stellarClient.networkPassphrase.length).toBeGreaterThan(0)
  })
})
