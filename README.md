# Capped Token — limit-holdem token on Meteora DBC (Variant C)

Every trade is a pre-defined chip enforced on-chain by a Token-2022 transfer hook
(`programs/hook/src/lib.rs`). No custom router, any DEX with transfer-hook support.

## Streets (Variant C, 10k tx minimum, 775M buyable)

| street | sold | buy / sell chips (ExactOut buys) | hold/wallet |
|---|---|---|---|
| S1 | 0→50M | 25k / 50k | 200k |
| S2 | 50→150M | 25k / 50k | 1M |
| S3 | 150→375M | 25k / 50k / 75k | 4.5M |
| S4 | 375→775M | 25k / 50k / 75k / 100k | 20M |

Tail: fitting chips keep working near the end (`chip ≤ buyable`). Only when
buyable drops below 25k must one tx drain to ≤0.01 token above the migration
lock. Wallet-to-wallet transfers blocked (`P2PBlocked`). Max bag
20M = 2%. Streets are reversible — sells push the vault back across borders,
and 10k tx is the net-buy lower bound (sells add volume, not progress).
Graduation (~$1M mcap, ~2245.88 SOL net inflow) revokes the hook in the
same swap, pool migrates to DAMM v2 — no limits after.

## How to play

1. Every trade is a 25k-multiple chip up to the street max, buys and sells.
2. Buys must be `ExactOut(chip)` — stock `ExactIn` reverts `InvalidBetSize`.
3. Check hold headroom before buying (`balance + chip ≤ hold`).

## Transparent trade panel (devnet, static, no backend)

Open `ui/index.html` (GitHub Pages serves `/ui/`). Read-only state needs no
wallet; trading is opt-in via Phantom on devnet. All logic visible in
`ui/trade.js`, constants in `ui/variant-c.json`, devnet addresses in
`ui/devnet.json`. No Helius, browser talks to Solana RPC directly.

Devnet test checklist mirrors `scripts/spotcheck-pool2.ts`:
50k buy pass → 30k `InvalidBetSize` → 25k+25k sells pass → P2P `P2PBlocked`.

## Docs

* Spec: `docs/limits-architecture.md`
* Audits: `docs/audit.md`, `docs/audit-2026-10-14.md`, `docs/audit-variant-c.md`
* Launch params: `migrations/deploy.ts` (`VARIANT_C_PARAMS`)
