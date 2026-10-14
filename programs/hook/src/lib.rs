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
// Hold caps per street (base units): 200k / 400k / 1M / 2M
pub const HOLD_S1: u64 = 200_000_000_000;
pub const HOLD_S2: u64 = 400_000_000_000;
pub const HOLD_S3: u64 = 1_000_000_000_000;
pub const HOLD_S4: u64 = 2_000_000_000_000;
// Street thresholds in pool base_remaining (base units).
// Curve: 767.4M buyable (100k SOL / $10M migration, gentle-fib weights).
// S1 while sold < 50M, S2 < 150M, S3 < 400M, else S4 river to migrate.
pub const REMAIN_S1_MIN: u64 = 717_000_000_000_000;
pub const REMAIN_S2_MIN: u64 = 617_000_000_000_000;
pub const REMAIN_S3_MIN: u64 = 367_000_000_000_000;

/// DBC pool authority PDA (same for all Meteora DBC pools).
pub const POOL_AUTHORITY: Pubkey = pubkey!("FhVo3mqL8PW5pH5U2CN4XE33DokiyZnUwuGpH2hmHLuM");
/// Offset of `base_reserve: u64` in VirtualPool / TransferHookPool account data:
/// 8 (disc) + 64 (VolatilityTracker) + 160 (5x Pubkey) = 232.
pub const BASE_RESERVE_OFFSET: usize = 232;

#[program]
pub mod hook {
    use super::*;

    /// Create config PDA ["config", mint]. Pool can be updated later via set_pool.
    pub fn initialize_config(ctx: Context<InitializeConfig>, pool: Pubkey) -> Result<()> {
        let config = &mut ctx.accounts.config;
        config.authority = ctx.accounts.authority.key();
        config.mint = ctx.accounts.mint.key();
        config.pool = pool;
        config.bump = ctx.bumps.config;
        msg!("config init mint={} pool={}", config.mint, config.pool);
        Ok(())
    }

    /// Update static pool address (authority only). Re-run init_extra_metas after.
    pub fn set_pool(ctx: Context<SetPool>, pool: Pubkey) -> Result<()> {
        require_keys_eq!(ctx.accounts.authority.key(), ctx.accounts.config.authority, ErrorCode::Unauthorized);
        ctx.accounts.config.pool = pool;
        msg!("pool set {}", pool);
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
    let config: HookConfig = HookConfig::try_deserialize(&mut &config_ai.data.borrow()[..])
        .map_err(|_| ErrorCode::WrongConfig)?;
    require_keys_eq!(config.mint, mint.key(), ErrorCode::WrongConfig);
    // 3. Pool must be the static pool from config.
    require_keys_eq!(pool_ai.key(), config.pool, ErrorCode::WrongPool);
    require!(config.pool != Pubkey::default(), ErrorCode::PoolNotSet);

    // 4. Parse token accounts (owner + pre-transfer amount).
    let (src_owner, _src_amount) = parse_token_account(source)?;
    let (dst_owner, dst_amount) = parse_token_account(destination)?;

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

    // 7. Tier from pool base_remaining.
    let remaining = read_base_reserve(pool_ai)?;
    let (bet, hold) = tier_for(remaining);

    // 8. Exact bet both directions; hold cap on buys.
    require!(amount > 0 && amount == bet, ErrorCode::InvalidBetSize);
    if src_is_pool {
        // Buy: vault -> user. Authority must be pool authority (DBC signs).
        require_keys_eq!(authority.key(), POOL_AUTHORITY, ErrorCode::Unauthorized);
        let new_balance = dst_amount.checked_add(amount).ok_or(ErrorCode::MathOverflow)?;
        require!(new_balance <= hold, ErrorCode::ExceedsHold);
    } else {
        // Sell: user -> vault. Authority must own source (no delegates).
        require_keys_eq!(authority.key(), src_owner, ErrorCode::Unauthorized);
    }
    msg!("street ok remaining={} bet={} hold={}", remaining, bet, hold);
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

/// Token-2022 base account: owner at [32..64], amount u64 LE at [64..72].
fn parse_token_account(ai: &AccountInfo) -> Result<(Pubkey, u64)> {
    let data = ai.data.borrow();
    require!(data.len() >= 72, ErrorCode::InvalidTokenAccount);
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
        space = 8 + 32 + 32 + 32 + 1,
        seeds = [b"config", mint.key().as_ref()],
        bump
    )]
    pub config: Account<'info, HookConfig>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct SetPool<'info> {
    pub authority: Signer<'info>,
    #[account(mut, has_one = authority)]
    pub config: Account<'info, HookConfig>,
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
    fn token_data(owner: &Pubkey, amount: u64) -> Vec<u8> {
        let mut d = vec![0u8; 165];
        d[32..64].copy_from_slice(owner.as_ref());
        d[64..72].copy_from_slice(&amount.to_le_bytes());
        d
    }

    /// Real DBC pool layout: base_reserve at BASE_RESERVE_OFFSET.
    fn pool_data(remaining: u64) -> Vec<u8> {
        let mut d = vec![0u8; BASE_RESERVE_OFFSET + 8];
        d[BASE_RESERVE_OFFSET..BASE_RESERVE_OFFSET + 8]
            .copy_from_slice(&remaining.to_le_bytes());
        d
    }

    fn mock_pool_data(remaining: u64) -> Vec<u8> {
        let mut d = vec![0u8; 16];
        d[8..16].copy_from_slice(&remaining.to_le_bytes());
        d
    }

    fn config_data(authority: &Pubkey, mint: &Pubkey, pool: &Pubkey) -> Vec<u8> {
        let cfg = HookConfig {
            authority: *authority,
            mint: *mint,
            pool: *pool,
            bump: 255,
        };
        let mut d = Vec::new();
        cfg.try_serialize(&mut d).unwrap();
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
    }

    impl Fixture {
        fn new(remaining: u64, src_owner: Pubkey, src_amount: u64, dst_owner: Pubkey, dst_amount: u64, mock_pool: bool) -> Self {
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
                src_data: token_data(&src_owner, src_amount),
                dst_data: token_data(&dst_owner, dst_amount),
                pool_data_v: if mock_pool { mock_pool_data(remaining) } else { pool_data(remaining) },
                cfg_data: config_data(&key(30), &mint, &pool_key),
                src_lamports: 0,
                dst_lamports: 0,
                pool_lamports: 0,
                cfg_lamports: 0,
            }
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
            let pool_owner_prog = key(55);
            let mut mint_l = mint_lamports;
            let mut auth_l = auth_lamports;
            let mut extra_l = extra_lamports;
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

    const S1_REM: u64 = 760_000_000_000_000;
    const S2_REM: u64 = 650_000_000_000_000;
    const S3_REM: u64 = 500_000_000_000_000;
    const S4_REM: u64 = 100_000_000_000_000;

    #[test]
    fn tier_selection() {
        assert_eq!(tier_for(767_000_000_000_000), (BET_S1, HOLD_S1));
        assert_eq!(tier_for(717_000_000_000_001), (BET_S1, HOLD_S1));
        assert_eq!(tier_for(717_000_000_000_000), (BET_S2, HOLD_S2));
        assert_eq!(tier_for(617_000_000_000_001), (BET_S2, HOLD_S2));
        assert_eq!(tier_for(617_000_000_000_000), (BET_S3, HOLD_S3));
        assert_eq!(tier_for(367_000_000_000_001), (BET_S3, HOLD_S3));
        assert_eq!(tier_for(367_000_000_000_000), (BET_S4, HOLD_S4));
        assert_eq!(tier_for(0), (BET_S4, HOLD_S4));
    }

    #[test]
    fn pool_layouts_agree() {
        // Real DBC offset layout and Anchor-mock layout must give same tier.
        let f_real = Fixture::new(S3_REM, POOL_AUTHORITY, 0, key(60), 0, false);
        let f_mock = Fixture::new(S3_REM, POOL_AUTHORITY, 0, key(60), 0, true);
        let mut fr = f_real;
        let mut fm = f_mock;
        assert!(fr.run(POOL_AUTHORITY, BET_S3).is_ok());
        assert!(fm.run(POOL_AUTHORITY, BET_S3).is_ok());
    }

    #[test]
    fn s1_buy_exact_passes() {
        let mut f = Fixture::new(S1_REM, POOL_AUTHORITY, 1_000_000_000_000_000, key(60), 0, true);
        assert!(f.run(POOL_AUTHORITY, BET_S1).is_ok());
    }

    #[test]
    fn s1_buy_wrong_size_reverts() {
        let mut f = Fixture::new(S1_REM, POOL_AUTHORITY, 0, key(60), 0, true);
        let err = f.run(POOL_AUTHORITY, 30_000_000_000).unwrap_err();
        assert_eq!(err, ErrorCode::InvalidBetSize.into());
    }

    #[test]
    fn s1_buy_over_hold_reverts() {
        let mut f = Fixture::new(S1_REM, POOL_AUTHORITY, 0, key(60), HOLD_S1, true);
        let err = f.run(POOL_AUTHORITY, BET_S1).unwrap_err();
        assert_eq!(err, ErrorCode::ExceedsHold.into());
    }

    #[test]
    fn s1_buy_wrong_authority_reverts() {
        let mut f = Fixture::new(S1_REM, POOL_AUTHORITY, 0, key(60), 0, true);
        let err = f.run(key(60), BET_S1).unwrap_err();
        assert_eq!(err, ErrorCode::Unauthorized.into());
    }

    #[test]
    fn s2_buy_50k_passes_25k_reverts() {
        let mut f = Fixture::new(S2_REM, POOL_AUTHORITY, 0, key(60), 0, true);
        assert!(f.run(POOL_AUTHORITY, BET_S2).is_ok());
        let mut f2 = Fixture::new(S2_REM, POOL_AUTHORITY, 0, key(61), 0, true);
        let err = f2.run(POOL_AUTHORITY, BET_S3).unwrap_err();
        assert_eq!(err, ErrorCode::InvalidBetSize.into());
    }

    #[test]
    fn s3_buy_25k_passes_50k_reverts() {
        let mut f = Fixture::new(S3_REM, POOL_AUTHORITY, 0, key(60), 0, true);
        assert!(f.run(POOL_AUTHORITY, BET_S3).is_ok());
        let mut f2 = Fixture::new(S3_REM, POOL_AUTHORITY, 0, key(61), 0, true);
        let err = f2.run(POOL_AUTHORITY, BET_S1).unwrap_err();
        assert_eq!(err, ErrorCode::InvalidBetSize.into());
    }

    #[test]
    fn s4_buy_12_5k_passes_25k_reverts() {
        let mut f = Fixture::new(S4_REM, POOL_AUTHORITY, 0, key(60), 0, true);
        assert!(f.run(POOL_AUTHORITY, BET_S4).is_ok());
        let mut f2 = Fixture::new(S4_REM, POOL_AUTHORITY, 0, key(61), 0, true);
        let err = f2.run(POOL_AUTHORITY, BET_S3).unwrap_err();
        assert_eq!(err, ErrorCode::InvalidBetSize.into());
    }

    #[test]
    fn s1_sell_exact_passes_wrong_reverts() {
        let user = key(60);
        let mut f = Fixture::new(S1_REM, user, 100_000_000_000, POOL_AUTHORITY, 0, true);
        assert!(f.run(user, BET_S1).is_ok());
        let mut f2 = Fixture::new(S1_REM, user, 100_000_000_000, POOL_AUTHORITY, 0, true);
        let err = f2.run(user, 30_000_000_000).unwrap_err();
        assert_eq!(err, ErrorCode::InvalidBetSize.into());
    }

    #[test]
    fn sell_with_delegate_reverts() {
        let user = key(60);
        let mut f = Fixture::new(S1_REM, user, 100_000_000_000, POOL_AUTHORITY, 0, true);
        let err = f.run(key(61), BET_S1).unwrap_err();
        assert_eq!(err, ErrorCode::Unauthorized.into());
    }

    #[test]
    fn p2p_blocked() {
        let mut f = Fixture::new(S4_REM, key(60), 100_000_000_000, key(61), 0, true);
        let err = f.run(key(60), BET_S4).unwrap_err();
        assert_eq!(err, ErrorCode::P2PBlocked.into());
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
        let mut src_data = token_data(&POOL_AUTHORITY, 0);
        let mut dst_data = token_data(&key(60), 0);
        let mut pool_data_v = mock_pool_data(S1_REM);
        let mut cfg_data = config_data(&key(30), &mint, &pool_key);
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
