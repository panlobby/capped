# Project Audit Report — `capped-token` (`hook`)

**Date:** 2026-10-14  
**Scope:** On-chain program (`programs/hook/src/lib.rs`), tests (`tests/hook.ts`), curve modeling & scripts (`scripts/curve-matrix.ts`, `manual-step*.ts`), architecture docs (`docs/limits-architecture.md`), and repository configuration (`Cargo.toml`, `Anchor.toml`, `package.json`).

---

## 1. Executive Summary

- **Current Status:**
  - The Token-2022 transfer hook (`programs/hook/src/lib.rs`, 900 lines) compiles to BPF (`target/deploy/hook.so`).
  - **22/22 Rust unit tests** (`cargo test -p hook`) and **14/14 validator integration tests** (`tests/hook.ts`) pass.
  - Full lifecycle has been rehearsed on Solana Devnet with Meteora DBC (`createConfigWithTransferHook` → `createPoolWithTransferHook` → `initialize_config` + `initialize_extra_account_meta_list` → street buys/sells → P2P block → partner fee claim → tail buyout → hook revocation → DAMM v2 migration).
- **Overall Assessment:**
  - The core street/bet/hold math and pre-transfer balance reconstruction work as designed.
  - However, **2 Critical**, **3 High**, and **4 Medium** issues were identified in `programs/hook/src/lib.rs` and the deployment workflow. These must be resolved before mainnet deployment.

---

## 2. Summary of Findings

| ID | Severity | Location | Summary |
|---|---|---|---|
| **CRITICAL-1** | Critical | `programs/hook/src/lib.rs:90-111, 404-421` | `InitializeExtraMetas` lacks `config` PDA/mint binding and `authority` check — any pool can be permanently bricked before extra-metas init |
| **CRITICAL-2** | Critical | `programs/hook/src/lib.rs:73-79, 412-419` | `set_pool` cannot be followed by `initialize_extra_account_meta_list` (`init` fails on existing PDA), so calling `set_pool` bricks transfers |
| **HIGH-1** | High | `programs/hook/src/lib.rs:52-70, 364-379` | `initialize_config` has no caller or pool verification — front-running between pool creation and hook init can hijack or brick a pool |
| **HIGH-2** | High | `programs/hook/src/lib.rs:211-264` | Vault identity is only checked via `owner == POOL_AUTHORITY`, not `pool.base_vault` or DBC swap state — direct `transfer_checked` to `POOL_AUTHORITY` accounts is allowed |
| **HIGH-3** | High | `programs/hook/src/lib.rs:81-86, 115-128, 295-311` | Test-only instructions (`init_mock_pool`, non-strict `transfer_hook`) and mock pool parsers are active in the production binary; `pool_ai.owner` and discriminator are not checked |
| **MEDIUM-1** | Medium | `programs/hook/src/lib.rs:34, 247-252` | `TAIL_DUST_CAP = 1_000_000` (1 full token) is too loose and allows a partial tail buy that leaves the pool short of graduation |
| **MEDIUM-2** | Medium | `AGENTS.md` vs `docs/limits-architecture.md` | Product design trade-off: Permanent DBC (`migration_lock = 0`) vs Graduating DBC (`migration_lock > 0` revokes hook at $10M mcap) |
| **MEDIUM-3** | Medium | `programs/hook/src/lib.rs:74-79` | No instruction to update `migration_lock` if misconfigured during `initialize_config` |
| **MEDIUM-4** | Medium | `docs/limits-architecture.md` §1.3, §7.1 | Standard DEX UI `ExactIn` buys revert with `InvalidBetSize`; buys require `SwapMode::ExactOut` |
| **LOW-1** | Low | Root directory | 13 untracked `manual-step*.ts` throwaway files and duplicate lockfiles (`bun.lock`, `package-lock.json`) |
| **LOW-2** | Low | `programs/hook/Cargo.toml` | Unused dependencies (`anchor-spl`, `spl-associated-token-account`) and 17 compiler `unexpected_cfgs` warnings |
| **LOW-3** | Low | `package.json` / `tests/hook.ts` | `anchor test` fails on Node 26 (`mocha 9` / `yargs` ESM bug); integration tests only call `transfer_hook` directly instead of real Token-2022 CPI |
| **LOW-4** | Low | `docs/limits-architecture.md`, `scripts/curve-matrix.ts` | Outdated test status in §6 and stale `$20M` comments in `scripts/curve-matrix.ts` |

---

## 3. Detailed Technical Findings

### [CRITICAL-1] `InitializeExtraMetas` lacks `config` and `authority` validation — Any pool can be permanently bricked

- **Location:** `programs/hook/src/lib.rs:90-111`, `404-421`
- **Code:**
  ```rust
  #[derive(Accounts)]
  pub struct InitializeExtraMetas<'info> {
      #[account(mut)]
      pub payer: Signer<'info>,
      /// CHECK: validated in handler
      pub mint: UncheckedAccount<'info>,
      pub config: Account<'info, HookConfig>,
      /// CHECK: PDA ["extra-account-metas", mint], created here
      #[account(
          init,
          payer = payer,
          space = ExtraAccountMetaList::size_of(2).unwrap(),
          seeds = [b"extra-account-metas", mint.key().as_ref()],
          bump
      )]
      pub extra_account_meta_list: UncheckedAccount<'info>,
      pub system_program: Program<'info, System>,
  }
  ```
- **Vulnerability:**
  1. Despite the comment `/// CHECK: validated in handler`, `mint` is **not** validated in `initialize_extra_account_meta_list`.
  2. `config` has no `seeds = [b"config", mint.key().as_ref()]` or `has_one = mint` constraint.
  3. `payer` is not required to match `config.authority`.
- **Exploit Scenario:**
  1. Attacker creates a dummy `mint_B` and calls `initialize_config(fake_pool, 1)` to create a valid `HookConfig` account (`config_B`) owned by the hook program.
  2. Before the deployer calls `initialize_extra_account_meta_list` for the real `mint_A`, the attacker calls `initialize_extra_account_meta_list` passing `mint = mint_A` and `config = config_B`.
  3. The PDA `["extra-account-metas", mint_A]` is initialized with `fake_pool`.
  4. On every transfer of `mint_A`, Token-2022 resolves `pool_ai = fake_pool`, while `config_A.pool = real_pool`. `execute_checks` fails at line 200 (`require_keys_eq!(pool_ai.key(), cfg_pool, ErrorCode::WrongPool)`), and because `extra_account_meta_list` cannot be re-initialized, **`mint_A` is permanently bricked**.
- **Recommendation:**
  ```rust
  #[derive(Accounts)]
  pub struct InitializeExtraMetas<'info> {
      #[account(mut)]
      pub authority: Signer<'info>,
      /// CHECK: bound via config PDA seeds and has_one
      pub mint: UncheckedAccount<'info>,
      #[account(
          seeds = [b"config", mint.key().as_ref()],
          bump = config.bump,
          has_one = authority @ ErrorCode::Unauthorized,
          has_one = mint @ ErrorCode::WrongConfig,
      )]
      pub config: Account<'info, HookConfig>,
      ...
  }
  ```

---

### [CRITICAL-2] `set_pool` cannot be followed by `initialize_extra_account_meta_list` — Calling `set_pool` bricks the token

- **Location:** `programs/hook/src/lib.rs:73-79`, `412-419`
- **Vulnerability:**
  `set_pool` updates `ctx.accounts.config.pool = pool`, with the doc comment:
  `/// Update static pool address (authority only). Re-run init_extra_metas after.`
  However, `InitializeExtraMetas` uses `#[account(init, ...)]` on `extra_account_meta_list`. Once `extra_account_meta_list` exists, calling `initialize_extra_account_meta_list` again always fails because the account is already initialized.
  As a result, calling `set_pool` after `initialize_extra_account_meta_list` creates a permanent mismatch between `config.pool` and the static `pool` pubkey inside `extra_account_meta_list`, bricking all transfers.
- **Recommendation:**
  Either update `extra_account_meta_list` directly inside `set_pool` using `ExtraAccountMetaList::update::<ExecuteInstruction>(&mut data, &account_metas)`, or remove `set_pool` if the pool address is immutable per mint.

---

### [HIGH-1] `initialize_config` has no caller or pool validation — Front-running risk at launch

- **Location:** `programs/hook/src/lib.rs:52-70`, `364-379`
- **Vulnerability:**
  `initialize_config` accepts any `authority: Signer` and any `mint: UncheckedAccount` without verifying that `authority` is the pool creator or that `pool` is a valid Meteora DBC pool for `mint`.
  When `createPoolWithTransferHook` and `initialize_config` are sent in separate transactions (as in `manual-step3.ts` + `manual-step4.ts`), an attacker monitoring new blocks can front-run `initialize_config` for the new `mint` with an invalid `pool` or `migration_lock` and permanently brick the pool.
- **Recommendation:**
  1. **On-chain:** Pass `pool` as an `UncheckedAccount` in `InitializeConfig` and verify:
     - `pool.owner == &DBC_PROGRAM_ID`
     - `pool.data[0..8] == TRANSFER_HOOK_POOL_DISC` (`eddbb8172abda923`)
     - `pool.data[104..136] == authority.key().as_ref()` (`pool.creator == authority`)
     - `pool.data[136..168] == mint.key().as_ref()` (`pool.base_mint == mint`)
  2. **Off-chain:** Combine `createPoolWithTransferHook`, `initialize_config`, and `initialize_extra_account_meta_list` into a single atomic transaction (or Jito bundle) at launch.

---

### [HIGH-2] Vault identity is only checked via `owner == POOL_AUTHORITY`, not `pool.base_vault` or DBC swap state

- **Location:** `programs/hook/src/lib.rs:211-264`
- **Vulnerability:**
  `execute_checks` determines transfer direction using only:
  ```rust
  let src_is_pool = src_owner == POOL_AUTHORITY;
  let dst_is_pool = dst_owner == POOL_AUTHORITY;
  ```
  1. On a **sell** (`dst_is_pool`), `authority` is the user (`src_owner`), not `POOL_AUTHORITY`.
  2. `execute_checks` never verifies that `source.key()` (on buy) or `destination.key()` (on sell) equals the pool's `base_vault` (stored in `TransferHookPool` at offset `168..200`). Anyone can create an arbitrary Token-2022 account for `mint` with `owner = POOL_AUTHORITY` and transfer `bet`-sized chunks into it outside of DBC.
  3. Even when `destination` is the real `base_vault`, a user can invoke `spl_token_2022::transfer_checked` directly to `base_vault` without calling DBC's `swap2_with_transfer_hook`. This increases `base_vault.amount` without updating `pool.base_reserve` (offset `232..240`), desynchronizing the token account balance from DBC's virtual pool state.
- **Recommendation:**
  1. Parse `base_vault = Pubkey::new_from_array(pool_data[168..200])` from `pool_ai` and enforce:
     - On buy: `source.key() == base_vault`
     - On sell: `destination.key() == base_vault`
  2. Because `collect_fee_mode == QuoteToken` (no base fees stay in the vault), during any legitimate DBC swap, DBC updates `pool.base_reserve` and Token-2022 updates `base_vault.amount` by the exact same `amount`. Requiring `vault_token_amount == remaining` (`pool.base_reserve`) proves that DBC's `swap2_with_transfer_hook` is actively executing and blocks raw `transfer_checked` donations into `base_vault`.

---

### [HIGH-3] Test-only instructions and mock pool parsers are compiled into the production binary

- **Location:** `programs/hook/src/lib.rs:81-86`, `115-128`, `295-311`
- **Vulnerability:**
  1. `init_mock_pool` and `MockPool` are present in the production binary.
  2. `read_base_reserve` falls back to reading 16-byte and 8-byte accounts (`else if data.len() >= 16` / `else if data.len() >= 8`), and `execute_checks` never checks `pool_ai.owner == DBC_PROGRAM_ID` or the `TransferHookPool` discriminator (`eddbb8172abda923`).
  3. The non-strict `pub fn transfer_hook` Anchor instruction (`strict_transferring = false`) is compiled into production alongside `fallback`.
- **Recommendation:**
  Gate `init_mock_pool`, `MockPool`, the `< 240` byte fallback branches in `read_base_reserve`, and `pub fn transfer_hook` behind `#[cfg(feature = "test-mode")]` (or `#[cfg(test)]`), and strictly validate `pool_ai.owner` and discriminator in production builds.

---

### [MEDIUM-1] `TAIL_DUST_CAP = 1_000_000` (1 token) is too loose and allows a non-graduating tail buy

- **Location:** `programs/hook/src/lib.rs:34`, `247-252`
- **Problem:**
  When `buyable < bet`, the tail rule requires:
  `remaining.saturating_sub(migration_lock) <= TAIL_DUST_CAP` where `TAIL_DUST_CAP = 1_000_000` (`1.0` token).
  - On the main curve (`1B` supply, `100,000 SOL` migration mcap), `1.0` token at the end of the curve costs `~0.0001 SOL` (`~100,000` lamports).
  - Actual DBC sqrt-price rounding dust observed on devnet is only `459` raw units (`0.000459` tokens).
  - If a buyer executes a tail buy of `buyable - 990_000` raw units (leaving `0.99` tokens above `migration_lock`), the hook allows it, **but `quote_reserve` will fall ~99,000 lamports short of `migration_quote_threshold` and the pool will not graduate in that swap**.
  - The buyer is then left holding `~7,058` tokens that cannot be sold (sells require `amount == 12,500`) until a second tail buy drains the remaining `0.99` tokens.
- **Recommendation:**
  Reduce `TAIL_DUST_CAP` from `1_000_000` to `5_000` or `10_000` raw units (`0.005–0.01` tokens). This is still 10–20× larger than the 459-unit DBC rounding dust while ensuring the tail buy always crosses `migration_quote_threshold` and graduates in a single swap.

---

### [MEDIUM-2] Product/Game Design Trade-off: Permanent DBC vs Graduating DBC

- **Location:** `AGENTS.md` vs `docs/limits-architecture.md` §1.2, §2
- **Analysis:**
  - `AGENTS.md` notes the intention to use a **permanent DBC** because Meteora DBC revokes the transfer hook upon graduation (`revoke_transfer_hook()`).
  - With the current `migration_lock > 0` and tail rule enabled, the pool **can** graduate once `23,256 SOL` flows in (`$10M` mcap at `$100/SOL`), after which the hook is permanently removed and the pool migrates to DAMM v2 with no transfer restrictions.
  - Conversely, setting `migration_lock = 0` (strict `amount == bet` everywhere, no tail exception) makes graduation **mathematically impossible** because `buyable (767,432,058.99) % 12,500 = 7,058.99 != 0`. The last `7,058.99` tokens can never be bought, acting as a mathematical hard stop that keeps the pool and its transfer hook active on DBC forever while allowing buys and sells across 99.999% of the supply.
- **Recommendation:**
  Make a final product decision before mainnet:
  - **Option A (Graduating DBC at $10M mcap):** Keep `migration_lock > 0` with `TAIL_DUST_CAP = 10_000`.
  - **Option B (Permanent DBC):** Remove the tail rule (or set `migration_lock = 0`) so the curve can never graduate and the hook remains active permanently.

---

### [MEDIUM-3] No way to update `migration_lock` if misconfigured at initialization

- **Location:** `programs/hook/src/lib.rs:74-79`
- **Problem:**
  `set_pool` only updates `config.pool`. If `migration_lock` is miscalculated when calling `initialize_config`, `pre_remaining.checked_sub(migration_lock)` can underflow (`InvalidPool`) or trigger the tail rule at the wrong point, with no authority instruction to fix `config.migration_lock`.
- **Recommendation:**
  Either compute `migration_lock` deterministically or allow `authority` to update `migration_lock` (or lock config updates completely once verified).

---

### [MEDIUM-4] Standard DEX UI `ExactIn` buys will revert with `InvalidBetSize`

- **Location:** `docs/limits-architecture.md` §1.3, §7.1
- **Problem:**
  Because the hook requires `amount == bet` (exact base tokens), **sells** work natively on standard DEX UIs (user enters exact token amount `50,000` / `25,000` / `12,500`), whereas **buys** on standard UIs default to `ExactIn` (user enters SOL amount), which outputs a fractional token amount and reverts with `InvalidBetSize`.
- **Recommendation:**
  Ensure the project frontend / trading widget submits buys using `SwapMode::ExactOut` (`swap2WithTransferHook` with `amountOut = bet` and `maximumAmountIn` from `swapQuote2`).

---

## 4. Low Findings, Tooling & Repository Hygiene

### [LOW-1] Untracked `manual-step*.ts` throwaway files and duplicate lockfiles
- **Problem:**
  - 13 untracked scripts (`manual-step2.ts` .. `manual-step10migrate.ts`) sit in the repository root.
  - Both `bun.lock` and `package-lock.json` exist and are untracked.
- **Recommendation:**
  - Delete the throwaway `manual-step*.ts` scripts and consolidate reusable scripts (`create-config.ts`, `launch-pool.ts`, `claim-fees.ts`) under `scripts/`.
  - Standardize on either `bun` or `npm`, commit one lockfile, and add the other to `.gitignore`.

### [LOW-2] Unused dependencies and 17 compiler warnings in `programs/hook`
- **Problem:**
  - `anchor-spl = "0.31.2"` and `spl-associated-token-account = "6.0.0"` in `programs/hook/Cargo.toml` are unused in `programs/hook/src/lib.rs`.
  - Building or testing `hook` emits 17 `unexpected_cfgs` warnings from `anchor-lang 0.31.2` macros.
- **Recommendation:**
  - Remove `anchor-spl` and `spl-associated-token-account` from `programs/hook/Cargo.toml`.
  - Add `[lints.rust]` configuration in `programs/hook/Cargo.toml` to allow Anchor's `custom-heap`, `custom-panic`, `anchor-debug`, and `target_os = "solana"` cfgs.

### [LOW-3] `anchor test` broken on Node 26 & integration test coverage gap
- **Problem:**
  - `mocha ^9.0.3` / `ts-mocha ^10.0.0` fail on Node 26 due to an old `yargs` ESM error when running `anchor test`.
  - `tests/hook.ts` only invokes the non-strict `transfer_hook` instruction directly using standard SPL Token mints (`@solana/spl-token` `createMint`), rather than testing real Token-2022 `transferCheckedWithTransferHook` CPI through `fallback` with `initialize_extra_account_meta_list`.
- **Recommendation:**
  - Update `Anchor.toml` `[scripts] test` to run via `bun` or upgrade `mocha`/`ts-mocha`.
  - Add a local validator integration test in `tests/hook.ts` that creates a real Token-2022 mint with the `TransferHook` extension, initializes `extra_account_meta_list`, and executes `transferCheckedWithTransferHook` (verifying the strict `fallback` CPI path locally).

### [LOW-4] Documentation and script comment drift
- **Problem:**
  - `docs/limits-architecture.md` §6 (lines 186–192) still says `"14/14 pass"` and `"tests/hook.ts: validator integration written, blocked — anchor build fails"`, contradicting lines 8–10 and §8.
  - `scripts/curve-matrix.ts` lines 1, 37, 42, 96 still reference `$20M` / `200,000 SOL` in comments/logs while `MIGRATION_MCAP_SOL = 100_000` (`$10M`).
- **Recommendation:**
  - Update `docs/limits-architecture.md` §6 and `scripts/curve-matrix.ts` comments to match the current `$10M` / `100,000 SOL` spec and 22/22 + 14/14 test status.

---

## 5. Mainnet Readiness Checklist

- [ ] **Step 1 (Product Decision):** Decide between Graduating DBC at $10M mcap (`migration_lock > 0`, `TAIL_DUST_CAP = 10_000`) vs Permanent DBC (`migration_lock = 0`, strict `amount == bet` forever).
- [ ] **Step 2 (Fix CRITICAL-1 & CRITICAL-2):** Add `seeds`, `bump`, `has_one = mint`, and `has_one = authority` constraints to `InitializeExtraMetas`, and synchronize `extra_account_meta_list` if `set_pool` is kept.
- [ ] **Step 3 (Fix HIGH-1):** Validate `pool` owner, discriminator, `creator`, and `base_mint` in `initialize_config`.
- [ ] **Step 4 (Fix HIGH-2):** Verify `source`/`destination` against `pool.base_vault` (`pool_data[168..200]`) and enforce `vault_token_amount == pool.base_reserve` (`pool_data[232..240]`).
- [ ] **Step 5 (Fix HIGH-3):** Gate `init_mock_pool`, `MockPool`, and non-strict `transfer_hook` behind a `test-mode` Cargo feature; enforce `pool_ai.owner == DBC_PROGRAM_ID` and discriminator check in production.
- [ ] **Step 6 (Clean Up & Test):** Remove unused Cargo dependencies, silence warnings, add a real Token-2022 `transferCheckedWithTransferHook` local validator test, replace `manual-step*.ts` with an atomic launch script in `scripts/`, and update `docs/limits-architecture.md`.
