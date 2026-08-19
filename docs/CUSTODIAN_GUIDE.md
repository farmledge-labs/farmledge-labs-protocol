# Custodian Guide

## Overview

Custodians are the licensed warehouse operators who accept physical commodity
deposits from farmers, issue warehouse receipt tokens, and release goods when
tokens are redeemed. This guide covers the full lifecycle — from onboarding
your organisation to day-to-day minting, transferring, and burning operations.

Only registered custodians may call `mint()` and `burn()` on the protocol
contracts. The contract admin is responsible for registering custodians
on-chain.

---

## Onboarding Requirements

### Off-chain prerequisites

Before your address can be registered on-chain, you must:

1. Hold a valid Warehousing Certificate issued by the relevant Nigerian
   regulatory authority (e.g., WACOT/AFEX accreditation for grain warehouses,
   or the relevant state ministry for commodity-specific facilities).

2. Have your warehouse(s) physically inspected and approved. Each approved
   location is assigned a `warehouse_id` string that you will use when minting.

3. Submit your Stellar account public key, warehouse IDs, and supporting
   regulatory documents to the Farmledge Labs admin for review.

4. Sign and return the Custodian Agreement, which specifies service-level
   obligations, inspection standards, and liability terms.

### On-chain registration

Once approved, the protocol admin calls:

```ts
import { maizeAddCustodian, sesameAddCustodian } from '@farmledge/protocol-sdk'

// Register on the maize-receipt contract
await maizeAddCustodian(client, adminKeypair, custodianPublicKey)

// Register on the sesame-receipt contract (if applicable)
await sesameAddCustodian(client, adminKeypair, custodianPublicKey)
```

You can verify registration by attempting a simulated `mint()` call — an
`Unauthorized` simulation error indicates the address is not yet registered.

---

## Issuing a Warehouse Receipt

A warehouse receipt is issued when a farmer delivers physical goods to your
facility and the delivery has passed inspection.

### Steps

1. **Receive and weigh the goods.** Record the number of bags and net weight
   per bag. Both values must be greater than zero.

2. **Inspect and grade the lot.** See [Grading Standards](GRADING_STANDARDS.md)
   for criteria and approved grade codes.

3. **Confirm the commodity code.** Use `MAIZE_WHITE` or `MAIZE_YELLOW` for
   maize, and `SESAME` for sesame. Passing an unsupported code will cause the
   transaction to revert.

4. **Call `mint()`** via the SDK, providing the farmer's Stellar public key as
   `farmerWallet`:

```ts
import { maizeMint } from '@farmledge/protocol-sdk'
// or: import { sesameMint } from '@farmledge/protocol-sdk'

const { tokenId, txHash } = await maizeMint(
  client,
  custodianKeypair,   // your Stellar keypair
  farmerPublicKey,    // farmer's Stellar address
  'MAIZE_WHITE',      // commodity code
  'GRADE_A',          // grade code
  200,                // number of bags
  50,                 // kg per bag
  'WH-KD-001',        // your warehouse ID
)

console.log('Issued token:', tokenId)   // e.g. KN-2026-000042
console.log('Transaction:', txHash)
```

5. **Provide the token ID to the farmer** as their proof of deposit. They can
   verify ownership on-chain at any time using `sesameQueryOwner()` /
   `maizeQueryToken()`.

---

## Transferring a Warehouse Receipt

Token transfers are initiated by the current owner (typically the farmer or
a trader who has purchased the receipt). As a custodian you do not normally
call `transfer()` — it is called by the holder.

If you need to reassign a token on behalf of an owner due to an operational
error, this requires burning the original token and re-minting at the corrected
owner address, with documented authorisation from the original holder.

---

## Redeeming a Warehouse Receipt

Redemption (commodity withdrawal) is represented on-chain by burning the token.
Only the original custodian who minted the token may burn it, and only if the
token is not locked.

### Steps

1. **Verify the redeemer.** Confirm the person presenting the receipt owns the
   corresponding token on-chain:

```ts
import { sesameQueryOwner } from '@farmledge/protocol-sdk'

const owner = await sesameQueryOwner(client, tokenId)
// confirm owner matches the presenting party's Stellar address
```

2. **Check the token is not locked.** A locked token is subject to a financing
   arrangement and cannot be redeemed until unlocked by the admin. If
   `isLocked` is `true`, direct the redeemer to the financing party.

3. **Release the physical goods** after the redeemer has signed the physical
   release form.

4. **Call `burn()`** to retire the token:

```ts
import { sesameBurn } from '@farmledge/protocol-sdk'
// or: import { maizeBurn } ... (if such a binding exists)

const txHash = await sesameBurn(client, custodianKeypair, tokenId)
console.log('Token burned:', txHash)
```

5. **File the release documentation.** Retain the burn transaction hash,
   physical release form, and identity document of the redeemer for seven (7)
   years.

---

## Reporting Obligations

Custodians are required to:

- **Daily**: Reconcile physical stock with the on-chain token balances for
  each commodity. Discrepancies must be investigated and reported within 24
  hours.
- **Weekly**: Submit a stock report to Farmledge Labs including total bags,
  weight per commodity, and a list of active token IDs.
- **Quarterly**: Provide a signed attestation from a licensed independent
  inspector confirming that physical holdings match on-chain records.
- **Annually**: Submit to a full audit conducted by a Farmledge Labs-approved
  auditor. Audit reports are kept on file and may be disclosed to regulators.

Any material discrepancy between physical and on-chain holdings must be
escalated to Farmledge Labs within four (4) business hours of discovery.

---

## Security Practices

### Key management

- Store your custodian Stellar keypair in a hardware security module (HSM) or
  a secure cloud key management service (e.g., AWS KMS, HashiCorp Vault).
- Never store private keys in source code, `.env` files committed to version
  control, or shared drives.
- Rotate keypairs at least annually or immediately following any suspected
  compromise. Notify Farmledge Labs so the old key can be removed and the new
  key added on-chain.

### Operational access controls

- Restrict call permissions for `mint()` and `burn()` to dedicated, audited
  service accounts. Operator accounts used for day-to-day access should not
  hold the custodian keypair.
- Implement four-eyes approval for any burn transaction above a threshold
  agreed with Farmledge Labs (default: 100 bags or 5,000 kg).
- Log all mint, transfer, and burn transactions with the operator identity,
  timestamp, and authorisation reference.

### Incident response

In the event of a suspected key compromise:

1. Immediately notify Farmledge Labs at security@farmledge.io.
2. Cease all minting and burning operations.
3. The admin will call `remove_custodian()` to deauthorise the compromised key.
4. Generate a new keypair, complete the re-registration process, and document
   the incident.

Farmledge Labs may suspend a custodian's registration pending investigation of
any reported security incident or stock discrepancy.
