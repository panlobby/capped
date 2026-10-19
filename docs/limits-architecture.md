# Capped Token — on-chain rules (public spec)

Every trade is a pre-defined chip size, enforced on-chain by a Token-2022
transfer hook while the pool trades on its Meteora DBC curve. Tradable on any
DEX with transfer-hook support (Meteora UI, Jupiter) — no custom router.

Hook source: `programs/hook/src/lib.rs`. Trade panel: `ui/`.

---

## 1. How enforcement works

DBC has no generic swap hook — the only extension point is the base mint's
Token-2022 **transfer hook** (`create_config_with_transfer_hook` →
`TransferHookPool` → `swap2_with_transfer_hook`).

* The hook sees only the **base-token amount** of one transfer — never SOL,
  never price. All caps are denominated in base tokens. SOL-side discipline
  comes from quoting buys as `ExactOut` off-chain.
* Token-2022 debits/credits before the hook runs, so the hook observes
  post-transfer balances and reconstructs pre-transfer values.
* Direction: vault-owned side means pool↔user (buy/sell). Wallet-to-wallet
  transfers revert (`P2PBlocked`) — DEX only.
* Extra accounts are mint-derived + one static pool address, so stock SDK,
  Jupiter and other frontends resolve them with no custom code.

### Graduation

In the swap that reaches `migration_quote_threshold`, DBC revokes the hook
(clears program id and authority) and the pool migrates to DAMM v2.

⇒ **Limits exist only while the curve is live.** After graduation the token
trades freely with no hook.

---

## 2. Streets

Supply: **1B, 6 decimals. 775.41M buyable + ~224.59M (22.5%) locked for
migration.** Street is a function of the pool vault balance
(`sold = 1B - vault`): thresholds `950M / 850M / 625M` tokens.

| street | sold range | chips (buy and sell) | hold / wallet | tx to clear (max chip) |
|---|---|---|---|---|
| S1 preflop | 0→50M | 25k / 50k | 200k | 1,000 |
| S2 flop | 50→150M | 25k / 50k | 1M | 2,000 |
| S3 turn | 150→375M | 25k / 50k / 75k | 4.5M | 3,000 |
| S4 river | 375M→775M | 25k / 50k / 75k / 100k | 20M | 4,004 + tail |

Every street trades **25k-multiple chips up to its max**, buys and sells
alike. On a buy the wallet balance after the trade must stay under the hold
cap (`balance + chip ≤ hold`), else `ExceedsHold`. Max bag 20M = 2% of supply.
Holds rise monotonically, so street changes never brick existing holders.

10,004 + tail is the **net-buy lower bound** — sells return tokens to the
vault (streets are reversible: heavy selling moves the street back), so churn
adds volume, not progress.

### Tail (buys only)

Once less than one max chip is left buyable, fitting chips keep working
(`chip ≤ buyable`). Only when no chip fits (buyable < 25k) must one buy drain
almost all of it, leaving at most 0.01 token above the migration lock
(DBC rounding dust no `ExactOut` can source). That final buy crosses the
migration threshold and graduates the pool in a single swap. Sells need no
tail rule — they grow the vault, never drain it.

---

## 3. Curve

Start **$10k → migrate $1M (@ $100/SOL)**, 25bps flat fee, 16 segments.

| item | value |
|---|---|
| Buyable | 775,411,323 (775.41M; S4 = 4,004 × 100k + 11.32k tail) |
| Migration threshold | 2,245.88 SOL (~$224.6k net inflow) |
| mcap at street borders (50/150/375M sold) | $17,268 / $40,273 / $174,437 |
| 0.05 SOL ExactIn out S1/S2/S3/S4 | 497k / 288k / 124k / 28.6k tokens — must split or use ExactOut |

S1 entry is intentionally small (~$0.50 first txs, anti-snipe grind); S3 bets
reach ~$3, S4 ~$17.50. A standard $5 ExactIn buy does not land on a chip —
use the ExactOut panel (`ui/`), never raw ExactIn.

---

## 4. Fees

* Base 25bps flat (DBC minimum), dynamic off, quote-token collection,
  creator 0%, pool creation fee 0, migration `FixedBps25` creator 0%.
* Per trade: ~0.05% to Meteora protocol, ~0.20% to the deployer (fee
  claimer), claimable anytime.
* At graduation: 0.25% migration tax (~5.6 SOL, deployer) + fixed 0.2%
  protocol liquidity fee to Meteora.
* Lifetime estimate: ~2,250 SOL net inflow → ~11 SOL trading fees total +
  migration tax + DAMM yield on owned LP.

---

## 5. Verification status

* Hook unit tests: **38/38 pass** (`cargo test -p hook --features local-test`).
  Mainnet builds use plain `anchor build` (test helpers compiled out).
* Integration tests: **19/19 pass** on a local validator.
* Full lifecycle proven on Solana devnet: street chip buys/sells →
  wrong-size revert → P2P revert → tail drain → hook revoked in the
  graduating swap → migrated to DAMM v2 (`isMigrated = 1`).
