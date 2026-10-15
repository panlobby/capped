// Spot-checks Variant C hook on devnet pool #2 (old lock, S1 street).
// 1. ExactOut 50k buy passes, balance == 50k
// 2. ExactOut 30k buy reverts InvalidBetSize
// 3. Chip sells 25k + 25k pass (new SELL_STEP logic live), balance 0
// 4. P2P transferCheckedWithTransferHook reverts P2PBlocked
import { Connection, Keypair, PublicKey, sendAndConfirmTransaction } from "@solana/web3.js";
import {
  DynamicBondingCurveClient,
  SwapMode,
  swapQuoteExactOut,
  getFeeMode,
  getMigrationThresholdPrice,
  getBaseFeeParams,
  BaseFeeMode,
  CollectFeeMode,
  TradeDirection,
} from "@meteora-ag/dynamic-bonding-curve-sdk";
import {
  getOrCreateAssociatedTokenAccount,
  getAccount,
  transferCheckedWithTransferHook,
  TOKEN_2022_PROGRAM_ID,
} from "@solana/spl-token";
import BN from "bn.js";
import { readFileSync } from "fs";

const POOL = new PublicKey("GDb8yv3CEBQpsUuthMatW5zMp9RCTiamigpCZjJfN4VZ");
const MINT = new PublicKey("JBaZd2GNaV5Fmv3UVd4s2SP4bXQ22vWoQqbZdJ4fi2Jk");
const HOOK_ID = new PublicKey("3vRrCG5RnmrpTAr91rq9NnZqKCPgaDCmpEWKRLUTdqnH");
const U = (n: number) => new BN(n).mul(new BN(1_000_000));

async function main() {
  const conn = new Connection("https://api.devnet.solana.com", "confirmed");
  const wallet = Keypair.fromSecretKey(
    Buffer.from(JSON.parse(readFileSync(process.env.HOME + "/.config/solana/id.json", "utf8")))
  );
  console.log("wallet:", wallet.publicKey.toBase58());
  const dbc = DynamicBondingCurveClient.create(conn, "confirmed");
  const poolState: any = await dbc.state.getPool(POOL);
  const live = poolState.poolState ?? poolState;
  const cfg: any = await dbc.state.getPoolConfig(live.config ?? poolState.config);
  console.log("quoteReserve:", live.quoteReserve.toString(), "threshold:", cfg.migrationQuoteThreshold.toString());

  const poolConfig: any = {
    poolFees: cfg.poolFees,
    collectFeeMode: cfg.collectFeeMode,
    sqrtStartPrice: cfg.sqrtStartPrice,
    migrationQuoteThreshold: cfg.migrationQuoteThreshold,
    curve: cfg.curve,
    migrationSqrtPrice: getMigrationThresholdPrice(cfg.migrationQuoteThreshold, cfg.sqrtStartPrice, cfg.curve),
  };
  const feeMode: any = getFeeMode(CollectFeeMode.QuoteToken, TradeDirection.QuoteToBase, false);
  const vp = (sqrtPrice: any, quoteReserve: BN) => ({
    poolState: { ...live, sqrtPrice, quoteReserve },
  });

  async function buyOut(baseTokens: number, label: string) {
    const out = U(baseTokens);
    const q: any = swapQuoteExactOut(vp(live.sqrtPrice, live.quoteReserve) as any, poolConfig, false, out, 100, false, live.activationPoint ?? new BN(0), false);
    const maxIn = q.includedFeeInputAmount.mul(new BN(105)).div(new BN(100));
    console.log(`${label}: quote cost ${(Number(q.includedFeeInputAmount.toString()) / 1e9).toFixed(6)} SOL`);
    const tx = await dbc.pool.swap2WithTransferHook({
      owner: wallet.publicKey, pool: POOL, swapBaseForQuote: false,
      swapMode: SwapMode.ExactOut, amountOut: out, maximumAmountIn: maxIn,
      referralTokenAccount: null,
    });
    tx.feePayer = wallet.publicKey;
    const sig = await sendAndConfirmTransaction(conn, tx, [wallet], { commitment: "confirmed" });
    console.log(`${label}: OK ${sig}`);
    await sleep(2000);
    return sig;
  }

  const userAta = await getOrCreateAssociatedTokenAccount(conn, wallet, MINT, wallet.publicKey, false, "confirmed", undefined, TOKEN_2022_PROGRAM_ID);
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const bal = async () => {
    for (let i = 0; i < 8; i++) {
      try {
        return Number((await getAccount(conn, userAta.address, "confirmed", TOKEN_2022_PROGRAM_ID)).amount) / 1e6;
      } catch (e) { await sleep(2500); }
    }
    throw new Error("getAccount kept failing (devnet 429)");
  };
  const bal0 = await bal();
  console.log("starting balance:", bal0, "(leftover from earlier sessions is fine)");

  // 1. exact 50k buy
  await buyOut(50_000, "buy 50k");
  console.log("balance:", await bal(), `(expect ${bal0 + 50000})`);

  // 2. wrong-size 30k buy must revert
  try {
    await buyOut(30_000, "buy 30k");
    throw new Error("FAIL: 30k buy should have reverted");
  } catch (e: any) {
    const s = e.toString();
    if (!s.includes("InvalidBetSize") && !s.includes("0x1775")) throw e;
    console.log("buy 30k reverted InvalidBetSize as expected");
  }

  // 3. chip sells 25k + 25k (ExactIn base->quote)
  for (const i of [1, 2]) {
    const tx = await dbc.pool.swap2WithTransferHook({
      owner: wallet.publicKey, pool: POOL, swapBaseForQuote: true,
      swapMode: SwapMode.ExactIn, amountIn: U(25_000), minimumAmountOut: new BN(1),
      referralTokenAccount: null,
    });
    tx.feePayer = wallet.publicKey;
    const sig = await sendAndConfirmTransaction(conn, tx, [wallet], { commitment: "confirmed" });
    console.log(`sell 25k #${i}: OK ${sig} balance=${await bal()}`);
  }
  console.log("balance:", await bal(), `(expect ${bal0})`);

  // 4. P2P blocked: buy 50k then wallet->wallet via transfer hook
  await buyOut(50_000, "buy 50k (p2p setup)");
  const other = Keypair.generate();
  const dst = await getOrCreateAssociatedTokenAccount(conn, wallet, MINT, other.publicKey, false, "confirmed", undefined, TOKEN_2022_PROGRAM_ID);
  try {
    const sig = await transferCheckedWithTransferHook(
      conn, wallet, userAta.address, MINT, dst.address, wallet.publicKey,
      BigInt(50_000_000_000), 6, [], { commitment: "confirmed" }, TOKEN_2022_PROGRAM_ID
    );
    throw new Error("FAIL: p2p should have reverted, got " + sig);
  } catch (e: any) {
    const s = e.toString();
    if (!s.includes("P2PBlocked") && !s.includes("0x1777")) throw e;
    console.log("p2p reverted P2PBlocked as expected");
  }
  // cleanup: sell the 50k back in two chips
  for (const i of [1, 2]) {
    const tx = await dbc.pool.swap2WithTransferHook({
      owner: wallet.publicKey, pool: POOL, swapBaseForQuote: true,
      swapMode: SwapMode.ExactIn, amountIn: U(25_000), minimumAmountOut: new BN(1),
      referralTokenAccount: null,
    });
    tx.feePayer = wallet.publicKey;
    await sendAndConfirmTransaction(conn, tx, [wallet], { commitment: "confirmed" });
  }
  console.log("final balance:", await bal(), `(expect ${bal0}, pre-existing leftover untouched)`);
  console.log("SPOTCHECKS PASSED");
}

main().catch((e) => { console.error("FAILED:", e); process.exit(1); });
