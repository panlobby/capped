# Limited token on Meteora DBC — architecture (final spec v1)

Goal: a token where every trade is a bet of a **pre-defined size**, like limit holdem
(fixed bet increments, capped position per wallet), enforced **on-chain** while the
pool trades on the curve. Tradable on **any DEX** supporting Token-2022 transfer hooks
(Meteora UI, Jupiter, fomo.family) — no walled garden, no custom router in v1.

Status: hook implemented (`programs/hook`), 20/20 native Rust unit tests pass
(`cargo test -p hook`), 14/14 validator integration tests pass (`tests/hook.ts`
via local validator). Curve modeled (`scripts/curve-matrix.ts`, SDK 1.5.13).
Devnet E2E in progress: transfer-hook config + full-size pool live, street bets
verified on-chain (50k buy, InvalidBetSize/P2PBlocked rejections, sells, fee claim).
Tiny pool GRADUATED end-to-end (see §8).

---

## 1. Verified facts

### 1.1 The only hook is the Token-2022 transfer hook

DBC has no generic "swap hook" (rate-limiter base-fee mode is deprecated for new configs:
`create_config` rejects `BaseFeeMode::RateLimiter`). The only extension point is the base
mint's Token-2022 **transfer hook**.

| What | Where |
| - | - |
| Config | `create_config_with_transfer_hook` → `ConfigWithTransferHook` (stores executable `transfer_hook_program`) |
| Pool | `initialize_virtual_pool_with_token2022_transfer_hook` → `TransferHookPool` |
| Swap | `swap2_with_transfer_hook` + `TransferHookAccountsInfo` (`TransferHookBase`, `TransferHookBaseReferral`) |
| Fee claims | `claim_trading_fee2` / `claim_creator_trading_fee2` |
| Docs | https://docs.meteora.ag/core-products/dbc/transfer-hook-pools |

DBC **creates the base mint** (signer/init) and sets
`transfer_hook::authority = pool_authority` (fixed const PDA
`FhVo3mqL8PW5pH5U2CN4XE33DokiyZnUwuGpH2hmHLuM`) and
`transfer_hook::program_id = config.transfer_hook_program`.
`collect_fee_mode` must be `QuoteToken` or `OutputToken`; token decimals 6..9.

### 1.2 The hook is revoked when the curve completes

In the swap that reaches `migration_quote_threshold`: `revoke_transfer_hook()` clears the
mint's transfer-hook program id **and** its authority (signed by `pool_authority`).
Event: `EvtCurveCompleteWithTransferHook`. Then the pool migrates to DAMM v2 and the mint
has no active hook.

⇒ **Limits only exist while the curve is live.** Our migration is parked at
100k SOL / $10M with a ~23k SOL threshold (~46k+ net-buy txs to graduate) —
"almost unreachable", but kept (no floor-breaker that would make it impossible).

### 1.3 Hook sees base only, never SOL

`Execute { amount: u64 }` carries only the base-token amount of one transfer.
No quote amount, no price, no swap params. ⇒ All caps are denominated in **base
tokens**. SOL-side discipline comes from `ExactOut` quoting off-chain
(`swapQuoteExactOut` + slippage → `maximumAmountIn`); DBC takes only what it needs.

### 1.4 What the hook reads and when

`process_transfer`: accounts `[source, mint, destination, authority, extra...]`.
Token-2022 debits source and credits destination BEFORE the hook CPI, so the
hook observes POST-transfer balances and reconstructs pre-transfer vault as
`post + amount` (buys) / `post - amount` (sells). Tiers, tail rule and hold cap
all evaluate on reconstructed pre-values; the hold cap checks the observed
(post-credit) destination balance directly. Token-2022 sets
`TransferHookAccount.transferring = true` on both token accounts around the CPI →
reliable guard against direct calls (strict path; lenient for unit-test mocks
lacking the extension).

Extra accounts are user-supplied and validated via `ExtraAccountMetaList`.
**Any-DEX rule**: only mint-derived (`["config", mint]`, `["extra-account-metas", mint]`)
and static (pool address) metas — per-user/per-tx metas break stock SDK, Jupiter,
and fomo backends (SDK resolves them with dummy keys off-chain).

### 1.5 Direction detection

Base vault is always owned by `POOL_AUTHORITY`:

- `source.owner == POOL_AUTHORITY` → buy (vault→user). Authority must be `POOL_AUTHORITY` (DBC signs).
- `destination.owner == POOL_AUTHORITY` → sell (user→vault). Authority must own source (no delegates).
- neither → P2P → revert (`P2PBlocked`, DEX-only chip).
- both → revert (`InvalidDirection`).

With `collect_fee_mode = QuoteToken` every curve transfer is exactly pool↔user —
no base referral transfers to handle.

### 1.6 Other constraints

- Pool supply enters vault via `mint_to` → hooks don't fire (fine).
- Disable `enable_first_swap_with_min_fee` (extra-metas PDA can't exist pre-mint).
- Buys should use `SwapMode::ExactOut` so transferred base is exactly the chip size.

---

## 2. Streets (final numbers)

Supply: **1B, 6 decimals. 767.4M buyable + ~233M (23%) to migration.**
`UNIT = 12,500` tokens. Thresholds keyed off pool `base_remaining` — the VAULT
balance (full supply at launch, **not** buyable: vault_0 = 1B; ~233M stays locked
for migration). Verified on devnet: vault tracks `supply - sold` exactly.

| street | sold range | supply | bet (exact) | hold/wallet | tx to clear |
|---|---|---|---|---|---|
| S1 preflop | 0→50M | 50M | 50k (4U) | 200k (16U) | 1,000 (250×4) |
| S2 flop | 50→150M | 100M | 50k (4U) | 1M (80U) | 2,000 |
| S3 turn | 150→400M | 250M | 25k (2U) | 5M (400U) | 10,000 |
| S4 river | 400M→migrate | ~367M | 12.5k (1U) | 20M (1,600U) | ~29,000 |
| total | | ~767M | | | ~42–46k |

Remaining thresholds in code (vault scale): `REMAIN_S1_MIN = 950M`, `S2 = 850M`,
`S3 = 600M` (tokens → ×1e6 base units). Holds rise monotonically (0.02% / 0.1% /
0.5% / 2%) so existing holders are never bricked by a street change.
Max bag 20M = 2% supply.

Hook checks per transfer: `amount == tier.bet` else `InvalidBetSize`;
on buy `destination.amount + amount <= tier.hold` else `ExceedsHold`.
Tail exception (buys only): `HookConfig.migration_lock` = base units locked for
migration (`vault_0 - buyable_0`, computed off-chain at pool creation, required
> 0). When `vault - lock < bet`, the buy must drain (almost) all of it:
`0 < amount <= vault - lock`, leaving at most `TAIL_DUST_CAP` (1 token)
undrained — DBC sqrt-price rounding leaves a few hundred raw units no ExactOut
can source (measured 459 on devnet), and the final buy's cost still crosses the
migration threshold. Sells stay exact. Without a lock (pre-upgrade accounts)
the hook stays strict `==` forever. Rationale: buyable is never an exact
multiple of the bet (main pool leaves a ~7,059-token tail), so strict `==`
makes graduation mathematically impossible; the tail rule restores
possible-but-hard graduation while keeping chip discipline on 99.99% of the curve.

---

## 3. Curve (final numbers, modeled)

Builder: `buildCurveWithLiquidityWeights`, start $4.2k → migrate **100k SOL ($10M
@ $100/SOL)**, 25bps flat fee, 16 micro-segments, weights
`1,1,1,2,3,5,8,12,20,30,48,75,120,190,300,450`.
Modeled with `scripts/curve-matrix.ts` (`bun scripts/curve-matrix.ts <16 weights>`).

| item | value |
|---|---|
| Migration threshold | 23,256 SOL (~$2.33M real inflow) |
| mcap at street borders (50/150/400M sold) | $39.8k / $289k / $2.35M |
| Bet SOL cost S1→S4 street starts | $0.21 / $2.00 / $7.24 / $29.39 |
| **Last 12.5k bet @99% sold: 1.2187 SOL @ $9.7M** | verifies "last bet ≈ 1 SOL" |
| 0.05 SOL ExactIn out S1/S2/S3/S4 | 1.16M / 125k / 17.3k / 2.1k tokens |
| Street pots (quote/quadrants) | ~$1k → ~$17k → ~$260k → ~$2.3M |

Notes:
- S1 dust is structural ($4.2k start ⇒ 50k = $0.21 first txs). Preflop clears on
  ~$0.2–1 txs — accepted as anti-snipe grind; S2+ bets reach dollars.
- S2/S3 mid-street $5 buys exceed cap and must split (2–4 txs) until S3 (~$289k),
  where 0.05 SOL → 17k fits the 25k cap.
- No floor-breaker: stopping buys near the end would make graduation impossible,
  not "almost unreachable". Threshold alone is the defense.

UNIT note: bets halve per street down to 1U. Further streets would need
UNIT = 6.25k/3.125k (all current sizes stay whole multiples). If more than 6
streets are ever wanted, shrink UNIT before launch; otherwise freeze the chip
at 12.5k and grow holds only.

---

## 4. Fees (all minimal, all to deployer)

- Base 25bps flat (DBC minimum), dynamic off, `QuoteToken`, creator 0%,
  pool creation fee 0, migration `FixedBps25` creator 0%.
- Per trade: 20% to Meteora protocol (~0.05%), **80% (~0.20%) to deployer**
  (fee claimer), claimable anytime via `claim_trading_fee2`.
- At graduation: 0.25% migration tax (~58 SOL, all deployer) + fixed 0.2%
  protocol liquidity fee to Meteora (unavoidable, slightly reduces LP).
- Surplus above threshold ≈ 0 expected. Solana gas/rent separate (validators).
- Lifetime estimate: ~23k SOL inflow → ~46k SOL volume → ~116 SOL fees total
  (~23 protocol / ~93 deployer) + ~58 SOL migration tax + DAMM yield on owned LP.

## 5. Deploy costs

- Program (~274KB class): **~1.9 SOL** net programdata rent (buffer ~1.9 SOL
  locked during deploy, recovered after). Skip on-chain IDL on mainnet.
- Per launch (config + pool + vaults + mint + metadata + hook PDAs): **~0.1 SOL**
  + launch-buy chip (~$0.21+). Devnet rehearsal free.
- Upgrade authority: deployer-held during tuning, lock (multisig/immutable)
  before serious volume — undecided, see §7.

## 6. Implementation status

- `programs/hook/src/lib.rs`: done — config PDA, extra-metas init, `transfer_hook`
  + `fallback` (strict `transferring` on real CPI), mock-pool helper for tests.
- `cargo test -p hook`: **14/14 pass** (tier bounds, both pool layouts, exact/
  wrong/hold/authority/P2P/strict-mode cases).
- `tests/hook.ts`: validator integration written, **blocked** — `anchor build`
  fails (platform cargo 1.84 can't parse 2026 edition2024 crates;
  fixed `blake3→1.5.5` so far, `zeroize_derive 1.5.0` next). Needs toolchain
  upgrade (Solana + anchor) before any on-chain test.
- Curve matrix: done (see §3). Config-creation params file: not yet written.

## 7. Remaining decisions / risks

1. Bet `==` exact vs `<=` max — DECIDED: hybrid. Strict `==` everywhere,
   except the tail (`vault - migration_lock < bet`): buys take the exact
   remainder, sells stay exact (implemented, 20/20 unit + 13/13 integration pass).
   Mid-curve fomo `ExactIn` dust still reverts — accepted (separate UX issue).
2. Accept S1 dust preflop (structural, see §3) vs raise S1 bet/start mcap.
3. Upgrade authority policy (deployer → multisig/immutable timing). NOTE from
   devnet: HookConfig layout changes brick old pools' PDAs (deserialization
   fails → all transfers revert, funds stuck). A legacy fallback (lock = 0,
   strict ==) exists for pre-upgrade accounts, but rule stands: finalize hook
   logic BEFORE mainnet, then lock. Upgrading after pools exist is dangerous.
4. `migrationFee` percentages consistency check at config build
   (FixedBps25 option + creator 0%).
5. Devnet end-to-end: deploy hook → mint → transfer-hook config/pool → real
   `swap2WithTransferHook` buys/sells → P2P-send rejection → Jupiter/fomo
   visibility check. DONE except aggregator visibility (see §8).
6. Curve completion kills the hook by design (kept migration); threshold +
   tail rule (`== remaining`, dust-tolerant) is the whole defense — monitor
   `quote_reserve` vs threshold.
7. Sybil: hold caps bound each wallet (20M max = 2% on S4); no per-wallet tx
   counting in v1 (would cost fomo compatibility — see old Design B/C, rejected).

## 8. Devnet graduation rehearsal (tiny pool, 2026-10-14) — PASSED

Tiny curve (500k supply, 2.58 SOL threshold) bought out with exact 12.5k bets
(30×) + tail buy `ExactOut(6671616416)` (max drainable; 459 raw units of DBC
rounding dust left, `TAIL_DUST_CAP` = 1 token covers it).

* Final buy tx `BDjEFprkNYL4cMek8AFy6LeAQYLeatrXb81BqfgNDJdGaSRYWGabvmtDJ2ZRkwg3zYDnTMfZQN8RkT9jpD6gerQ`:
  hook log `street ok pre=125000000000 bet=12500000000 lock=118328383125`,
  then DBC `TransferHookInstruction::Update` + `SetAuthority` — hook revoked
  in the same swap. Mint no longer carries the hook program id.
* quoteReserve crossed threshold (2,581,224,444 >= 2,581,224,428); vault left
  at lock + 459 dust, migrated with the rest.
* Manual `migrateToDammV2` tx `3j75CgKJRacDXQqqTLgxs2qh5c1KHeVyAYMF7tBhoGXVxUACqKdMip6KMBd7PosWjxzh3k5c7U1LjjqzYJ22MytC`
  → `isMigrated = 1`. Full lifecycle proven: config → pool → hook → streets →
  tail → revocation → DAMM v2.
