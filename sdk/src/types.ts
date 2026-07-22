// TypeScript interfaces for farmledge-protocol

export interface WarehouseReceipt {
  id: string;
  commodity: string;
  quantity: number;
  unit: string;
  gradeCode: string;
  custodian: string;
  depositor: string;
  issuedAt: number;
  expiresAt: number;
}

export interface MintParams {
  receipt: WarehouseReceipt;
  recipient: string;
}

export interface TransferParams {
  tokenId: string;
  from: string;
  to: string;
}

export interface BurnParams {
  tokenId: string;
  owner: string;
}

export interface QueryParams {
  tokenId: string;
}

export interface TokenRecord {
  tokenId: string;
  receipt: WarehouseReceipt;
  owner: string;
  mintedAt?: number;
  metadataUri?: string;
}

