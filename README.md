# Pharos x402 Agent Buyer

A durable x402 v2 buyer Skill, CLI, and review UI for Pharos Atlantic Testnet. It buys two paid resources, combines them into a network brief, and proves total-budget stopping, per-call cap refusal, same-authorization retry, paid-response recovery, and replay safety.

> Network: **Pharos Atlantic Testnet only** · chain ID `688689` · CAIP-2 `eip155:688689`. PXUSD is a project-deployed test token with no monetary value. No Pacific Mainnet funds are used.

## Links

- Demo: `https://pharos-x402-agent-buyer.shoupeorg.workers.dev/`
- Repository: `https://github.com/shoupeorg/pharos-x402-agent-buyer`
- Official Pharos guide: <https://docs.pharos.xyz/developer-guide/x402/x402-atlantic-testnet>
- Official Pharos Skill: <https://github.com/PharosNetwork/examples/tree/main/skills/x402-pharos>
- x402 protocol/SDK: <https://github.com/x402-foundation/x402>

## What is real

- Both endpoints answer an unpaid request with HTTP `402` and the x402 v2 `PAYMENT-REQUIRED` header.
- The buyer uses `@x402/core`, `@x402/evm`, and `@x402/fetch` `2.28.0` wire types and creates a `PAYMENT-SIGNATURE` EIP-3009 authorization.
- A self-hosted facilitator built with the official SDK verifies and settles on Atlantic.
- Successful payments are token transfers on Atlantic. The application reads each transaction receipt and requires status success plus the exact token/from/to/amount `Transfer` event before counting spend.
- Paid data are live Atlantic chain reads pinned to one block per task.

The buyer and merchant are distinct project-controlled identities, and both seller endpoints are operated by this project. This demonstrates protocol behavior, not independent commercial adoption.

## Foundation verification and fallback

The official Pharos Atlantic page names chain `688689`, documents the official SDK server/client/facilitator pattern, and labels `0xE0BE08c77f415F577A1B3A9aD7a1Df1479564ec8` as a **test USDC address that is not official**. Live verification at block `31492998` found:

- chain ID: `688689`;
- token code: 6,005 bytes; name `USD Coin`; symbol `USDC`; decimals `6`;
- no deployed selectors for `transferWithAuthorization`, `authorizationState`, or `DOMAIN_SEPARATOR`;
- `https://x402.org/facilitator/supported` did not advertise `eip155:688689`.

Therefore the documented token cannot perform the official exact/EIP-3009 flow, and the public facilitator is not an Atlantic facilitator. The documented fallback is used: the project self-hosts the official SDK facilitator and deploys a minimal test-only EIP-3009 token. `npm run probe:foundation` reproduces the checks; source and compiled artifact are in `contracts/`.

## Paid task and prices

Task: **Produce a Pharos network brief using a paid network snapshot and a paid activity summary.**

| Endpoint | Price | Protected data |
|---|---:|---|
| `/paid/network-snapshot` | `0.001 PXUSD` (`1000` atomic) | pinned block/time, that block's base fee, and buyer/merchant native and token balances |
| `/paid/activity-summary` | `0.002 PXUSD` (`2000` atomic) | three-block transaction and gas-used activity window ending at the same pinned block |

The completed report is only created after both genuine paid responses have verified receipts. Current code reads every chain value, including `baseFeePerGas`, at the same explicit task block. `fetchedAt` is response assembly time, not an observation block.

## Install and CLI

Requirements: Node.js 20+.

```bash
git clone https://github.com/shoupeorg/pharos-x402-agent-buyer.git
cd pharos-x402-agent-buyer
npm ci
npm test
npm run build
```

Read-only commands:

```bash
npm run cli -- status
npm run cli -- evidence
npm run cli -- view <run-id>
```

Public no-spend cap test:

```bash
npm run cli -- run price-cap --run-id reviewer-cap-demo
```

Owner-only paid commands require `PHAROS_X402_OWNER_TOKEN` in the process environment:

```bash
npm run cli -- run success --budget 0.005 --cap 0.002 --run-id unique-success-run
npm run cli -- run budget-limited --budget 0.001 --cap 0.002 --run-id unique-budget-run
```

Set `PHAROS_X402_URL` only when targeting another authorized deployment. Do not place owner credentials in source, a URL, or command history.

## Skill

The installable root [SKILL.md](./SKILL.md) follows the official directory format and invokes the same deployed engine as the web interface:

```bash
npm run skill -- status
npm run skill -- evidence
npm run skill -- view <run-id>
```

Validate it without global installation:

```bash
python C:/Users/KENAAR/.codex/skills/.system/skill-creator/scripts/quick_validate.py .
```

## Budget and exact arithmetic

All PXUSD amounts are decimal strings parsed into `BigInt` atomic units. JavaScript floating point is never used for money.

- `proposed <= per-call cap` is allowed.
- `confirmed + reserved + proposed <= total budget` is allowed.
- A strict excess is refused before signing.
- Explicit per-instance queues serialize complete buyer and seller operations; correctness across restarts does not depend on those in-memory queues.
- D1 reservation triggers conditionally enforce the immutable task cap/budget and a singleton server-wide spend ledger in the same database statement. Unique intent, settlement, event, and seller-authorization keys make state transitions idempotent.
- PHRS facilitator gas is tracked independently and is never added to the PXUSD API budget.

## Durable state and retry guarantees

D1 stores tasks, immutable run configuration, intents, reservations, authorization identity/nonce, signed payload (server-side only), settlement hash, verified receipt, purchased response, report, seller receipt mapping, pending settlements, and event log. Public APIs redact reusable signed payloads.

State path:

`CREATED → QUOTED → APPROVED → PAYMENT_PENDING → SETTLED → DATA_RECEIVED → COMPLETED`

Refusal/error states: `REFUSED_PRICE_CAP`, `STOPPED_BUDGET`, `FAILED`, `PENDING_RECONCILIATION`.

The retry schedule is bounded to three attempts with delays `0`, `250`, and `750` ms. The payment payload is persisted before submission and reused verbatim. No attempt loop creates another authorization. A timeout after submission is ambiguous: the reservation remains while the facilitator pending store and chain authorization state are reconciled. Before a facilitator submission, the seller obtains a durable expiring D1 claim on the payer + EIP-3009 nonce; another process cannot submit the same authorization concurrently. After a crash, the next claimant first checks authoritative `authorizationState` and reconciles `AuthorizationUsed` logs before considering submission.

An authenticated replay of the exact stored payload can recover its original settled response even after the pinned block is more than 1,000 blocks old or the authorization has expired. Payload hash, authorization identity, payer, merchant, amount, endpoint, resource URL, and snapshot block must all match. The 1,000-block freshness rule still applies before every new purchase.

Authorization retirement uses the latest chain block timestamp, not the Worker wall clock. Once chain time passes `validBefore`, the engine queries `authorizationState` at that chain head: a used authorization remains recoverable; only an authoritatively unused one is retired and its reservation released before a new quote and authorization.

This is a specific deduplication and reconciliation guarantee, not a claim of unconditional exactly-once delivery across HTTP and blockchain.

## Security controls

- Paid-run APIs require an owner bearer credential stored only as a Cloudflare encrypted secret.
- The public `Test Price Cap (No Spend)` scenario is hardcoded to refuse before signing.
- Buyer, facilitator, merchant, and owner secrets never enter the browser or public API.
- Facilitator settlement is not exposed as a public gas-spending endpoint.
- Payment network, token, merchant, resource, scheme, amount, EIP-712 domain metadata, and expiry are allowlisted and revalidated.
- Facilitator settlements have a per-transaction gas estimate ceiling and a D1-derived global gas-unit ceiling.
- The seller accepts payment only from the dedicated buyer to the dedicated merchant.

## Deployment

Deployment uses Cloudflare Workers Free plan, D1, two Durable Objects, and the free `workers.dev` hostname.

```bash
powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts/deploy-cloudflare.ps1
```

The resumable script finds or creates the exact-name D1 database, writes one validated UUID only to the existing `DB` binding, applies migrations, deploys, verifies the locally persisted public identities, and uploads four encrypted secrets: `BUYER_PRIVATE_KEY`, `FACILITATOR_PRIVATE_KEY`, `MERCHANT_PRIVATE_KEY`, and `OWNER_TOKEN`. Do not commit `.dev.vars`, `.env`, or the ACL-protected local backup outside this repository.

## Tests

`npm test` includes behavioral tests against the real buyer/seller engine and coordinator classes backed by in-memory SQLite through a D1-compatible adapter. They exercise concurrent duplicate runs, a conditional near-limit global reservation race, one debit/one spend entry after a lost response, concurrent seller claims with one facilitator submission, recovery of a settled response older than 1,000 blocks, restart reconciliation without replacement authorization, and chain-time plus authoritative-state retirement. The existing arithmetic, SDK/protocol, access-control, ABI, and pinned-read tests also run. These deterministic regression tests make no blockchain transaction and are not presented as live-chain payment evidence.

## Permanent reviewer evidence

The deployment exposes read-only records through `/api/evidence` and `/api/tasks/:id`. The UI buttons are:

- **View Recorded Success**
- **View Recorded Budget Stop**
- **View Retry / Replay Evidence**

Deployment verified on 2026-10-16. Current Worker version: `85be105c-4086-431b-80da-b53a96a10869`. Machine-readable evidence is in [`evidence/live-demonstrations.json`](./evidence/live-demonstrations.json).

### SUCCESS — `review-success-20261016`

Status `COMPLETED`; budget `0.005 PXUSD`; confirmed `0.003 PXUSD`; reserved `0`.

| Resource | Amount | Receipt | Block | Status |
|---|---:|---|---:|---|
| Network snapshot | `0.001 PXUSD` | [`0x44576d…e675`](https://atlantic.pharosscan.xyz/tx/0x44576d56d85f7d47782d7c1e5046d13ec92209d79082467cb098cc50d7a1e675) | `31495621` | success |
| Activity summary | `0.002 PXUSD` | [`0x9126e3…9c04`](https://atlantic.pharosscan.xyz/tx/0x9126e3aa8da840b7072033423f34ae3737bb7204475aecfd1fe5f559a6c69c04) | `31495633` | success |

Both responses use task snapshot block `31495395` and the completed report cites both endpoints. The activity payment deliberately discarded the first HTTP response **after real settlement**. Attempt 2 reused the same authorization, recovered the stored response and same settlement hash, and created no second debit. The timeout is simulated; the payment and receipt are real.

The first authorization in this run expired unused while a pre-settlement ABI defect was corrected. Chain state proved it unused, D1 released its reservation, the buyer re-fetched the quote and made a new decision before creating a replacement authorization. This history remains visible rather than being hidden.

### BUDGET STOP — `review-budget-stop-20261016`

Budget `0.001 PXUSD`. The network snapshot settled successfully in [`0xc54949…22ac`](https://atlantic.pharosscan.xyz/tx/0xc549494454309aa8e53e77b5ff8efab44ae34a67c3ad5ad452fc8ed90dda22ac), block `31495662`. The activity quote was `0.002 PXUSD`; the engine recorded `STOPPED_BUDGET` before creating an authorization. Confirmed `0.001`, reserved `0`, and no second debit.

### PRICE CAP AND REPLAY — no spend

- `review-price-cap-http200-20261016`: quote `0.001 PXUSD`, cap `0.000999 PXUSD`, state `REFUSED_PRICE_CAP`, no authorization and no debit.
- Replaying `review-success-20261016` in a fresh Node process added `REPLAY_NOOP`. Facilitator nonce stayed `4 → 4`; no authorization, transaction, spend entry, or purchased response was duplicated.

### Totals

- Test-token spend across the required paid demonstrations: `0.004 PXUSD`.
- Transactions: one token deployment plus three settlements.
- Actual total gas: `0.000913922 PHRS`, below the authorized `0.0168 PHRS` ceiling.
- Facilitator balance after evidence: `0.999086078 PHRS`.
- Token deployment receipt: [`0x146dd5…debe`](https://atlantic.pharosscan.xyz/tx/0x146dd52825f7308bb81cf9ac18d08e57eadd905897ec9c845ee78f3bd30ddebe), success.

## Limitations

- PXUSD is a project test token, not official USDC and not money.
- The project operates both paid services; it does not prove third-party merchant adoption.
- A self-hosted facilitator is required because the public x402.org facilitator did not advertise Atlantic during verification.
- Public visitors can inspect evidence and run the fixed no-spend cap test; only the owner can initiate live payment runs.
- Chain/RPC availability can leave a submitted intent in `PENDING_RECONCILIATION`; it is never counted as spend until its receipt and Transfer event verify.
- The preserved success record was created immediately before the pinned-base-fee field replaced the earlier fetch-time `gasPriceWei` field. Its balances, block timestamps and activity window are pinned to block `31495395`; current code pins the fee value too. The original record is intentionally not rewritten.
