export { FarmledgeClient } from './client'
export { FarmledgeSDKError } from './errors';
export type { FarmledgeSDKErrorCode } from './errors';
export { generateCertificatePdf } from './lib/pdf/certificate';

// Maize bindings
export { init as maizeInit } from './maize/init';
export {
  addCustodian as maizeAddCustodian,
  removeCustodian as maizeRemoveCustodian,
} from './maize/custodians';
export { mint as maizeMint } from './maize/mint';
export type { MintResult as MaizeMintResult } from './maize/mint';

// Sesame bindings
export { init as sesameInit } from './sesame/init';
export {
  addCustodian as sesameAddCustodian,
  removeCustodian as sesameRemoveCustodian,
} from './sesame/custodians';
export { mint as sesameMint } from './sesame/mint';
export type { MintResult as SesameMintResult } from './sesame/mint';
export { transfer as sesameTransfer } from './sesame/transfer';
export { burn as sesameBurn } from './sesame/burn';
export {
  queryToken as sesameQueryToken,
  queryOwner as sesameQueryOwner,
} from './sesame/query';
export type { SesameTokenMetadata } from './sesame/query';

export * from './types';
export const FARMLEDGE_PROTOCOL_VERSION = '0.1.0';

