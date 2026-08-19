# Grading Standards

## Overview

This document defines the grade codes recognised by the farmledge-protocol
contracts, the physical inspection criteria that determine each grade, and the
process custodians must follow when assigning a grade at deposit time.

Grading is performed by a licensed inspector before or at the point of deposit.
The assigned grade is recorded in the `grade` field of the token metadata and
cannot be altered after minting without burning and re-issuing the token.

---

## Maize Grading Criteria

The protocol uses the Nigerian Agricultural Storage and Processing Company
(NASCON) / AFEX Commodities Exchange grading framework as the reference
standard for maize.

| Grade   | Moisture (%)  | Foreign matter (%) | Defective grains (%) | Aflatoxin (ppb) |
|---------|---------------|--------------------|-----------------------|-----------------|
| Grade A | ≤ 13.5        | ≤ 0.5              | ≤ 2.0                 | ≤ 10            |
| Grade B | 13.6 – 14.5   | 0.6 – 1.0          | 2.1 – 5.0             | 11 – 20         |
| Grade C | 14.6 – 15.5   | 1.1 – 2.0          | 5.1 – 8.0             | 21 – 40         |

Commodity codes accepted by the **maize-receipt** contract:

| Code           | Description                     |
|----------------|---------------------------------|
| `MAIZE_WHITE`  | White maize (dent or flint)     |
| `MAIZE_YELLOW` | Yellow maize (dent or flint)    |

Lots with moisture above 15.5 %, foreign matter above 2 %, defective grains
above 8 %, or aflatoxin above 40 ppb are rejected at intake and may not be
deposited.

---

## Sesame Grading Criteria

The protocol uses the Nigerian Export Promotion Council (NEPC) / AFEX
standards for sesame (Sesamum indicum).

| Grade   | Moisture (%) | Oil content (%) | Foreign matter (%) | FFA (% oleic acid) |
|---------|--------------|-----------------|--------------------|--------------------|
| Grade A | ≤ 6.0        | ≥ 50            | ≤ 0.5              | ≤ 2.0              |
| Grade B | 6.1 – 7.0    | 47 – 49.9       | 0.6 – 1.0          | 2.1 – 3.0          |
| Grade C | 7.1 – 8.0    | 44 – 46.9       | 1.1 – 2.0          | 3.1 – 5.0          |

Commodity code accepted by the **sesame-receipt** contract:

| Code     | Description                     |
|----------|---------------------------------|
| `SESAME` | White sesame seeds, hulled      |

Lots with moisture above 8 %, oil content below 44 %, foreign matter above
2 %, or FFA above 5 % are rejected at intake.

---

## Grade Codes

The `grade` field is a free-form string on-chain. Custodians **must** use one
of the standardised codes below to ensure interoperability with downstream
trading and financing platforms:

| Code      | Human-readable label     |
|-----------|--------------------------|
| `GRADE_A` | Grade A (premium)        |
| `GRADE_B` | Grade B (standard)       |
| `GRADE_C` | Grade C (substandard)    |

Custom or non-standard grade strings are accepted by the contract but will not
be parsed by compliant downstream integrations.

---

## Inspection Process

1. **Pre-intake sampling** — the licensed inspector draws representative
   samples from each delivery vehicle using a grain probe. Minimum sample mass:
   2 kg for maize, 500 g for sesame.

2. **Laboratory analysis** — samples are tested for moisture content (oven /
   NIR), foreign matter (sieving), defective grain count (hand-sort), and
   aflatoxin (ELISA or lateral flow). For sesame, oil content (Soxhlet) and
   FFA (titration) are also measured.

3. **Grade assignment** — the inspector assigns the highest grade for which all
   criteria are simultaneously met. If any single criterion falls into a lower
   grade band, the lower grade applies to the whole lot.

4. **Inspection certificate** — the inspector issues a signed physical
   certificate. The custodian keeps the original; a copy accompanies the
   deposit record. The `generateCertificatePdf()` SDK utility can generate a
   complementary on-chain certificate from the token metadata.

5. **Minting** — once the physical goods are weighed and bagged, the custodian
   calls `mint()` with the assigned grade code. The transaction is the
   on-chain record of the deposit.

---

## Dispute Resolution

1. A depositor who disputes the assigned grade must submit a written objection
   to the warehouse within **five (5) business days** of receiving the mint
   transaction hash.

2. The warehouse arranges a re-inspection by a mutually agreed independent
   inspector within **ten (10) business days**.

3. If the re-inspection confirms a different grade, the custodian burns the
   original token and re-mints at the corrected grade. The burn and re-mint
   transaction hashes are appended to the dispute record.

4. All dispute records are kept by the custodian for a minimum of seven (7)
   years and must be produced on request during audits.
