// Curve modeling: 1B/6dec, start $10k -> migrate $1M, fee 25bps flat, SOL=100$.
// Variant C streets: borders at 50M / 150M / 375M sold, buy bets 50k/50k/75k/100k.
// Walks the curve with 0.5 SOL ExactIn steps, snapshots streets, prints
// ExactIn + ExactOut matrix per street.
// Usage: bun scripts/curve-matrix.ts [w1,...,w16]  (default flat 16 ones)
import {
  buildCurveWithLiquidityWeights,
  getCurveBreakdown,
  getBaseFeeParams,
  getFeeMode,
  getSwapResultFromExactInput,
  getSwapResultFromExactOutput,
  getPriceFromSqrtPrice,
  getBaseTokenForSwap,
  getMigrationThresholdPrice,
  getPercentageSupplyOnMigration,
  BaseFeeMode,
  CollectFeeMode,
  MigrationOption,
  MigrationFeeOption,
  TokenDecimal,
  TokenType,
  TokenAuthorityOption,
  ActivationType,
  TradeDirection,
} from "@meteora-ag/dynamic-bonding-curve-sdk";
import BN from "bn.js";

const BASE_DEC = 1e6;
const LAMPORTS = 1e9;
const SOL_USD = 100;
const SUPPLY = 1_000_000_000;
const tok = (n: number) => new BN(Math.round(n * BASE_DEC).toString());
const sol = (n: number) => new BN(Math.round(n * LAMPORTS).toString());
const fmtTok = (b: BN) => (Number(b.toString()) / BASE_DEC).toLocaleString("en-US", { maximumFractionDigits: 0 });
const fmtSol = (b: BN) => (Number(b.toString()) / LAMPORTS).toFixed(4);

// NOTE: builder mcaps are in QUOTE (SOL) units. $1M @ $100/SOL = 10_000 SOL.
const INITIAL_MCAP_SOL = 100; // $10k
const MIGRATION_MCAP_SOL = 10_000; // $1M
const weights = (process.argv[2] ?? "1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1").split(",").map(Number);
if (weights.length !== 16) throw new Error("need 16 weights (builder always makes 16 segments)");
console.log(`weights=[${weights}] start=$10k migrate=$1M fee=25bps SOL=$${SOL_USD}\n`);

const cfg: any = buildCurveWithLiquidityWeights({
  token: {
    tokenType: TokenType.Token2022,
    tokenBaseDecimal: TokenDecimal.SIX,
    tokenQuoteDecimal: 9,
    tokenAuthorityOption: TokenAuthorityOption.CreatorUpdateAndMintAuthority,
    totalTokenSupply: SUPPLY,
    leftover: 1000,
  },
  fee: {
    baseFeeParams: {
      baseFeeMode: BaseFeeMode.FeeSchedulerExponential,
      feeSchedulerParam: { startingFeeBps: 25, endingFeeBps: 25, numberOfPeriod: 0, totalDuration: 0 },
    },
    dynamicFeeEnabled: false,
    collectFeeMode: CollectFeeMode.QuoteToken,
    creatorTradingFeePercentage: 0,
    poolCreationFee: 0,
    enableFirstSwapWithMinFee: false,
  },
  migration: {
    migrationOption: MigrationOption.MET_DAMM_V2,
    migrationFeeOption: MigrationFeeOption.FixedBps25,
    migrationFee: { feePercentage: 0, creatorFeePercentage: 0 },
  },
  liquidityDistribution: {
    partnerPermanentLockedLiquidityPercentage: 10,
    partnerLiquidityPercentage: 40,
    creatorPermanentLockedLiquidityPercentage: 10,
    creatorLiquidityPercentage: 40,
  },
  lockedVesting: {
    totalLockedVestingAmount: 0,
    numberOfVestingPeriod: 0,
    cliffUnlockAmount: 0,
    totalVestingDuration: 0,
    cliffDurationFromMigrationTime: 0,
  },
  activationType: ActivationType.Timestamp,
  initialMarketCap: INITIAL_MCAP_SOL,
  migrationMarketCap: MIGRATION_MCAP_SOL,
  liquidityWeights: weights,
});

const bd: any = getCurveBreakdown(cfg.migrationQuoteThreshold, cfg.sqrtStartPrice, cfg.curve);
console.log("--- breakdown (QUOTE lamports per segment; sums to threshold) ---");
bd.segmentAmounts.forEach((a: any, i: number) =>
  console.log(`  seg${i}: ${(Number(a.toString()) / LAMPORTS).toFixed(2)} SOL`)
);
const swapBase = getBaseTokenForSwap(cfg.sqrtStartPrice, bd.finalSqrtPrice, cfg.curve);
console.log(`  total buyable (walk target): ${fmtTok(swapBase)}`);
console.log(`  migration threshold: ${fmtSol(cfg.migrationQuoteThreshold)} SOL`);
console.log(`  migration quote for 1M mcap sanity: threshold should be << 10000 SOL`);

// PoolConfig shape for quote fns
const baseFee: any = getBaseFeeParams({
  baseFeeMode: BaseFeeMode.FeeSchedulerExponential,
  feeSchedulerParam: { startingFeeBps: 25, endingFeeBps: 25, numberOfPeriod: 0, totalDuration: 0 },
});
const poolConfig: any = {
  poolFees: { baseFee, dynamicFee: { initialized: 0, binStep: 0, variableFeeControl: 0 } },
  collectFeeMode: CollectFeeMode.QuoteToken,
  sqrtStartPrice: cfg.sqrtStartPrice,
  migrationQuoteThreshold: cfg.migrationQuoteThreshold,
  curve: cfg.curve,
  migrationSqrtPrice: getMigrationThresholdPrice(cfg.migrationQuoteThreshold, cfg.sqrtStartPrice, cfg.curve),
};
const feeMode: any = getFeeMode(CollectFeeMode.QuoteToken, TradeDirection.QuoteToBase, false);
const ZERO = new BN(0);
const vp = (sqrtPrice: any, quoteReserve: BN) => ({
  poolState: {
    sqrtPrice,
    baseReserve: new BN(0),
    quoteReserve,
    activationPoint: new BN(0),
    volatilityTracker: {
      lastUpdateTimestamp: new BN(0),
      sqrtPriceReference: new BN(0),
      volatilityAccumulator: new BN(0),
      volatilityReference: new BN(0),
      padding: [],
    },
  },
});

const mcapUsd = (sqrtPrice: any) => {
  const p = getPriceFromSqrtPrice(sqrtPrice, TokenDecimal.SIX, 9); // SOL per token
  return Number(p.toString()) * SUPPLY * SOL_USD;
};

// Walk
const STEP = sol(0.5);
let sqrtPrice: any = cfg.sqrtStartPrice;
let sold = new BN(0);
let quoteRes = new BN(0);
const borders = [50_000_000, 150_000_000, 375_000_000]; // tokens sold (S1/S2/S3 ends)
const TAIL_SOLD = 767_000_000; // ~99% of 775M buyable — "last bet" check
let tailSnap: { mcap: number; sqrt: any; quote: BN } | null = null;
const snaps: { soldM: number; mcap: number; sqrt: any; quote: BN }[] = [{ soldM: 0, mcap: 10000, sqrt: sqrtPrice, quote: new BN(0) }];
const segSold: string[] = [];
let segIdx = 0;
let prevSold = new BN(0);
let guard = 0;
while (quoteRes.lt(cfg.migrationQuoteThreshold) && guard++ < 200000) {
  let step = STEP;
  if (quoteRes.add(step).gt(cfg.migrationQuoteThreshold)) step = cfg.migrationQuoteThreshold.sub(quoteRes);
  if (step.lte(ZERO)) break;
  let r: any;
  try {
    r = getSwapResultFromExactInput(vp(sqrtPrice, quoteRes) as any, poolConfig, step, feeMode, TradeDirection.QuoteToBase, ZERO, false);
  } catch {
    break;
  }
  // A 1-lamport step carries a 1-lamport minimum fee (net zero) — stop, the
  // walk has converged; otherwise the loop spins on the guard.
  if (r.excludedFeeInputAmount.isZero()) break;
  sold = sold.add(r.outputAmount);
  // On-chain quote_reserve accumulates NET quote (fees go to separate
  // protocol/partner fee fields), so the walk must add excludedFeeInputAmount.
  // Using includedFee understated buyable by ~562k tokens (MEDIUM-C1).
  quoteRes = quoteRes.add(r.excludedFeeInputAmount);
  sqrtPrice = r.nextSqrtPrice;
  while (segIdx < 16 && sqrtPrice.gte(cfg.curve[segIdx].sqrtPrice)) {
    segSold.push(`seg${segIdx}=${((Number(sold.toString()) - Number(prevSold.toString())) / BASE_DEC / 1e6).toFixed(1)}M`);
    prevSold = sold.clone();
    segIdx++;
  }
  const soldTok = Number(sold.toString()) / BASE_DEC;
  if (snaps.length <= 3 && soldTok >= borders[snaps.length - 1]) {
    snaps.push({ soldM: soldTok / 1e6, mcap: mcapUsd(sqrtPrice), sqrt: sqrtPrice, quote: quoteRes.clone() });
  }
  if (!tailSnap && soldTok >= TAIL_SOLD) {
    tailSnap = { mcap: mcapUsd(sqrtPrice), sqrt: sqrtPrice, quote: quoteRes.clone() };
  }
}
console.log(`\n--- supply per segment (from walk): ${segSold.join(" ")} ---`);
console.log(`--- walk done: sold=${fmtTok(sold)} quote=${fmtSol(quoteRes)} steps=${guard} ---`);
console.log(`street borders hit at mcap: ${snaps.map((s) => `$${Math.round(s.mcap).toLocaleString()}`).join(" / ")}`);

const streets = ["S1 preflop", "S2 flop", "S3 turn", "S4 river"];
const bets = [50_000, 50_000, 75_000, 100_000];
console.log("\n--- ExactIn: tokens out for SOL in (fee+impact incl, no slippage) ---");
for (const amt of [0.05, 0.1, 0.5]) {
  const row = snaps.map((s) => {
    const r: any = getSwapResultFromExactInput(vp(s.sqrt, s.quote) as any, poolConfig, sol(amt), feeMode, TradeDirection.QuoteToBase, ZERO, false);
    return `${fmtTok(r.outputAmount)}`;
  });
  console.log(`  ${amt} SOL -> [${row.join(" | ")}]`);
}
console.log("\n--- ExactOut: SOL cost per street chip (25k min + max chip) ---");
snaps.forEach((s, i) => {
  const rMax: any = getSwapResultFromExactOutput(vp(s.sqrt, s.quote) as any, poolConfig, tok(bets[i]), feeMode, TradeDirection.QuoteToBase, ZERO, false);
  const rMin: any = getSwapResultFromExactOutput(vp(s.sqrt, s.quote) as any, poolConfig, tok(25_000), feeMode, TradeDirection.QuoteToBase, ZERO, false);
  console.log(`  ${streets[i]} max ${bets[i].toLocaleString()} tok costs ${fmtSol(rMax.includedFeeInputAmount)} SOL / min 25,000 tok costs ${fmtSol(rMin.includedFeeInputAmount)} SOL (mcap $${Math.round(s.mcap).toLocaleString()})`);
});
if (tailSnap) {
  const r: any = getSwapResultFromExactOutput(vp(tailSnap.sqrt, tailSnap.quote) as any, poolConfig, tok(100_000), feeMode, TradeDirection.QuoteToBase, ZERO, false);
  console.log(`  LAST bet 100,000 tok @99% sold costs ${fmtSol(r.includedFeeInputAmount)} SOL (mcap $${Math.round(tailSnap.mcap).toLocaleString()})`);
}
