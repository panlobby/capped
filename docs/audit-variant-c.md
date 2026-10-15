# Project Audit — Variant C (chip-multiple sells)

Date: 2026-10-15 · Mode: code review + test re-run + live devnet checks.
Scope: `programs/hook/src/lib.rs` (Variant C: bets 50k/50k/75k/100k, holds
200k/1M/4.5M/20M, REMAIN 950M/850M/625M, `SELL_STEP` 25k),
`tests/hook.ts` (17 integration), `scripts/*`, `migrations/deploy.ts`,
`docs/limits-architecture.md`. Previous report: `docs/audit-2026-10-14.md`
(old params) — this file supersedes its street/bet findings; its open
decisions (§6) carry over where noted.

## 1. Method & results

| Check | Result |
|---|---|
| `cargo test -p hook --features local-test` | **34/34 pass** (re-ran) |
| `tests/hook.ts` on local validator (`bun --bun _mocha`) | **17/17 pass** (re-ran) |
| `cargo check -p hook` (mainnet profile, no mocks) | clean |
| Production IDL (`target/idl/hook.json`) | 3 ix only: `initialize_config`, `initialize_extra_account_meta_list`, `transfer_hook` — no mocks, no `set_pool` |
| `#[cfg(feature = "local-test")]` gates | 4 sites (`lib.rs:137,419,484,509`) — mainnet binary unconditionally requires full-size DBC pools |
| Devnet spot-checks, pool #2, upgraded code | 50k buy pass / 30k `InvalidBetSize` / 25k chip sells pass / P2P `P2PBlocked` (sigs in docs §8b) |
| Devnet tiny #3 full lifecycle | 3×100k + tail + nibbles → quote 2581224430 ≥ 2581224428 → hook revoked → `migrateToDammV2` → `isMigrated = 1` |
| Live state re-verified for this audit | pool #2 on-curve (`isMigrated = 0`), tiny #3 migrated, tiny #3 mint `transferHook` ext gone, programdata authority = deployer key |

## 2. Executive summary

**Variant C logic is sound and proven on live pools. No critical/high flaws.**
The exact-sell bricking of small early bags (50k bag vs `== 75k` sell) is fixed
by chip-multiple sells without losing per-tx whale caps. The upgrade changed
no account layouts, so old devnet pools kept working (proven live on pool #2
today). One new Low finding (transient pre-graduation dust, C1) and the two
old open decisions (upgrade authority, mainnet mint verification) remain.

## 3. Findings

### C1 — Tail buys can credit non-25k balances that chip sells can't fully exit — LOW

`programs/hook/src/lib.rs:353-366`: sells require `amount % SELL_STEP == 0`,
but tail buys (`lib.rs:354-359`) credit arbitrary remainders (tiny #3 tail:
81,671,606,432 raw). A 81.67k bag on S4 exits as 75k + 6.67k stuck — the 6.67k
can't sell (`%` fails) and can't move (P2P blocked).

Bounded and self-resolving: only possible in the tail zone (`vault − lock <
bet`), remainder-mod-25k is always < 25k tokens per wallet, and graduation
revokes the hook (proven: tiny #3 vault ended at lock + 157 dust, then
revocation freed everything). No fix needed; documenting so nobody "discovers"
it later. If a tail buy ever failed to graduate (contradicts the dust-cap
math — threshold crossing is quote-deterministic), that dust would need a
follow-up nibble, which the tail rule permits (see docs §8b).

### C2 — Walk buyable (774.85M) vs street plan (775M) — INFO, no action

Final weights yield 774.85M buyable, 0.15M under the 775M street assumption.
S4 simply holds 399.85M (3,998 × 100k + tail instead of 4,000 × 100k); the tail
rule absorbs any remainder by construction. Same class as the old 767.4M case.

### C3 — Closed-form vs walk lock computation differ by 443 raw units — INFO

Tiny #3 lock via `getBaseTokenForSwap` (381,671,616,432) vs tiny #2 walk-based
(381,671,616,875): Δ443 raw units. Harmless under `TAIL_DUST_CAP` = 10,000,
but keep the byte-verification step in the mainnet runbook (`migrations/deploy.ts`).

### Carried over (still open, unchanged)

- **Upgrade authority = single deployer key** (live-confirmed today:
  programdata authority `AHe1Y4…`). Policy (multisig/renounce timing) still
  undecided — docs §7.3. No layout changes in this upgrade, so the historical
  bricking risk did not trigger; the rule still stands for mainnet: finalize,
  then lock.
- **DBC mint/freeze authorities**: new mint per launch; confirm with Meteora
  that mint/freeze PDAs can't abuse user ATAs, for the mainnet mint.
- **Aggregator UX**: `ExactIn` buys still revert (`== bet` on buys kept by
  design). Terminal must force `ExactOut(bet)` — `scripts/spotcheck-pool2.ts`
  and `tiny3-buyout.ts` are the reference flows.

## 4. What's solid (verified, not just read)

- Tier boundaries incl. new 625M border, both pool layouts, buy exact/wrong/
  hold/authority, sell chips 25k/50k/75k/100k + over-bet/non-chip reverts,
  early-bag exit (50k → S3 in 1 tx), P2P, tail dust caps, vault key/amount
  binding, mint cross-check, strict-mode direct-call rejection.
- Extra-metas remain mint-derived + static pool only (any-DEX compatible).
- `HookConfig` layout untouched (113 B) — old pool PDAs deserialize fine.
- Concurrency: same as before (state re-evaluated per transfer; tail race-safe).
- Live proofs today: street checks on a real DBC pool under the new binary;
  full graduate → revoke → DAMM v2 on tiny #3 with the new bet sizes.

## 5. Severity summary

| ID | Finding | Severity |
|---|---|---|
| C1 | Transient non-25k dust pre-graduation, self-resolves at revocation | Low |
| C2 | 774.85M vs 775M street assumption, absorbed by tail | Info |
| C3 | Lock computation method Δ443 raw, within dust cap | Info |
| open | Upgrade authority single key, mint PDA verification, ExactIn UX | Open decisions |

**Critical: 0 · High: 0 · Medium: 0 · Low: 1 · Info: 2 · Open: 3 decisions**
