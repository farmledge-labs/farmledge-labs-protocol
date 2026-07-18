import { rpc, Networks } from '@stellar/stellar-sdk'

export class FarmledgeClient {
  server: rpc.Server
  networkPassphrase: string
  maizeContractId: string
  sesameContractId: string

  constructor(config: {
    rpcUrl: string
    networkPassphrase: string
    maizeContractId: string
    sesameContractId: string
  }) {
    this.server = new rpc.Server(config.rpcUrl)
    this.networkPassphrase = config.networkPassphrase
    this.maizeContractId = config.maizeContractId
    this.sesameContractId = config.sesameContractId
  }
}
