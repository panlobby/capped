// Variant C launch params — single source of truth for mainnet launch.
// Supply 1B / 6 decimals. DBC curve start $10k -> migrate $1M (@ $100/SOL).
// Hook streets: 50k/50k/75k/100k buys (exact), 25k chip sells (<= bet),
// holds 200k/1M/4.5M/20M, REMAIN 950M/850M/625M. 10k tx, 775M buyable.
//
// MAINNET RUNBOOK (atomic, single tx / bundle — config PDA init is first-come):
//   1. createPoolWithTransferHook (this curve + fee + migration config)
//   2. hook.initialize_config(pool, migration_lock = vault_0 - buyable_0)
//      (read vault_0 + buyable_0 off-chain at pool creation, must be bit-exact)
//   3. hook.initialize_extra_account_meta_list
//   4. verify: threshold 2,245.88 SOL, lock = 225M tokens (approx, confirm live)

import * as anchor from "@anchor-lang/core";

export const VARIANT_C_PARAMS = {
  token: {
    totalSupplyTokens: 1_000_000_000,
    baseDecimals: 6,
    quoteDecimals: 9,
    // Token-2022 with transfer hook pointing at the hook program id.
  },
  curve: {
    initialMarketCapSOL: 100, // $10k @ $100/SOL
    migrationMarketCapSOL: 10_000, // $1M @ $100/SOL
    liquidityWeights: [10, 12, 15, 19, 24, 29, 36, 45, 56, 69, 86, 106, 132, 163, 203, 251],
    expectedBuyableTokens: 775_411_323, // walk == closed form (fee-fixed); S4 = 4,004 x 100k + 11.32k tail
    expectedMigrationThresholdSOL: 2245.88,
  },
  fee: {
    startingFeeBps: 25,
    endingFeeBps: 25,
    dynamicFeeEnabled: false,
    collectFeeMode: "QuoteToken",
    creatorTradingFeePercentage: 0,
    poolCreationFee: 0,
    enableFirstSwapWithMinFee: false,
  },
  migration: {
    option: "MET_DAMM_V2",
    feeOption: "FixedBps25",
    feePercentage: 0,
    creatorFeePercentage: 0,
  },
  liquidityDistribution: {
    partnerPermanentLockedLiquidityPercentage: 10,
    partnerLiquidityPercentage: 40,
    creatorPermanentLockedLiquidityPercentage: 10,
    creatorLiquidityPercentage: 40,
  },
  hook: {
    // Base units (6 decimals): tokens * 1e6.
    bets: { s1: 50_000_000_000, s2: 50_000_000_000, s3: 75_000_000_000, s4: 100_000_000_000 },
    sellStep: 25_000_000_000,
    holds: {
      s1: 200_000_000_000,
      s2: 1_000_000_000_000,
      s3: 4_500_000_000_000,
      s4: 20_000_000_000_000,
    },
    remainMin: {
      s1: 950_000_000_000_000,
      s2: 850_000_000_000_000,
      s3: 625_000_000_000_000,
    },
    tailDustCap: 10_000,
    // migration_lock = vault_0 - buyable_0 in base units, computed off-chain
    // at pool creation from live accounts. ~224.59M tokens for Variant C
    // (closed form getBaseTokenForSwap — never a fee walk, see MEDIUM-C1).
  },
};

module.exports = async function (provider: anchor.AnchorProvider) {
  // Configure client to use the provider.
  anchor.setProvider(provider);

  // Mainnet launch is manual (atomic bundle per runbook above), not via
  // `anchor migrate`. Params live in VARIANT_C_PARAMS.
  console.log("Variant C params loaded:", JSON.stringify(VARIANT_C_PARAMS.curve));
};
