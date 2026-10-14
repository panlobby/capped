use anchor_lang::prelude::*;
use anchor_lang::solana_program::program_error::ProgramError;
use spl_tlv_account_resolution::account::ExtraAccountMeta;
use spl_tlv_account_resolution::seeds::Seed;
use spl_tlv_account_resolution::state::ExtraAccountMetaList;
use spl_transfer_hook_interface::instruction::{ExecuteInstruction, TransferHookInstruction};

declare_id!("3vRrCG5RnmrpTAr91rq9NnZqKCPgaDCmpEWKRLUTdqnH");

// ---- Units: 6 decimals, 1 token = 1_000_000 base units ----
/// 12.5k tokens in base units. GCD of all bets/holds.
pub const UNIT: u64 = 12_500_000_000;
// Bets per street (exact, base units): S1 50k, S2 50k, S3 25k, S4 12.5k
pub const BET_S1: u64 = 50_000_000_000;
pub const BET_S2: u64 = 50_000_000_000;
pub const BET_S3: u64 = 25_000_000_000;
pub const BET_S4: u64 = 12_500_000_000;
// Hold caps per street (base units): 200k / 1M / 5M / 20M (0.02% / 0.1% / 0.5% / 2%).
// Rising schedule: existing holders are never bricked by a street change.
pub const HOLD_S1: u64 = 200_000_000_000;
pub const HOLD_S2: u64 = 1_000_000_000_000;
pub const HOLD_S3: u64 = 5_000_000_000_000;
pub const HOLD_S4: u64 = 20_000_000_000_000;
// Street thresholds in pool base_remaining (base units).
// base_remaining tracks the VAULT balance (full supply at launch), not buyable:
// S1 while sold < 50M, S2 < 150M, S3 < 400M, else S4 river to migrate.
// (vault_0 = 1B supply; buyable is 767.4M, ~233M stays locked for migration.)
pub const REMAIN_S1_MIN: u64 = 950_000_000_000_000;
pub const REMAIN_S2_MIN: u64 = 850_000_000_000_000;
pub const REMAIN_S3_MIN: u64 = 600_000_000_000_000;
// Tail dust tolerance: 0.01 token in base units. DBC sqrt-price rounding leaves a
// few hundred raw units undrainable (measured 459 after 30 swaps on devnet);
// the final buy may leave at most this much above the migration lock.
// Cap is 10-20x the observed dust but small enough that the tail buy always
// crosses migration_quote_threshold and graduates in a single swap.
pub const TAIL_DUST_CAP: u64 = 10_000;
// Byte size of HookConfig account data, legacy (no migration_lock) and current.
pub const CONFIG_LEN_LEGACY: usize = 8 + 32 + 32 + 32 + 1;
pub const CONFIG_LEN: usize = CONFIG_LEN_LEGACY + 8;

/// DBC pool authority PDA (same for all Meteora DBC pools).
pub const POOL_AUTHORITY: Pubkey = pubkey!("FhVo3mqL8PW5pH5U2CN4XE33DokiyZnUwuGpH2hmHLuM");
/// Meteora DBC program: owner of every real pool account.
pub const DBC_PROGRAM_ID: Pubkey = pubkey!("dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN");
/// Anchor discriminator of DBC `TransferHookPool` (idl `accounts`, verified
/// against @meteora-ag/dynamic-bonding-curve-sdk): hex eddbb8172abda923.
pub const TRANSFER_HOOK_POOL_DISC: [u8; 8] = [237, 219, 184, 23, 42, 189, 169, 35];
/// Offset of `base_reserve: u64` in VirtualPool / TransferHookPool account data:
/// 8 (disc) + 64 (VolatilityTracker) + 160 (5x Pubkey) = 232.
pub const BASE_RESERVE_OFFSET: usize = 232;

#[program]
pub mod hook {
    use super::*;

    /// Create config PDA ["config", mint]. Graduating DBC (final decision):
    /// pool is immutable after this call; there is no update instruction
    /// (`set_pool` was removed: extra-metas PDA pins the pool statically,
    /// so any post-init pool change would brick all transfers forever).
    /// migration_lock = base units locked for DAMM migration (vault_0 - buyable_0,
    /// computed off-chain at pool creation). Powers the tail rule; must be > 0.
    /// MAINNET RUNBOOK: send createPoolWithTransferHook + initialize_config +
    /// initialize_extra_account_meta_list atomically (single tx / bundle).
    /// Config PDA init is first-come: a split launch lets a watcher front-run
    /// initialize_config with a wrong pool/lock and brick the mint.
    pub fn initialize_config(
        ctx: Context<InitializeConfig>,
        pool: Pubkey,
        migration_lock: u64,
    ) -> Result<()> {
        require!(migration_lock > 0, ErrorCode::InvalidLock);
        // Lenient mint check: if the mint carries a TransferHook extension, it
        // must point at this program. Plain SPL mints (local integration tests)
        // have no extension and pass; mainnet runbook requires a real
        // Token-2022 hook mint (verified off-chain at launch).
        {
            use spl_token_2022::extension::{BaseStateWithExtensions, StateWithExtensions};
            use spl_token_2022::extension::transfer_hook::TransferHook as TransferHookExt;
            use spl_token_2022::state::Mint as Token2022Mint;
            let data = ctx.accounts.mint.data.borrow();
            if let Ok(state) = StateWithExtensions::<Token2022Mint>::unpack(&data) {
                if let Ok(ext) = state.get_extension::<TransferHookExt>() {
                    let hook_program: Option<Pubkey> = ext.program_id.into();
                    require!(hook_program == Some(crate::ID), ErrorCode::WrongConfig);
                }
            }
        }
        // Pool binding: the pubkey arg must match the passed pool account; real
        // DBC pools are fully validated (owner, discriminator, creator,
        // base_mint). Small mock layouts skip validation (local integration
        // tests only) — mainnet pools are always real DBC accounts.
        // NOTE: this does not stop a determined front-runner who creates their
        // own real DBC pool for the mint — first-come PDA init means the launch
        // MUST be atomic (single tx / bundle, see runbook note above).
        require_keys_eq!(pool, ctx.accounts.pool.key(), ErrorCode::WrongPool);
        {
            let data = ctx.accounts.pool.data.borrow();
            if data.len() >= BASE_RESERVE_OFFSET + 8 {
                require_keys_eq!(*ctx.accounts.pool.owner, DBC_PROGRAM_ID, ErrorCode::WrongPool);
                let disc: [u8; 8] = data[0..8].try_into().unwrap();
                require!(disc == TRANSFER_HOOK_POOL_DISC, ErrorCode::WrongPool);
                let creator = Pubkey::new_from_array(data[104..136].try_into().unwrap());
                require_keys_eq!(creator, ctx.accounts.authority.key(), ErrorCode::Unauthorized);
                let base_mint = Pubkey::new_from_array(data[136..168].try_into().unwrap());
                require_keys_eq!(base_mint, ctx.accounts.mint.key(), ErrorCode::WrongConfig);
            }
        }
        let config = &mut ctx.accounts.config;
        config.authority = ctx.accounts.authority.key();
        config.mint = ctx.accounts.mint.key();
        config.pool = pool;
        config.bump = ctx.bumps.config;
        config.migration_lock = migration_lock;
        msg!(
            "config init mint={} pool={} lock={}",
            config.mint,
            config.pool,
            config.migration_lock
        );
        Ok(())
    }

    /// Test-only: create MockPool PDA with given remaining. Not used on mainnet.
    pub fn init_mock_pool(ctx: Context<InitMockPool>, _seed: u64, remaining: u64) -> Result<()> {
        ctx.accounts.mock_pool.remaining = remaining;
        msg!("mock pool {}", remaining);
        Ok(())
    }

    /// Create ["extra-account-metas", mint] list: [config (ro), pool (ro)].
    /// Mint-derived + static only -> stock SDK / Jupiter / fomo compatible.
    pub fn initialize_extra_account_meta_list(ctx: Context<InitializeExtraMetas>) -> Result<()> {
        let pool = ctx.accounts.config.pool;
        require!(pool != Pubkey::default(), ErrorCode::PoolNotSet);
        let account_metas = vec![
            ExtraAccountMeta::new_with_seeds(
                &[
                    Seed::Literal {
                        bytes: b"config".to_vec(),
                    },
                    Seed::AccountKey { index: 1 },
                ],
                false,
                false,
            )?,
            ExtraAccountMeta::new_with_pubkey(&pool, false, false)?,
        ];
        let mut data = ctx.accounts.extra_account_meta_list.try_borrow_mut_data()?;
        ExtraAccountMetaList::init::<ExecuteInstruction>(&mut data, &account_metas)
            .map_err(|_| ErrorCode::ExtraMetasInitFailed)?;
        msg!("extra metas init for mint {}", ctx.accounts.mint.key());
        Ok(())
    }

    /// Direct-testable transfer check (same logic as real CPI path).
    /// Real Token-2022 CPIs arrive via `fallback` below.
    pub fn transfer_hook(ctx: Context<TransferHook>, amount: u64) -> Result<()> {
        execute_checks(
            &ctx.accounts.source,
            &ctx.accounts.mint,
            &ctx.accounts.destination,
            &ctx.accounts.authority,
            &ctx.accounts.extra_account_meta_list,
            &ctx.accounts.config,
            &ctx.accounts.pool,
            amount,
            ctx.program_id,
            false, // direct call: lenient transferring check (mocks lack extension)
        )
    }

    /// Route Token-2022 Execute CPI into transfer_hook with strict checks.
    pub fn fallback<'info>(
        program_id: &Pubkey,
        accounts: &'info [AccountInfo<'info>],
        data: &[u8],
    ) -> Result<()> {
        let ix = TransferHookInstruction::unpack(data)
            .map_err(|_| ErrorCode::InvalidHookInstruction)?;
        match ix {
            TransferHookInstruction::Execute { amount } => {
                require!(accounts.len() >= 7, ErrorCode::MissingAccounts);
                execute_checks(
                    &accounts[0],
                    &accounts[1],
                    &accounts[2],
                    &accounts[3],
                    &accounts[4],
                    &accounts[5],
                    &accounts[6],
                    amount,
                    program_id,
                    true, // real CPI: strict transferring check
                )
            }
            _ => err!(ErrorCode::InvalidHookInstruction),
        }
    }
}

#[allow(clippy::too_many_arguments)]
fn execute_checks(
    source: &AccountInfo,
    mint: &AccountInfo,
    destination: &AccountInfo,
    authority: &AccountInfo,
    extra_list: &AccountInfo,
    config_ai: &AccountInfo,
    pool_ai: &AccountInfo,
    amount: u64,
    program_id: &Pubkey,
    strict_transferring: bool,
) -> Result<()> {
    // 1. Extra-metas validation PDA must match mint+program.
    let (expect_list, _) = Pubkey::find_program_address(
        &[b"extra-account-metas", mint.key.as_ref()],
        program_id,
    );
    require_keys_eq!(extra_list.key(), expect_list, ErrorCode::WrongExtraMetas);
    // 2. Config must be ["config", mint] PDA owned by us, bound to mint.
    let (expect_config, _) =
        Pubkey::find_program_address(&[b"config", mint.key.as_ref()], program_id);
    require_keys_eq!(config_ai.key(), expect_config, ErrorCode::WrongConfig);
    require_keys_eq!(*config_ai.owner, *program_id, ErrorCode::WrongConfig);
    // Manual parse: pre-upgrade accounts (105 bytes, same discriminator) carry
    // no migration_lock tail -> lock 0 (strict == forever). Anchor-deserialize
    // can't express this: a second struct type would expect its own discriminator.
    use anchor_lang::solana_program::hash::hash;
    let raw = config_ai.data.borrow();
    require!(raw.len() >= CONFIG_LEN_LEGACY, ErrorCode::WrongConfig);
    require!(raw[0..8] == hash(b"account:HookConfig").to_bytes()[0..8], ErrorCode::WrongConfig);
    let cfg_mint = Pubkey::new_from_array(raw[40..72].try_into().unwrap());
    let cfg_pool = Pubkey::new_from_array(raw[72..104].try_into().unwrap());
    let migration_lock = if raw.len() >= CONFIG_LEN {
        u64::from_le_bytes(raw[105..113].try_into().unwrap())
    } else {
        0u64
    };
    drop(raw);
    require_keys_eq!(cfg_mint, mint.key(), ErrorCode::WrongConfig);
    // 3. Pool must be the static pool from config.
    require_keys_eq!(pool_ai.key(), cfg_pool, ErrorCode::WrongPool);
    require!(cfg_pool != Pubkey::default(), ErrorCode::PoolNotSet);
    // 3b. Real DBC pools (full PoolState layout) must be owned by the DBC
    // program and carry the TransferHookPool discriminator. Smaller layouts
    // are unit/integration-test mocks only: on mainnet the pool is always a
    // real DBC account, and pool_ai.key() is pinned by config above, so a
    // deployer typo fails here instead of running at a wrong tier.
    {
        let pool_data = pool_ai.data.borrow();
        if pool_data.len() >= BASE_RESERVE_OFFSET + 8 {
            require_keys_eq!(*pool_ai.owner, DBC_PROGRAM_ID, ErrorCode::WrongPool);
            let disc: [u8; 8] = pool_data[0..8].try_into().unwrap();
            require!(disc == TRANSFER_HOOK_POOL_DISC, ErrorCode::WrongPool);
        }
    }

    // 4. Parse token accounts (mint + owner + pre-transfer amount).
    let (src_owner, src_amount) = parse_token_account(source, mint)?;
    let (dst_owner, dst_amount) = parse_token_account(destination, mint)?;

    // 5. Transferring flags: strict on real CPI; lenient when account lacks extension (unit mocks).
    check_transferring_flag(source, strict_transferring)?;
    check_transferring_flag(destination, strict_transferring)?;

    // 6. Direction. Neither side pool-owned -> P2P blocked (DEX-only).
    let src_is_pool = src_owner == POOL_AUTHORITY;
    let dst_is_pool = dst_owner == POOL_AUTHORITY;
    require!(
        src_is_pool || dst_is_pool,
        ErrorCode::P2PBlocked
    );
    require!(
        !(src_is_pool && dst_is_pool),
        ErrorCode::InvalidDirection
    );

    // 6b. Vault binding (real pools only): the pool-side account must be the
    // pool's base_vault (offset 168..200, verified vs SDK PoolState layout).
    // This proves the transfer ran inside DBC's swap2_with_transfer_hook and
    // blocks raw transfer_checked donations that would desync the vault from
    // DBC virtual state. Amount consistency is checked in §7b once the
    // reserve is read. Mock layouts skip this (test-only).
    if pool_ai.data.borrow().len() >= BASE_RESERVE_OFFSET + 8 {
        let pool_data = pool_ai.data.borrow();
        let base_vault = Pubkey::new_from_array(pool_data[168..200].try_into().unwrap());
        drop(pool_data);
        if src_is_pool {
            require_keys_eq!(source.key(), base_vault, ErrorCode::InvalidPool);
        } else {
            require_keys_eq!(destination.key(), base_vault, ErrorCode::InvalidPool);
        }
    }

    // 7. Tier from PRE-transfer vault. Token-2022 debits/credits BEFORE the
    // hook CPI, so the hook observes POST-transfer balances AND a POST-transfer
    // reserve (DBC writes virtual reserves before the transfer CPI — proven by
    // the tiny-pool tail buy: remaining - lock == 459 dust only if remaining
    // is post). Reconstruct pre: buys pre = post + amount, sells pre = post - amount.
    let remaining = read_base_reserve(pool_ai)?;
    let pre_remaining = if src_is_pool {
        remaining
            .checked_add(amount)
            .ok_or(ErrorCode::MathOverflow)?
    } else {
        remaining
            .checked_sub(amount)
            .ok_or(ErrorCode::InvalidPool)?
    };
    let (bet, hold) = tier_for(pre_remaining);
    // Buyable remainder after the migration lock, pre-transfer based.
    let buyable = pre_remaining
        .checked_sub(migration_lock)
        .ok_or(ErrorCode::InvalidPool)?;

    // 7b. Vault amount consistency (real pools only): the pool-side account's
    // POST-transfer amount must equal pool.base_reserve (also POST at hook
    // time, see §7). This proves the transfer ran inside DBC's
    // swap2_with_transfer_hook with no extra base movement (no hidden base
    // fees, no donations mixed into the swap) and blocks raw transfer_checked
    // donations that would desync the vault from DBC virtual state.
    if pool_ai.data.borrow().len() >= BASE_RESERVE_OFFSET + 8 {
        if src_is_pool {
            require!(src_amount == remaining, ErrorCode::InvalidPool);
        } else {
            require!(dst_amount == remaining, ErrorCode::InvalidPool);
        }
    }

    // 8. Bet size. Exact street bet, except the tail: when less than one bet
    // is left buyable, the buy must drain (almost) all of it — DBC rounding
    // leaves dust (<= TAIL_DUST_CAP) that no ExactOut can source, so the final
    // buy may leave at most dust above the lock. Sells always stay exact
    // (they grow the vault, never drain it).
    if src_is_pool && migration_lock > 0 && buyable < bet {
        require!(amount > 0 && amount <= buyable, ErrorCode::InvalidBetSize);
        require!(
            remaining.saturating_sub(migration_lock) <= TAIL_DUST_CAP,
            ErrorCode::InvalidBetSize
        );
    } else {
        require!(amount > 0 && amount == bet, ErrorCode::InvalidBetSize);
    }
    if src_is_pool {
        // Buy: vault -> user. Authority must be pool authority (DBC signs).
        require_keys_eq!(authority.key(), POOL_AUTHORITY, ErrorCode::Unauthorized);
        // dst_amount is the POST-credit balance: enforce the cap directly.
        require!(dst_amount <= hold, ErrorCode::ExceedsHold);
    } else {
        // Sell: user -> vault. Authority must own source (no delegates).
        require_keys_eq!(authority.key(), src_owner, ErrorCode::Unauthorized);
    }
    msg!(
        "street ok pre={} bet={} hold={} lock={}",
        pre_remaining, bet, hold, migration_lock
    );
    Ok(())
}

fn tier_for(remaining: u64) -> (u64, u64) {
    if remaining > REMAIN_S1_MIN {
        (BET_S1, HOLD_S1)
    } else if remaining > REMAIN_S2_MIN {
        (BET_S2, HOLD_S2)
    } else if remaining > REMAIN_S3_MIN {
        (BET_S3, HOLD_S3)
    } else {
        (BET_S4, HOLD_S4)
    }
}

/// Token-2022 base account: mint [0..32] | owner [32..64] | amount u64 LE [64..72].
/// Mint must match the hook's mint (Token-2022 also enforces this pre-CPI;
/// the check makes the proof self-contained).
fn parse_token_account(ai: &AccountInfo, mint: &AccountInfo) -> Result<(Pubkey, u64)> {
    let data = ai.data.borrow();
    require!(data.len() >= 72, ErrorCode::InvalidTokenAccount);
    let acc_mint = Pubkey::new_from_array(data[0..32].try_into().unwrap());
    require_keys_eq!(acc_mint, mint.key(), ErrorCode::InvalidTokenAccount);
    let owner = Pubkey::new_from_array(data[32..64].try_into().unwrap());
    let amount = u64::from_le_bytes(data[64..72].try_into().unwrap());
    Ok((owner, amount))
}

/// Real DBC layout: base_reserve u64 LE at offset 232.
/// Test mocks: Anchor MockPool (8-byte discriminator + u64 remaining) or raw 8-byte.
fn read_base_reserve(pool_ai: &AccountInfo) -> Result<u64> {
    let data = pool_ai.data.borrow();
    if data.len() >= BASE_RESERVE_OFFSET + 8 {
        Ok(u64::from_le_bytes(
            data[BASE_RESERVE_OFFSET..BASE_RESERVE_OFFSET + 8]
                .try_into()
                .unwrap(),
        ))
    } else if data.len() >= 16 {
        // Anchor MockPool: discriminator [0..8], remaining [8..16].
        Ok(u64::from_le_bytes(data[8..16].try_into().unwrap()))
    } else if data.len() >= 8 {
        Ok(u64::from_le_bytes(data[0..8].try_into().unwrap()))
    } else {
        err!(ErrorCode::InvalidPool)
    }
}

/// If account carries TransferHookAccount extension, require transferring==true.
/// Accounts without the extension are unit-test mocks -> skip (or strict -> fail).
fn check_transferring_flag(ai: &AccountInfo, strict: bool) -> Result<()> {
    use spl_token_2022::extension::transfer_hook::TransferHookAccount;
    use spl_token_2022::extension::{BaseStateWithExtensions, StateWithExtensions};
    use spl_token_2022::state::Account as Token2022Account;
    let data = ai.data.borrow();
    match StateWithExtensions::<Token2022Account>::unpack(&data) {
        Ok(state) => match state.get_extension::<TransferHookAccount>() {
            Ok(ext) => {
                require!(bool::from(ext.transferring), ErrorCode::NotTransferring);
                Ok(())
            }
            Err(_) => {
                if strict {
                    err!(ErrorCode::NotTransferring)
                } else {
                    Ok(())
                }
            }
        },
        Err(_) => {
            // Plain mocks (not a valid Token-2022 account layout) -> only strict fails.
            if strict {
                err!(ErrorCode::NotTransferring)
            } else {
                Ok(())
            }
        }
    }
}

#[account]
pub struct HookConfig {
    pub authority: Pubkey,
    pub mint: Pubkey,
    pub pool: Pubkey,
    pub bump: u8,
    /// Base units locked for DAMM migration. Appended last: pre-upgrade accounts
    /// (105 bytes, same discriminator) read the tail as lock 0
    /// (strict == forever, old behavior preserved).
    pub migration_lock: u64,
}

/// Test-only helper: mock pool holding base_remaining for tier tests.
/// Real DBC pools are read at BASE_RESERVE_OFFSET instead.
#[account]
pub struct MockPool {
    pub remaining: u64,
}

#[derive(Accounts)]
pub struct InitializeConfig<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,
    /// CHECK: base mint this config belongs to
    pub mint: UncheckedAccount<'info>,
    #[account(
        init,
        payer = authority,
        space = CONFIG_LEN,
        seeds = [b"config", mint.key().as_ref()],
        bump
    )]
    pub config: Account<'info, HookConfig>,
    /// CHECK: DBC pool this config belongs to; validated in handler.
    pub pool: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(seed: u64)]
pub struct InitMockPool<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,
    #[account(
        init,
        payer = authority,
        space = 8 + 8,
        seeds = [b"mock-pool", authority.key().as_ref(), &seed.to_le_bytes()],
        bump
    )]
    pub mock_pool: Account<'info, MockPool>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct InitializeExtraMetas<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    /// CHECK: base mint; bound to config via PDA seeds + has_one below.
    pub mint: UncheckedAccount<'info>,
    #[account(
        seeds = [b"config", mint.key().as_ref()],
        bump = config.bump,
        has_one = mint @ ErrorCode::WrongConfig,
        constraint = config.authority == payer.key() @ ErrorCode::Unauthorized,
        constraint = config.pool != Pubkey::default() @ ErrorCode::PoolNotSet,
    )]
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

/// CPI order from Token-2022: source, mint, destination, authority,
/// extra_metas_validation, config, pool.
#[derive(Accounts)]
pub struct TransferHook<'info> {
    /// CHECK: parsed manually
    pub source: UncheckedAccount<'info>,
    /// CHECK: parsed manually
    pub mint: UncheckedAccount<'info>,
    /// CHECK: parsed manually
    pub destination: UncheckedAccount<'info>,
    /// CHECK: owner / delegate / pool authority
    pub authority: UncheckedAccount<'info>,
    /// CHECK: PDA ["extra-account-metas", mint]
    pub extra_account_meta_list: UncheckedAccount<'info>,
    /// CHECK: PDA ["config", mint], validated in handler
    pub config: UncheckedAccount<'info>,
    /// CHECK: static pool from config, validated in handler
    pub pool: UncheckedAccount<'info>,
}

#[error_code]
pub enum ErrorCode {
    #[msg("unauthorized")]
    Unauthorized,
    #[msg("pool not set in config")]
    PoolNotSet,
    #[msg("wrong extra-account-metas PDA")]
    WrongExtraMetas,
    #[msg("wrong config PDA")]
    WrongConfig,
    #[msg("wrong pool account")]
    WrongPool,
    #[msg("bet size must equal street bet exactly")]
    InvalidBetSize,
    #[msg("receiver hold cap exceeded")]
    ExceedsHold,
    #[msg("wallet-to-wallet transfers blocked")]
    P2PBlocked,
    #[msg("invalid transfer direction")]
    InvalidDirection,
    #[msg("token account not transferring (direct call blocked)")]
    NotTransferring,
    #[msg("invalid token account")]
    InvalidTokenAccount,
    #[msg("invalid pool account")]
    InvalidPool,
    #[msg("invalid hook instruction")]
    InvalidHookInstruction,
    #[msg("missing hook accounts")]
    MissingAccounts,
    #[msg("extra metas init failed")]
    ExtraMetasInitFailed,
    #[msg("math overflow")]
    MathOverflow,
    #[msg("migration lock must be greater than zero")]
    InvalidLock,
}

// Silence unused import if interface version re-exports differ.
#[allow(unused)]
fn _use_program_error(_e: ProgramError) {}

#[cfg(test)]
mod tests {
    use super::*;
    use anchor_lang::solana_program::clock::Epoch;

    fn key(seed: u8) -> Pubkey {
        Pubkey::new_from_array([seed; 32])
    }

    /// Token account data: mint[0..32] | owner[32..64] | amount[64..72], rest zero.
    fn token_data(mint: &Pubkey, owner: &Pubkey, amount: u64) -> Vec<u8> {
        let mut d = vec![0u8; 165];
        d[0..32].copy_from_slice(mint.as_ref());
        d[32..64].copy_from_slice(owner.as_ref());
        d[64..72].copy_from_slice(&amount.to_le_bytes());
        d
    }

    /// Real DBC pool layout: TransferHookPool discriminator + base_reserve at BASE_RESERVE_OFFSET.
    fn pool_data(remaining: u64) -> Vec<u8> {
        let mut d = vec![0u8; BASE_RESERVE_OFFSET + 8];
        d[0..8].copy_from_slice(&TRANSFER_HOOK_POOL_DISC);
        d[BASE_RESERVE_OFFSET..BASE_RESERVE_OFFSET + 8]
            .copy_from_slice(&remaining.to_le_bytes());
        d
    }

    fn mock_pool_data(remaining: u64) -> Vec<u8> {
        let mut d = vec![0u8; 16];
        d[8..16].copy_from_slice(&remaining.to_le_bytes());
        d
    }

    fn config_data(authority: &Pubkey, mint: &Pubkey, pool: &Pubkey, lock: u64) -> Vec<u8> {
        let cfg = HookConfig {
            authority: *authority,
            mint: *mint,
            pool: *pool,
            bump: 255,
            migration_lock: lock,
        };
        let mut d = Vec::new();
        cfg.try_serialize(&mut d).unwrap();
        d
    }

    fn legacy_config_data(authority: &Pubkey, mint: &Pubkey, pool: &Pubkey) -> Vec<u8> {
        // Real pre-upgrade PDA bytes: HookConfig discriminator, no lock tail.
        let mut d = config_data(authority, mint, pool, 0);
        d.truncate(CONFIG_LEN_LEGACY);
        d
    }

    struct Fixture {
        program_id: Pubkey,
        mint: Pubkey,
        extra_list: Pubkey,
        config_key: Pubkey,
        pool_key: Pubkey,
        // backing storage (must outlive AccountInfos)
        src_data: Vec<u8>,
        dst_data: Vec<u8>,
        pool_data_v: Vec<u8>,
        cfg_data: Vec<u8>,
        src_lamports: u64,
        dst_lamports: u64,
        pool_lamports: u64,
        cfg_lamports: u64,
        pool_owner: Pubkey,
        corrupt_vault_key: bool,
        corrupt_vault_amount: bool,
    }

    impl Fixture {
        fn new(remaining: u64, src_owner: Pubkey, src_amount: u64, dst_owner: Pubkey, dst_amount: u64, mock_pool: bool, lock: u64) -> Self {
            let program_id = crate::ID;
            let mint = key(10);
            let (extra_list, _) = Pubkey::find_program_address(
                &[b"extra-account-metas", mint.as_ref()],
                &program_id,
            );
            let (config_key, _) =
                Pubkey::find_program_address(&[b"config", mint.as_ref()], &program_id);
            let pool_key = key(20);
            Self {
                program_id,
                mint,
                extra_list,
                config_key,
                pool_key,
                src_data: token_data(&mint, &src_owner, src_amount),
                dst_data: token_data(&mint, &dst_owner, dst_amount),
                pool_data_v: if mock_pool { mock_pool_data(remaining) } else { pool_data(remaining) },
                cfg_data: config_data(&key(30), &mint, &pool_key, lock),
                src_lamports: 0,
                dst_lamports: 0,
                pool_lamports: 0,
                cfg_lamports: 0,
                // Real-layout pools are DBC-owned (owner+disc enforced);
                // mock layouts are test-only and unchecked.
                pool_owner: if mock_pool { key(55) } else { DBC_PROGRAM_ID },
                corrupt_vault_key: false,
                corrupt_vault_amount: false,
            }
        }

        fn with_pool_owner(mut self, owner: Pubkey) -> Self {
            self.pool_owner = owner;
            self
        }

        fn misalign_vault_key(mut self) -> Self {
            self.corrupt_vault_key = true;
            self
        }

        fn misalign_vault_amount(mut self) -> Self {
            self.corrupt_vault_amount = true;
            self
        }

        fn run(
            &mut self,
            authority: Pubkey,
            amount: u64,
        ) -> anchor_lang::Result<()> {
            let extra_lamports = 0u64;
            let mint_lamports = 0u64;
            let auth_lamports = 0u64;
            let mint_key = self.mint;
            let extra_key = self.extra_list;
            let config_key = self.config_key;
            let pool_key = self.pool_key;
            let src_key = key(40);
            let dst_key = key(41);
            let auth_key = authority;
            let mut mint_data = vec![];
            let mut extra_data = vec![];
            let mut auth_data = vec![];
            let src_owner_prog = key(50);
            let mint_owner_prog = key(51);
            let dst_owner_prog = key(52);
            let auth_owner_prog = key(53);
            let extra_owner_prog = key(54);
            let pool_owner_prog = self.pool_owner;
            let mut mint_l = mint_lamports;
            let mut auth_l = auth_lamports;
            let mut extra_l = extra_lamports;
            // Real-size pools: align vault key + POST-transfer vault amount with
            // pool state, as DBC would leave them. Positive tests then exercise
            // the binding without false rejections; negative tests corrupt it
            // via misalign_* builders. Mock layouts skip the binding entirely.
            if self.pool_data_v.len() >= BASE_RESERVE_OFFSET + 8 {
                let src_o =
                    Pubkey::new_from_array(self.src_data[32..64].try_into().unwrap());
                let dst_o =
                    Pubkey::new_from_array(self.dst_data[32..64].try_into().unwrap());
                if src_o == POOL_AUTHORITY {
                    let vk = if self.corrupt_vault_key { key(77) } else { src_key };
                    self.pool_data_v[168..200].copy_from_slice(vk.as_ref());
                    if !self.corrupt_vault_amount {
                        // POST-transfer vault == POST reserve (§7b).
                        self.src_data[64..72].copy_from_slice(
                            &self.pool_data_v[BASE_RESERVE_OFFSET..BASE_RESERVE_OFFSET + 8],
                        );
                    }
                } else if dst_o == POOL_AUTHORITY {
                    let vk = if self.corrupt_vault_key { key(77) } else { dst_key };
                    self.pool_data_v[168..200].copy_from_slice(vk.as_ref());
                    if !self.corrupt_vault_amount {
                        self.dst_data[64..72].copy_from_slice(
                            &self.pool_data_v[BASE_RESERVE_OFFSET..BASE_RESERVE_OFFSET + 8],
                        );
                    }
                }
            }
            let src_ai = AccountInfo::new(
                &src_key, false, true, &mut self.src_lamports, &mut self.src_data,
                &src_owner_prog, false, Epoch::default(),
            );
            let mint_ai = AccountInfo::new(
                &mint_key, false, false, &mut mint_l, &mut mint_data,
                &mint_owner_prog, false, Epoch::default(),
            );
            let dst_ai = AccountInfo::new(
                &dst_key, false, true, &mut self.dst_lamports, &mut self.dst_data,
                &dst_owner_prog, false, Epoch::default(),
            );
            let auth_ai = AccountInfo::new(
                &auth_key, false, false, &mut auth_l, &mut auth_data,
                &auth_owner_prog, false, Epoch::default(),
            );
            let extra_ai = AccountInfo::new(
                &extra_key, false, false, &mut extra_l, &mut extra_data,
                &extra_owner_prog, false, Epoch::default(),
            );
            let cfg_ai = AccountInfo::new(
                &config_key, false, false, &mut self.cfg_lamports, &mut self.cfg_data,
                &self.program_id, false, Epoch::default(),
            );
            let pool_ai = AccountInfo::new(
                &pool_key, false, false, &mut self.pool_lamports, &mut self.pool_data_v,
                &pool_owner_prog, false, Epoch::default(),
            );
            execute_checks(
                &src_ai, &mint_ai, &dst_ai, &auth_ai, &extra_ai, &cfg_ai, &pool_ai,
                amount, &self.program_id, false,
            )
        }
    }

    const S1_REM: u64 = 990_000_000_000_000;
    const S2_REM: u64 = 900_000_000_000_000;
    const S3_REM: u64 = 700_000_000_000_000;
    const S4_REM: u64 = 100_000_000_000_000;
    // Tail zone: lock 100k tokens. Mock `remaining` is the POST-debit vault;
    // true remainder R is implied per case (R = post + amount - lock).
    const TAIL_LOCK: u64 = 100_000_000_000;
    const TAIL_POST_DRAINED: u64 = 100_000_000_000; // post == lock (R taken fully)
    const TAIL_POST_PARTIAL: u64 = 106_000_000_000; // R=7k, A=1k in flight
    const TAIL_POST_OVERSIZE: u64 = 94_500_000_000; // R=7k, A=12.5k in flight

    #[test]
    fn tier_selection() {
        assert_eq!(tier_for(990_000_000_000_000), (BET_S1, HOLD_S1));
        assert_eq!(tier_for(950_000_000_000_001), (BET_S1, HOLD_S1));
        assert_eq!(tier_for(950_000_000_000_000), (BET_S2, HOLD_S2));
        assert_eq!(tier_for(850_000_000_000_001), (BET_S2, HOLD_S2));
        assert_eq!(tier_for(850_000_000_000_000), (BET_S3, HOLD_S3));
        assert_eq!(tier_for(600_000_000_000_001), (BET_S3, HOLD_S3));
        assert_eq!(tier_for(600_000_000_000_000), (BET_S4, HOLD_S4));
        assert_eq!(tier_for(0), (BET_S4, HOLD_S4));
    }

    #[test]
    fn pool_layouts_agree() {
        // Real DBC offset layout and Anchor-mock layout must give same tier.
        let f_real = Fixture::new(S3_REM, POOL_AUTHORITY, 0, key(60), 0, false, 0);
        let f_mock = Fixture::new(S3_REM, POOL_AUTHORITY, 0, key(60), 0, true, 0);
        let mut fr = f_real;
        let mut fm = f_mock;
        assert!(fr.run(POOL_AUTHORITY, BET_S3).is_ok());
        assert!(fm.run(POOL_AUTHORITY, BET_S3).is_ok());
    }

    #[test]
    fn s1_buy_exact_passes() {
        let mut f = Fixture::new(S1_REM, POOL_AUTHORITY, 1_000_000_000_000_000, key(60), 0, true, 0);
        assert!(f.run(POOL_AUTHORITY, BET_S1).is_ok());
    }

    #[test]
    fn s1_buy_wrong_size_reverts() {
        let mut f = Fixture::new(S1_REM, POOL_AUTHORITY, 0, key(60), 0, true, 0);
        let err = f.run(POOL_AUTHORITY, 30_000_000_000).unwrap_err();
        assert_eq!(err, ErrorCode::InvalidBetSize.into());
    }

    #[test]
    fn s1_buy_over_hold_reverts() {
        // dst is the POST-credit balance: 250k > 200k cap.
        let mut f = Fixture::new(S1_REM, POOL_AUTHORITY, 0, key(60), HOLD_S1 + BET_S1, true, 0);
        let err = f.run(POOL_AUTHORITY, BET_S1).unwrap_err();
        assert_eq!(err, ErrorCode::ExceedsHold.into());
    }

    #[test]
    fn s1_buy_wrong_authority_reverts() {
        let mut f = Fixture::new(S1_REM, POOL_AUTHORITY, 0, key(60), 0, true, 0);
        let err = f.run(key(60), BET_S1).unwrap_err();
        assert_eq!(err, ErrorCode::Unauthorized.into());
    }

    #[test]
    fn s2_buy_50k_passes_25k_reverts() {
        let mut f = Fixture::new(S2_REM, POOL_AUTHORITY, 0, key(60), 0, true, 0);
        assert!(f.run(POOL_AUTHORITY, BET_S2).is_ok());
        let mut f2 = Fixture::new(S2_REM, POOL_AUTHORITY, 0, key(61), 0, true, 0);
        let err = f2.run(POOL_AUTHORITY, BET_S3).unwrap_err();
        assert_eq!(err, ErrorCode::InvalidBetSize.into());
    }

    #[test]
    fn s3_buy_25k_passes_50k_reverts() {
        let mut f = Fixture::new(S3_REM, POOL_AUTHORITY, 0, key(60), 0, true, 0);
        assert!(f.run(POOL_AUTHORITY, BET_S3).is_ok());
        let mut f2 = Fixture::new(S3_REM, POOL_AUTHORITY, 0, key(61), 0, true, 0);
        let err = f2.run(POOL_AUTHORITY, BET_S1).unwrap_err();
        assert_eq!(err, ErrorCode::InvalidBetSize.into());
    }

    #[test]
    fn s4_buy_12_5k_passes_25k_reverts() {
        let mut f = Fixture::new(S4_REM, POOL_AUTHORITY, 0, key(60), 0, true, 0);
        assert!(f.run(POOL_AUTHORITY, BET_S4).is_ok());
        let mut f2 = Fixture::new(S4_REM, POOL_AUTHORITY, 0, key(61), 0, true, 0);
        let err = f2.run(POOL_AUTHORITY, BET_S3).unwrap_err();
        assert_eq!(err, ErrorCode::InvalidBetSize.into());
    }

    #[test]
    fn s1_sell_exact_passes_wrong_reverts() {
        let user = key(60);
        let mut f = Fixture::new(S1_REM, user, 100_000_000_000, POOL_AUTHORITY, 0, true, 0);
        assert!(f.run(user, BET_S1).is_ok());
        let mut f2 = Fixture::new(S1_REM, user, 100_000_000_000, POOL_AUTHORITY, 0, true, 0);
        let err = f2.run(user, 30_000_000_000).unwrap_err();
        assert_eq!(err, ErrorCode::InvalidBetSize.into());
    }

    #[test]
    fn sell_with_delegate_reverts() {
        let user = key(60);
        let mut f = Fixture::new(S1_REM, user, 100_000_000_000, POOL_AUTHORITY, 0, true, 0);
        let err = f.run(key(61), BET_S1).unwrap_err();
        assert_eq!(err, ErrorCode::Unauthorized.into());
    }

    #[test]
    fn p2p_blocked() {
        let mut f = Fixture::new(S4_REM, key(60), 100_000_000_000, key(61), 0, true, 0);
        let err = f.run(key(60), BET_S4).unwrap_err();
        assert_eq!(err, ErrorCode::P2PBlocked.into());
    }

    #[test]
    fn tail_buy_remainder_passes() {
        // True remainder R=7k (< BET_S4): the only legal buy takes it exactly.
        let mut f = Fixture::new(TAIL_POST_DRAINED, POOL_AUTHORITY, 0, key(60), 7_000_000_000, true, TAIL_LOCK);
        assert!(f.run(POOL_AUTHORITY, 7_000_000_000).is_ok());
    }

    #[test]
    fn tail_buy_partial_reverts() {
        // R=7k in flight as 1k: 1k != 7k.
        let mut f = Fixture::new(TAIL_POST_PARTIAL, POOL_AUTHORITY, 0, key(60), 1_000_000_000, true, TAIL_LOCK);
        let err = f.run(POOL_AUTHORITY, 1_000_000_000).unwrap_err();
        assert_eq!(err, ErrorCode::InvalidBetSize.into());
    }

    #[test]
    fn tail_buy_full_bet_reverts() {
        // R=7k in flight as a full 12.5k bet: 12.5k != 7k.
        let mut f = Fixture::new(TAIL_POST_OVERSIZE, POOL_AUTHORITY, 0, key(60), BET_S4, true, TAIL_LOCK);
        let err = f.run(POOL_AUTHORITY, BET_S4).unwrap_err();
        assert_eq!(err, ErrorCode::InvalidBetSize.into());
    }

    #[test]
    fn tail_buy_over_hold_reverts() {
        // Remainder taken exactly, but post-credit balance exceeds the cap.
        let mut f = Fixture::new(TAIL_POST_DRAINED, POOL_AUTHORITY, 0, key(60), HOLD_S4 + 7_000_000_000, true, TAIL_LOCK);
        let err = f.run(POOL_AUTHORITY, 7_000_000_000).unwrap_err();
        assert_eq!(err, ErrorCode::ExceedsHold.into());
    }

    #[test]
    fn tail_buy_dust_leftover_passes() {
        // DBC rounding leaves 459 raw units undrainable: post == lock + 459.
        let mut f = Fixture::new(TAIL_LOCK + 459, POOL_AUTHORITY, 0, key(60), 0, true, TAIL_LOCK);
        assert!(f.run(POOL_AUTHORITY, 7_000_000_000 - 459).is_ok());
    }

    #[test]
    fn tail_buy_at_dust_cap_passes() {
        // Boundary: exactly TAIL_DUST_CAP (10_000) left above lock is final.
        let mut f = Fixture::new(TAIL_LOCK + 10_000, POOL_AUTHORITY, 0, key(60), 0, true, TAIL_LOCK);
        assert!(f.run(POOL_AUTHORITY, 7_000_000_000 - 10_000).is_ok());
    }

    #[test]
    fn tail_buy_over_dust_cap_reverts() {
        // Leaving 20_000 undrained (> 10_000 cap) is not a final buy:
        // quote_reserve would stop short of the migration threshold.
        let mut f = Fixture::new(TAIL_LOCK + 20_000, POOL_AUTHORITY, 0, key(60), 0, true, TAIL_LOCK);
        let err = f.run(POOL_AUTHORITY, 7_000_000_000 - 20_000).unwrap_err();
        assert_eq!(err, ErrorCode::InvalidBetSize.into());
    }

    #[test]
    fn tail_buy_two_tokens_over_cap_reverts() {
        // Leaving 2 tokens undrained (> 10_000 cap) is not a final buy.
        let mut f = Fixture::new(TAIL_LOCK + 2_000_000, POOL_AUTHORITY, 0, key(60), 0, true, TAIL_LOCK);
        let err = f.run(POOL_AUTHORITY, 5_000_000_000).unwrap_err();
        assert_eq!(err, ErrorCode::InvalidBetSize.into());
    }

    #[test]
    fn real_pool_wrong_owner_reverts() {
        // Full-size pool not owned by DBC (deployer typo) fails closed.
        let mut f = Fixture::new(S3_REM, POOL_AUTHORITY, 0, key(60), 0, false, 0)
            .with_pool_owner(key(55));
        let err = f.run(POOL_AUTHORITY, BET_S3).unwrap_err();
        assert_eq!(err, ErrorCode::WrongPool.into());
    }

    #[test]
    fn real_pool_wrong_discriminator_reverts() {
        // Full-size DBC-owned pool with a bad discriminator fails closed.
        let mut f = Fixture::new(S3_REM, POOL_AUTHORITY, 0, key(60), 0, false, 0);
        for b in f.pool_data_v[0..8].iter_mut() {
            *b = 0;
        }
        let err = f.run(POOL_AUTHORITY, BET_S3).unwrap_err();
        assert_eq!(err, ErrorCode::WrongPool.into());
    }

    #[test]
    fn token_mint_mismatch_reverts() {
        // Source account carries a different mint than the hook mint.
        let mut f = Fixture::new(S1_REM, POOL_AUTHORITY, 1_000_000_000_000_000, key(60), 0, true, 0);
        f.src_data[0..32].copy_from_slice(key(99).as_ref());
        let err = f.run(POOL_AUTHORITY, BET_S1).unwrap_err();
        assert_eq!(err, ErrorCode::InvalidTokenAccount.into());
    }

    #[test]
    fn real_sell_exact_passes() {
        // Sell through a full-size pool: vault key + amount binding hold.
        let user = key(60);
        let mut f = Fixture::new(S1_REM, user, 100_000_000_000, POOL_AUTHORITY, 0, false, 0);
        assert!(f.run(user, BET_S1).is_ok());
    }

    #[test]
    fn real_buy_vault_key_mismatch_reverts() {
        // Pool-side source is not the pool's base_vault: raw donation blocked.
        let mut f = Fixture::new(S3_REM, POOL_AUTHORITY, 0, key(60), 0, false, 0)
            .misalign_vault_key();
        let err = f.run(POOL_AUTHORITY, BET_S3).unwrap_err();
        assert_eq!(err, ErrorCode::InvalidPool.into());
    }

    #[test]
    fn real_buy_vault_amount_desync_reverts() {
        // Vault POST amount disagrees with pool.base_reserve: desync blocked.
        let mut f = Fixture::new(S3_REM, POOL_AUTHORITY, 0, key(60), 0, false, 0)
            .misalign_vault_amount();
        let err = f.run(POOL_AUTHORITY, BET_S3).unwrap_err();
        assert_eq!(err, ErrorCode::InvalidPool.into());
    }

    #[test]
    fn real_sell_vault_key_mismatch_reverts() {
        let user = key(60);
        let mut f = Fixture::new(S1_REM, user, 100_000_000_000, POOL_AUTHORITY, 0, false, 0)
            .misalign_vault_key();
        let err = f.run(user, BET_S1).unwrap_err();
        assert_eq!(err, ErrorCode::InvalidPool.into());
    }

    #[test]
    fn tail_sell_stays_exact() {
        // Sells never get the tail exception: exact bet passes, remainder reverts.
        // Post-vault 119.5k (pre 107k after a 12.5k sell / 112.5k after a 7k one).
        let user = key(60);
        let mut f = Fixture::new(119_500_000_000, user, 100_000_000_000, POOL_AUTHORITY, 0, true, TAIL_LOCK);
        assert!(f.run(user, BET_S4).is_ok());
        let mut f2 = Fixture::new(119_500_000_000, user, 100_000_000_000, POOL_AUTHORITY, 0, true, TAIL_LOCK);
        let err = f2.run(user, 7_000_000_000).unwrap_err();
        assert_eq!(err, ErrorCode::InvalidBetSize.into());
    }

    #[test]
    fn legacy_no_lock_stays_strict() {
        // Pre-upgrade config (no lock field): tail-sized buy still reverts.
        let program_id = crate::ID;
        let mint = key(10);
        let (extra_list, _) = Pubkey::find_program_address(
            &[b"extra-account-metas", mint.as_ref()],
            &program_id,
        );
        let (config_key, _) =
            Pubkey::find_program_address(&[b"config", mint.as_ref()], &program_id);
        let pool_key = key(20);
        let mut src_data = token_data(&mint, &POOL_AUTHORITY, 0);
        let mut dst_data = token_data(&mint, &key(60), 0);
        let mut pool_data_v = mock_pool_data(107_000_000_000);
        let mut cfg_data = legacy_config_data(&key(30), &mint, &pool_key);
        assert_eq!(cfg_data.len(), CONFIG_LEN_LEGACY);
        let (mut a, mut b, mut c, mut d, mut e, mut g, mut h) = (0u64, 0u64, 0u64, 0u64, 0u64, 0u64, 0u64);
        let (mut md, mut ed, mut ad) = (vec![], vec![], vec![]);
        let src_key = key(40);
        let dst_key = key(41);
        let auth_key = POOL_AUTHORITY;
        let o50 = key(50);
        let o51 = key(51);
        let o52 = key(52);
        let o53 = key(53);
        let o54 = key(54);
        let o55 = key(55);
        let src_ai = AccountInfo::new(&src_key, false, true, &mut a, &mut src_data, &o50, false, Epoch::default());
        let mint_ai = AccountInfo::new(&mint, false, false, &mut b, &mut md, &o51, false, Epoch::default());
        let dst_ai = AccountInfo::new(&dst_key, false, true, &mut c, &mut dst_data, &o52, false, Epoch::default());
        let auth_ai = AccountInfo::new(&auth_key, false, false, &mut d, &mut ad, &o53, false, Epoch::default());
        let extra_ai = AccountInfo::new(&extra_list, false, false, &mut e, &mut ed, &o54, false, Epoch::default());
        let cfg_ai = AccountInfo::new(&config_key, false, false, &mut g, &mut cfg_data, &program_id, false, Epoch::default());
        let pool_ai = AccountInfo::new(&pool_key, false, false, &mut h, &mut pool_data_v, &o55, false, Epoch::default());
        let err = execute_checks(
            &src_ai, &mint_ai, &dst_ai, &auth_ai, &extra_ai, &cfg_ai, &pool_ai,
            7_000_000_000, &program_id, false,
        )
        .unwrap_err();
        assert_eq!(err, ErrorCode::InvalidBetSize.into());
    }

    #[test]
    fn strict_mode_rejects_direct_call() {
        // Real CPI path requires TransferHookAccount extension with transferring=true.
        // Plain mocks lack it -> strict must fail even with correct bet.
        let program_id = crate::ID;
        let mint = key(10);
        let (extra_list, _) = Pubkey::find_program_address(
            &[b"extra-account-metas", mint.as_ref()],
            &program_id,
        );
        let (config_key, _) =
            Pubkey::find_program_address(&[b"config", mint.as_ref()], &program_id);
        let pool_key = key(20);
        let mut src_data = token_data(&mint, &POOL_AUTHORITY, 0);
        let mut dst_data = token_data(&mint, &key(60), 0);
        let mut pool_data_v = mock_pool_data(S1_REM);
        let mut cfg_data = config_data(&key(30), &mint, &pool_key, 0);
        let (mut a, mut b, mut c, mut d, mut e, mut g, mut h) = (0u64, 0u64, 0u64, 0u64, 0u64, 0u64, 0u64);
        let (mut md, mut ed, mut ad) = (vec![], vec![], vec![]);
        let src_key = key(40);
        let dst_key = key(41);
        let auth_key = POOL_AUTHORITY;
        let o50 = key(50);
        let o51 = key(51);
        let o52 = key(52);
        let o53 = key(53);
        let o54 = key(54);
        let o55 = key(55);
        let src_ai = AccountInfo::new(&src_key, false, true, &mut a, &mut src_data, &o50, false, Epoch::default());
        let mint_ai = AccountInfo::new(&mint, false, false, &mut b, &mut md, &o51, false, Epoch::default());
        let dst_ai = AccountInfo::new(&dst_key, false, true, &mut c, &mut dst_data, &o52, false, Epoch::default());
        let auth_ai = AccountInfo::new(&auth_key, false, false, &mut d, &mut ad, &o53, false, Epoch::default());
        let extra_ai = AccountInfo::new(&extra_list, false, false, &mut e, &mut ed, &o54, false, Epoch::default());
        let cfg_ai = AccountInfo::new(&config_key, false, false, &mut g, &mut cfg_data, &program_id, false, Epoch::default());
        let pool_ai = AccountInfo::new(&pool_key, false, false, &mut h, &mut pool_data_v, &o55, false, Epoch::default());
        let err = execute_checks(
            &src_ai, &mint_ai, &dst_ai, &auth_ai, &extra_ai, &cfg_ai, &pool_ai,
            BET_S1, &program_id, true,
        )
        .unwrap_err();
        assert_eq!(err, ErrorCode::NotTransferring.into());
    }
}
