---
name: pharos-x402-agent-buyer
description: Buy allowlisted HTTP resources through x402 v2 on Pharos Atlantic Testnet with exact per-call and total budgets, durable reservations, receipt verification, safe retry, and paid-response recovery. Use when an agent must complete the two-resource Pharos network brief, inspect recorded x402 evidence, or run a budget/cap refusal demonstration.
license: MIT
---

# Pharos x402 Agent Buyer

Use this Skill to inspect evidence or invoke the shared deployed buyer engine. The project is Atlantic Testnet-only (`eip155:688689`). Never substitute Pacific Mainnet.

## Install

```bash
git clone https://github.com/shoupeorg/pharos-x402-agent-buyer.git
cd pharos-x402-agent-buyer
npm ci
```

The root `SKILL.md` is the installable Skill entry point. No global installation is required.

## Safe read-only invocation

```bash
npm run skill -- status
npm run skill -- evidence
npm run skill -- view <run-id>
```

These commands do not create authorizations or spend tokens.

## No-spend policy test

```bash
npm run skill -- run price-cap --run-id reviewer-cap-demo
```

This fixed public scenario sets the cap below the first quote and must finish `REFUSED_PRICE_CAP` before signing.

## Owner-only paid task

Only a project owner with the server credential may start a paid run:

```bash
set PHAROS_X402_OWNER_TOKEN=<secret>
npm run skill -- run success --budget 0.005 --cap 0.002 --run-id my-unique-run
```

On PowerShell use `$env:PHAROS_X402_OWNER_TOKEN = "<secret>"`. Never place the token in a URL, source file, prompt, log, or commit.

## Decision contract

For each of `/paid/network-snapshot` and `/paid/activity-summary`, the shared engine:

1. Requests the resource without payment and requires HTTP 402 plus `PAYMENT-REQUIRED`.
2. Validates x402 version 2, `exact`, `eip155:688689`, token, merchant, amount, resource URL, and EIP-3009 domain metadata.
3. Explains why the resource is necessary.
4. Checks the integer atomic-unit price against the per-call cap and `confirmed + reserved + proposed` against the total budget. Equality is allowed.
5. Atomically reserves in the globally serialized buyer Durable Object and D1.
6. Persists the intent, then creates one EIP-3009 authorization with the official SDK.
7. Retries transient failures at `0/250/750 ms` using that same authorization only.
8. Verifies the Atlantic receipt and exact token `Transfer` event before counting spend once.
9. Persists the response and combines both resources into the network brief.

If a submitted result is ambiguous, report `PENDING_RECONCILIATION`, retain the reservation, and do not create a new authorization. Never reinterpret a timeout as a failed payment. Compare `validBefore` with the latest chain block timestamp, never local wall time. Once chain time has expired a persisted authorization, query `authorizationState` at that chain head: recover it when used; only when authoritative chain state proves it unused may the engine durably retire it, release its reservation, fetch a fresh quote, repeat the budget decision, and create a replacement.

## Output interpretation

- `COMPLETED`: both genuine paid resources and verified receipts are present.
- `STOPPED_BUDGET`: quote was valid but total budget blocked it before signing.
- `REFUSED_PRICE_CAP`: quote exceeded the cap before signing.
- `PENDING_RECONCILIATION`: a payment may have been submitted; no new authorization is safe.
- `FAILED`: terminal non-payment failure.

PXUSD is a project-deployed, test-only EIP-3009 token with no monetary value. The seller is operated by this same project, using a distinct merchant identity; this is not evidence of independent commercial adoption.
