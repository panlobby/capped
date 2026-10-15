// Tiny #3 buyout: ExactOut 100k (S4 street, vault 500k << 625M border) until
// buyable < bet, then tail drain. Reads pool/mint/lock from /tmp/opencode/tiny3.json.
import { Connection, Keypair, PublicKey, sendAndConfirmTransaction } from "@solana/web3.js";
import {
  DynamicBondingCurveClient,
  SwapMode,
  swapQuoteExactOut,
  getFeeMode,
  getMigrationThresholdPrice,
  CollectFeeMode,
  TradeDirection,
  deriveDbcTokenVaultAddress,
} from "@meteora-ag/dynamic-bonding-curve-sdk";
import BN from "bn.js";
import { readFileSync } from "fs";

const BET = new BN(100_000_000_000); // 100k tokens, 6 dec
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const { pool: POOL_S, mint: MINT_S, lock: LOCK_S } = JSON.parse(readFileSync("/tmp/opencode/tiny3.json", "utf8"));
  const POOL = new PublicKey(POOL_S);
  const LOCK = new BN(LOCK_S);
  const conn = new Connection("https://api.devnet.solana.com", "confirmed");
  const wallet = Keypair.fromSecretKey(
    Buffer.from(JSON.parse(readFileSync(process.env.HOME + "/.config/solana/id.json", "utf8")))
  );
  const dbc = DynamicBondingCurveClient.create(conn, "confirmed");
  const cfg: any = await dbc.state.getPoolConfig((await dbc.state.getPool(POOL) as any).config ?? (await dbc.state.getPool(POOL) as any).poolState.config);

  async function state() {
    const p: any = await dbc.state.getPool(POOL);
    const live = p.poolState ?? p;
    const vaultBal = await conn.getTokenAccountBalance(deriveDbcTokenVaultAddress(POOL, new PublicKey(MINT_S)), "confirmed");
    return { live, vault: new BN(vaultBal.value.amount), quote: live.quoteReserve };
  }
  const poolConfig = (live: any): any => ({
    poolFees: cfg.poolFees, collectFeeMode: cfg.collectFeeMode, sqrtStartPrice: cfg.sqrtStartPrice,
    migrationQuoteThreshold: cfg.migrationQuoteThreshold, curve: cfg.curve,
    migrationSqrtPrice: getMigrationThresholdPrice(cfg.migrationQuoteThreshold, cfg.sqrtStartPrice, cfg.curve),
  });
  const feeMode: any = getFeeMode(CollectFeeMode.QuoteToken, TradeDirection.QuoteToBase, false);

  // Pure local math on a passed-in snapshot: no RPC inside, so the binary
  // search below probes ~14 mids with zero extra requests (devnet 429 safety).
  function quoteOutLive(live: any, amount: BN) {
    const q: any = swapQuoteExactOut(
      { poolState: { ...live, sqrtPrice: live.sqrtPrice, quoteReserve: live.quoteReserve } } as any,
      poolConfig(live), false, amount, 200, false, live.activationPoint ?? new BN(0), false);
    return q.includedFeeInputAmount;
  }

  async function quoteOut(amount: BN) {
    const { live } = await state();
    return quoteOutLive(live, amount);
  }

  async function buyExactOut(amount: BN, label: string) {
    const cost = await quoteOut(amount);
    const maxIn = cost.mul(new BN(110)).div(new BN(100));
    const tx = await dbc.pool.swap2WithTransferHook({
      owner: wallet.publicKey, pool: POOL, swapBaseForQuote: false,
      swapMode: SwapMode.ExactOut, amountOut: amount, maximumAmountIn: maxIn, referralTokenAccount: null,
    });
    tx.feePayer = wallet.publicKey;
    const sig = await sendAndConfirmTransaction(conn, tx, [wallet], { commitment: "confirmed" });
    console.log(`${label}: OK ${sig}`);
    await sleep(2000);
    return sig;
  }

  let n = 0;
  for (;;) {
    const s = await state();
    const buyable = s.vault.sub(LOCK);
    console.log(`vault=${s.vault.toString()} buyable=${buyable.toString()} quote=${s.quote.toString()}/${cfg.migrationQuoteThreshold.toString()}`);
    if (s.quote.gte(cfg.migrationQuoteThreshold)) { console.log("GRADUATED"); break; }
    if (buyable.gte(BET)) {
      await buyExactOut(BET, `full 100k (buy #${++n})`);
    } else {
      // Tail: binary-search the largest quotable amount in
      // [max(1, buyable - TAIL_DUST_CAP), buyable] and send it once.
      // Rationale (MEDIUM-C2): shaving the full dust cap upfront leaves
      // quote ~215 lamports short and forces a nibble loop; the quoter only
      // refuses past-the-end amounts, so the max quotable (end - ~157 dust
      // on tiny curves) graduates in a single tx. Hook stays satisfied:
      // best >= buyable - 10k, so post-vault - lock <= TAIL_DUST_CAP.
      // TAIL_DUST_CAP intentionally stays 10_000 (margin over observed dust).
      const ONE = new BN(1);
      let lo = BN.max(ONE, buyable.sub(new BN(10_000)));
      let hi = buyable.clone();
      let best = new BN(0);
      while (lo.lte(hi)) {
        const mid = lo.add(hi).div(new BN(2));
        try { quoteOutLive(s.live, mid); best = mid; lo = mid.add(ONE); }
        catch { hi = mid.sub(ONE); }
      }
      if (best.isZero()) throw new Error("nothing quotable, buyable=" + buyable.toString());
      await buyExactOut(best, `tail ${best.toString()}`);
    }
    if (n > 20) throw new Error("too many iterations");
  }
}

main().catch((e) => { console.error("FAILED:", e); process.exit(1); });
