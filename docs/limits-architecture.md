# Limited token on Meteora DBC — architecture (final spec v1)

Goal: a token where every trade is a bet of a **pre-defined size**, like limit holdem
(fixed bet increments, capped position per wallet), enforced **on-chain** while the
pool trades on the curve. Tradable on **any DEX** supporting Token-2022 transfer hooks
(Meteora UI, Jupiter, fomo.family) — no walled garden, no custom router in v1.

Status: hook implemented (`programs/hook`), 34/34 native Rust unit tests pass
(`cargo test -p hook`), 17/17 validator integration tests pass (`tests/hook.ts`
via local validator, run as `bun --bun node_modules/mocha/bin/_mocha` — plain
`mocha` is broken on Node 26 / yargs ESM bug). Curve modeled (`scripts/curve-matrix.ts`, SDK 1.5.13).
Devnet E2E complete on OLD params: full lifecycle proven through DAMM v2 migration (see §8).
Product decision FINAL: graduating DBC at $1M mcap (hook revoked at graduation).
Variant C streets (10k tx total, 775M buyable) — see §2.

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
10k SOL / $1M (start $10k). At $1M migration mcap the DBC math links buyable
supply and threshold directly: `threshold_SOL = (1000 − buyable_M) × 10`
(price at graduation is 10 SOL per 1M tokens). With 775M buyable / 225M locked
the threshold is **~2,250 SOL (~$225k real inflow)** — reachable, graduation is
a real event, not "almost unreachable". Tail rule (§2) is the whole defense —
monitor `quote_reserve` vs threshold.

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

## 2. Streets — Variant C (final numbers)

Supply: **1B, 6 decimals. 775.41M buyable + 224.59M (22.5%) to migration.**
`UNIT = 12,500` tokens (granularity kept; GCD of bets/holds is 25k).
`SELL_STEP = 25,000` tokens. Thresholds keyed off pool `base_remaining` — the VAULT
balance (full supply at launch, **not** buyable: vault_0 = 1B; ~224.59M stays locked
for migration). Tx split **1,000 / 2,000 / 3,000 / 4,004 + 1 tail = 10,005 total**.

| street | sold range | supply | bet (buy exact) | sell (chips ≤ bet, 25k steps) | hold/wallet | tx to clear |
|---|---|---|---|---|---|---|
| S1 preflop | 0→50M | 50M | 50k (4U) | 25k / 50k | 200k (16U) | 1,000 |
| S2 flop | 50→150M | 100M | 50k (4U) | 25k / 50k | 1M (80U) | 2,000 |
| S3 turn | 150→375M | 225M | 75k (6U) | 25k / 50k / 75k | 4.5M (360U) | 3,000 |
| S4 river | 375M→migrate | 400.41M | 100k (8U) | 25k / 50k / 75k / 100k | 20M (1,600U) | 4,004 + tail 11.32k |
| total | | 775.41M | | | | 10,004 + 1 tail |

Remaining thresholds in code (vault scale): `REMAIN_S1_MIN = 950M`, `S2 = 850M`,
`S3 = 625M` (tokens → ×1e6 base units). Holds rise monotonically (0.02% / 0.1% /
0.45% / 2%) so existing holders are never bricked by a street change.
Max bag 20M = 2% supply.

Hook checks per transfer (`programs/hook/src/lib.rs`, §8):
buy `amount == tier.bet` else `InvalidBetSize`;
sell `0 < amount <= tier.bet && amount % SELL_STEP == 0` else `InvalidBetSize`
(chip multiples — any earlier bag exits on any later street: 50k bag sells once
on S3/S4, 200k bag exits S4 as 2×100k);
on buy `destination.amount + amount <= tier.hold` else `ExceedsHold`.
Tail exception (buys only): `HookConfig.migration_lock` = base units locked for
migration (`vault_0 - buyable_0`, computed off-chain at pool creation, required
> 0). When `vault - lock < bet`, the buy must drain (almost) all of it:
`0 < amount <= vault - lock`, leaving at most `TAIL_DUST_CAP` (10_000 raw units
= 0.01 token)
undrained — DBC sqrt-price rounding leaves a few hundred raw units no ExactOut
can source (measured 459 on devnet), and the final buy's cost still crosses the
migration threshold. Sells need no tail rule (they grow the vault, never drain
it). Without a lock (pre-upgrade accounts)
the hook stays strict `==` on buys forever. Rationale: buyable is never an exact
multiple of the bet, so strict `==` makes graduation mathematically impossible;
the tail rule restores possible graduation while keeping chip discipline on
~99.99% of the curve.

---

## 3. Curve (final numbers, modeled)

Builder: `buildCurveWithLiquidityWeights`, start $10k → migrate **10k SOL ($1M
@ $100/SOL)**, 25bps flat fee, 16 micro-segments, weights
`10,12,15,19,24,29,36,45,56,69,86,106,132,163,203,251`
(`~= 1.7^(i×0.405) × 10`, tuned for 775M buyable).
Modeled with `scripts/curve-matrix.ts`
(`bun scripts/curve-matrix.ts 10,12,15,19,24,29,36,45,56,69,86,106,132,163,203,251`):

| item | value |
|---|---|
| Buyable (walk == closed form) | 775,411,323 (775.41M; S4 = 4,004 × 100k + 11.32k tail) |
| Migration threshold | 2,245.88 SOL (~$224.6k real inflow) |
| mcap at street borders (50/150/375M sold) | $17,268 / $40,273 / $174,437 |
| Bet SOL cost S1→S4 street starts | 0.0050 / 0.0087 / 0.0303 / 0.1749 ($0.50 / $0.87 / $3.03 / $17.49) |
| **Last 100k bet @99% sold: 0.9704 SOL @ $967,776** | verifies "last bet ≈ 1 SOL" |
| 0.05 SOL ExactIn out S1/S2/S3/S4 | 497k / 288k / 124k / 28.6k tokens (all must split or use ExactOut) |

Notes:
- S1 dust is structural ($10k start ⇒ 50k = $0.50 first txs). Preflop clears on
  ~$0.5–1 txs — accepted as anti-snipe grind; S3 bets reach $3, S4 $17.50.
- $5 (0.05 SOL) buyers must use the ExactOut terminal, never raw ExactIn:
  S1 $5 ≈ ten 50k chips, S2 ≈ six 50k chips, S3 = one 75k chip ($3.03) + dust,
  S4 $5 is below the 100k chip ($17.49 min buy).
- No floor-breaker: stopping buys near the end would make graduation impossible.
  Threshold + tail rule is the whole defense. Graduation here is reachable by
  design (~2,246 SOL inflow), unlike the old $10M "almost unreachable" setup.

UNIT note: buys rise per street 4U/4U/6U/8U (U = 12.5k). SELL_STEP = 25k = 2U;
every bet and hold stays a whole multiple of both. If more than 4 streets are
ever wanted, keep U = 12.5k granularity; otherwise freeze the chip at 25k
and grow holds only.

---

## 4. Fees (all minimal, all to deployer)

- Base 25bps flat (DBC minimum), dynamic off, `QuoteToken`, creator 0%,
  pool creation fee 0, migration `FixedBps25` creator 0%.
- Per trade: 20% to Meteora protocol (~0.05%), **80% (~0.20%) to deployer**
  (fee claimer), claimable anytime via `claim_trading_fee2`.
- At graduation: 0.25% migration tax (~5.6 SOL, all deployer) + fixed 0.2%
  protocol liquidity fee to Meteora (unavoidable, slightly reduces LP).
- Surplus above threshold ≈ 0 expected. Solana gas/rent separate (validators).
- Lifetime estimate: ~2,250 SOL inflow → ~4.5k SOL volume → ~11 SOL fees total
  (~2 protocol / ~9 deployer) + ~5.6 SOL migration tax + DAMM yield on owned LP.

## 5. Deploy costs

- Program (~274KB class): **~1.9 SOL** net programdata rent (buffer ~1.9 SOL
  locked during deploy, recovered after). Skip on-chain IDL on mainnet.
- Per launch (config + pool + vaults + mint + metadata + hook PDAs): **~0.1 SOL**
  + launch-buy chip (~$0.21+). Devnet rehearsal free.
- Upgrade authority: deployer-held during tuning, lock (multisig/immutable)
  before serious volume — undecided, see §7.

## 6. Implementation status

- `programs/hook/src/lib.rs`: done — Variant C (bets 50k/50k/75k/100k, holds
  200k/1M/4.5M/20M, REMAIN 950M/850M/625M, SELL_STEP 25k; buys exact + tail
  drain, sells 25k chip multiples ≤ bet), config PDA (immutable pool,
  graduating DBC), extra-metas init, `transfer_hook` + `fallback`, DBC
  owner/discriminator check, token-mint cross-check, mock-pool helper for tests.
- `cargo test -p hook --features local-test`: **34/34 pass** (tier bounds incl.
  625M border, buys exact/wrong/hold/authority, sell chips 25k/50k/75k/100k +
  over-bet/non-chip reverts, P2P, tail-dust, owner/disc/mint/vault cases).
  `local-test` gates `init_mock_pool` + mock branches; MAINNET builds use plain
  `anchor build` (mocks compiled out).
- `tests/hook.ts`: **17/17 pass** on local validator (run via
  `bun --bun node_modules/mocha/bin/_mocha` — plain `mocha` 9 is broken on
  Node 26 / yargs ESM bug; `anchor test` same cause). Validator binary built
  with `anchor build -- --features local-test`, deployed via
  `solana program deploy`, provider via `ANCHOR_PROVIDER_URL`/`ANCHOR_WALLET`.
- Curve matrix: FINAL weights `10,12,15,19,24,29,36,45,56,69,86,106,132,163,203,251`
  (775.41M buyable / 2,245.88 SOL threshold, walk == closed form, see §3). Config-creation params:
  `migrations/deploy.ts` exports `VARIANT_C_PARAMS` (single source for launch).

## 7. Remaining decisions / risks

1. Bet `==` exact vs `<=` max — DECIDED: hybrid. Buys strict `==` everywhere,
   except the tail drain (`vault - migration_lock < bet`); sells are 25k chip
   multiples `<= bet` (`programs/hook/src/lib.rs` §8, 34/34 unit + 17/17
   integration pass). Rationale: exact sells on rising bets bricked small
   early bags (a 50k bag can never make a `== 75k` sell); chip-multiple sells
   let any bag exit on any later street while keeping fixed-chip discipline.
   Mid-curve fomo `ExactIn` buys still revert — accepted (separate UX issue,
   needs ExactOut terminal).
2. Accept S1 dust preflop — DECIDED: keep start $10k ($0.50 first bets),
   preflop dust is part of the design (anti-snipe grind).
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
6. Curve completion kills the hook by design — DECIDED graduating DBC at $1M
   mcap (permanent-DBC option rejected; hook revoked at graduation, no limits
   after). Threshold + tail rule is the whole defense — monitor `quote_reserve`
   vs threshold.
7. Sybil: hold caps bound each wallet (20M max = 2% on S4); no per-wallet tx
   counting in v1 (would cost fomo compatibility — see old Design B/C, rejected).

## 8. Devnet rehearsals

### 8a. Tiny pool (old params, 2026-10-14) — PASSED

Tiny curve (500k supply, 2.58 SOL threshold) bought out with exact 12.5k bets
(30×) + tail buy `ExactOut(6671616416)` (max drainable; 459 raw units of DBC
rounding dust left, `TAIL_DUST_CAP` = 10_000 raw units covers it with margin
(post-fix cap tightened from 1 token to 0.01 token so the tail always
graduates in a single swap).

* Final buy tx `BDjEFprkNYL4cMek8AFy6LeAQYLeatrXb81BqfgNDJdGaSRYWGabvmtDJ2ZRkwg3zYDnTMfZQN8RkT9jpD6gerQ`:
  hook log `street ok pre=125000000000 bet=12500000000 lock=118328383125`,
  then DBC `TransferHookInstruction::Update` + `SetAuthority` — hook revoked
  in the same swap. Mint no longer carries the hook program id.
* quoteReserve crossed threshold (2,581,224,444 >= 2,581,224,428); vault left
  at lock + 459 dust, migrated with the rest.
* Manual `migrateToDammV2` tx `3j75CgKJRacDXQqqTLgxs2qh5c1KHeVyAYMF7tBhoGXVxUACqKdMip6KMBd7PosWjxzh3k5c7U1LjjqzYJ22MytC`
  → `isMigrated = 1`. Full lifecycle proven: config → pool → hook → streets →
  tail → revocation → DAMM v2.

### 8b. Variant C rehearsal (2026-10-15) — PASSED

Production hook (bets 50k/50k/75k/100k, 25k chip sells) redeployed to devnet,
`solana program deploy` sig `26mV3mrU8rQCz5uRiGTHC4MDbyN3dbeQ1Vj3hG4NjYq25CYv1kYhPBh2vkNctykkfP8G3FPzaoStppR63jsmR5vt`.

* Pool #2 spot-checks (S1, old lock): ExactOut 50k buy pass
  (`2vGKwBp7GNjxKYRphmjzL2ToJDsJuc85MbEFNHSXeqwvWdW8cxLfRkzdZHTjMJdE2YEG19TrKKXTQeVCzsVhoy5J`),
  30k buy reverted `InvalidBetSize`, chip sells 25k+25k pass
  (`4MAwivuHevLcUrcAJn9otz4ZtLyxYrYuDB737t5bmQMUXokT6Nhw5NtN3UxgdZYmRWq6JMr68ThRDmUoF25nDUk9`,
  `3LcKXBiEWochQeMWfDDAUfgqDeb2z4AE7yrv4E3ePFEF21NiF4xjEeukkpUxKHMb8tXheL6uHh5SqN7t6mLZRXMh`),
  P2P `transferCheckedWithTransferHook` reverted `P2PBlocked`. Scripts:
  `scripts/spotcheck-pool2.ts`.
* Tiny #3 (reused tiny DBC config `GPduPehufvwcwFK4mmDck3VkPRuD8uBEEXapV8iNhuWR`):
  pool `6E7A4Tz8hMorGTfMqQ6btr8HAXvPmUsZoHw3rzHb73XG`,
  mint `Fhjn1z1XsXSxDWTKM8JJaUmx88GdyCBYcQxQ3p2n41JM`,
  vault_0 500M tokens, buyable 381,671,616,432 raw, lock 118,328,383,568,
  threshold 2,581,224,428 lamports. Hook bound before first swap.
  Lesson: DBC allocates the base mint itself — do NOT pre-create it
  (`Allocate: account already in use`); pass a fresh keypair.
* Buyout (always S4, vault 500k << 625M border, bet 100k): 3× ExactOut 100k,
  then tail ExactOut(81,671,606,432) (buyable shaved by dust cap; full
  remainder fails client-side `Insufficient Liquidity` past the curve end),
  then dust nibbles (1250 → 625 → 312 → 156 raw) until quote crossed:
  final nibble tx `Kyp98rskVTULQYydpXTWtWKRM5kG9yefJSdaqYXHqbBK7bEJFrh7syrXoVh8JBXnwE9swDixZXDk7QSK5EP2vTC`,
  quoteReserve 2,581,224,430 >= 2,581,224,428. Vault left at lock + 157 dust.
  Scripts: `scripts/tiny3-create.ts`, `scripts/tiny3-buyout.ts`.
* Hook revoked in the graduating swap (mint `transferHook` extension gone),
  then `migrateToDammV2` tx `jjVj7zNurMceW4J66K2J7sMxwMP12TbKG2d9iYM62jUxib9kiET1LtgZWbz6m3HLcMpwyXNcECXdmv5ddSiGko4`
  (reused cp-amm config `7F6dnUcRuyM2TwR8myT1dYypFXpPSxqwKNSFNkxyNESd` from the
  tiny#2 migration) → `isMigrated = 1`. Script: `scripts/tiny3-migrate.ts`.
* Full Variant C lifecycle proven: street bets → chip sells → tail drain →
  revocation → DAMM v2. Terminal lesson: near-curve-end ExactOut must probe
  quotable amounts (halve on `Insufficient Liquidity`) and nibble dust —
  encoded in `tiny3-buyout.ts` tail loop.
