// Transparent devnet trade panel logic (chip streets).
// No backend, no Helius. Read-only state via public RPC; swaps via official
// Meteora DBC SDK; wallet signs locally (Phantom). Chip math mirrors
// programs/hook/src/lib.rs §8 (is_chip shared by buys/sells, tail drain only
// when buyable < 25k). Full rules: docs/limits-architecture.md.
import { Connection, PublicKey, Transaction } from "@solana/web3.js";
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
import {
  getAssociatedTokenAddressSync,
  createAssociatedTokenAccountInstruction,
  TOKEN_2022_PROGRAM_ID,
  getAccount,
} from "@solana/spl-token";
import BN from "bn.js";

// ---- on-chain constants (lib.rs; human copy in ui/variant-c.json) ----
const DEC = 1_000_000;
const BET = { S1: new BN(50_000_000_000), S2: new BN(50_000_000_000), S3: new BN(75_000_000_000), S4: new BN(100_000_000_000) };
const HOLD = { S1: new BN(200_000_000_000), S2: new BN(1_000_000_000_000), S3: new BN(4_500_000_000_000), S4: new BN(20_000_000_000_000) };
const REMAIN_S1_MIN = new BN("950000000000000");
const REMAIN_S2_MIN = new BN("850000000000000");
const REMAIN_S3_MIN = new BN("625000000000000");
const SUPPLY_RAW = new BN("1000000000000000"); // 1B * 1e6
const TAIL_DUST_CAP = new BN(10_000);
const SELL_STEP = new BN(25_000_000_000); // min chip; also HookConfig-free shared divisor
const CHIPS = [25_000, 50_000, 75_000, 100_000].map((t) => new BN(t * DEC));

const $ = (id) => document.getElementById(id);
const logEl = $("log");
function log(msg) {
  logEl.textContent += `[${new Date().toISOString().slice(11, 19)}] ${msg}\n`;
}
function errName(e) {
  const s = String(e?.message ?? e);
  if (s.includes("0x1775") || s.includes("6005") || s.includes("InvalidBetSize")) return "InvalidBetSize (amount must be a 25k chip up to the street max)";
  if (s.includes("0x1776") || s.includes("6006") || s.includes("ExceedsHold")) return "ExceedsHold (wallet cap reached)";
  if (s.includes("0x1777") || s.includes("6007") || s.includes("P2PBlocked")) return "P2PBlocked (wallet-to-wallet blocked, DEX only)";
  if (s.includes("InvalidPool") || s.includes("6011")) return "InvalidPool (vault/desync check)";
  if (s.includes("429") || s.includes("Too Many")) return "RPC 429 (public devnet rate limit — retry or paste custom RPC)";
  return s.slice(0, 300);
}
const fmtTok = (bn) => (Number(bn.toString()) / DEC).toLocaleString("en-US", { maximumFractionDigits: 2 });
const fmtSol = (bn) => (Number(bn.toString()) / 1e9).toFixed(6);
const scanTx = (sig) => `https://solscan.io/tx/${sig}?cluster=devnet`;

let S = null; // last live state snapshot
let walletPk = null;
let buyChip = null; // selected buy chip (BN), default = street max

function streetOf(vault) {
  if (vault.gt(REMAIN_S1_MIN)) return "S1";
  if (vault.gt(REMAIN_S2_MIN)) return "S2";
  if (vault.gt(REMAIN_S3_MIN)) return "S3";
  return "S4";
}
function chipsOf(street) {
  return CHIPS.filter((c) => c.lte(BET[street])).map((c) => Number(c.toString()) / DEC);
}

function cfgOf() {
  return {
    rpc: $("rpc").value.trim(),
    pool: new PublicKey($("pool").value.trim()),
    mint: new PublicKey($("mint").value.trim()),
    hook: new PublicKey($("hook").value.trim()),
  };
}

// Read-only: pool + config + vault + hook lock. No wallet needed.
async function refreshState() {
  const { rpc, pool, mint, hook } = cfgOf();
  $("state-status").textContent = "loading…";
  const conn = new Connection(rpc, "confirmed");
  const dbc = DynamicBondingCurveClient.create(conn, "confirmed");
  const p = await dbc.state.getPool(pool);
  const live = p.poolState ?? p;
  const cfg = await dbc.state.getPoolConfig(live.config ?? p.config);
  const vaultAddr = deriveDbcTokenVaultAddress(pool, mint);
  const vaultBal = await conn.getTokenAccountBalance(vaultAddr, "confirmed");
  const vault = new BN(vaultBal.value.amount);
  // Hook lock from config PDA ["config", mint]; legacy (105B) => lock 0.
  // No Buffer in browsers: seeds via TextEncoder, u64 LE via DataView.
  let lock = new BN(0);
  try {
    const [configPda] = PublicKey.findProgramAddressSync([new TextEncoder().encode("config"), mint.toBuffer()], hook);
    const acc = await conn.getAccountInfo(configPda, "confirmed");
    if (acc && acc.data.length >= 113) {
      const dv = new DataView(acc.data.buffer, acc.data.byteOffset + 105, 8);
      lock = new BN(dv.getBigUint64(0, true).toString());
    }
    S = { ...S, configPda: configPda.toBase58() };
  } catch (e) { log("lock read failed, using 0: " + errName(e)); }
  const street = streetOf(vault);
  const bet = BET[street], hold = HOLD[street];
  const buyable = vault.sub(lock);
  const sold = SUPPLY_RAW.sub(vault);
  S = { conn, dbc, live, cfg, vault, lock, street, bet, hold, buyable, sold, ...S };
  // Default buy chip = street max (largest fitting chip).
  buyChip = bet.clone();
  const thr = cfg.migrationQuoteThreshold;
  const tailState = !lock.gt(new BN(0)) || buyable.gte(bet) ? "no"
    : buyable.gte(SELL_STEP) ? `fitting chips only (≤ ${fmtTok(buyable)}) — drain unlocks below 25k buyable`
    : "DRAIN — no chip fits, next buy must take (almost) all above lock";
  const rows = [
    ["street", `${street} (chips ${chipsOf(street).join(" | ")} / hold ${fmtTok(hold)})`],
    ["vault / sold", `${fmtTok(vault)} / ${fmtTok(sold)} tokens`],
    ["buyable (vault-lock)", `${fmtTok(buyable)} tokens`],
    ["quote / threshold", `${fmtSol(live.quoteReserve)} / ${fmtSol(thr)} SOL (${(Number(live.quoteReserve.toString()) / Number(thr.toString()) * 100).toFixed(4)}%)`],
    ["tail zone?", tailState],
    ["migrated", String(live.isMigrated?.toString?.() ?? live.isMigrated ?? "?")],
    ["hook config", S.configPda ?? "?"],
  ];
  $("state-table").innerHTML = rows.map(([k, v]) => `<tr><td>${k}</td><td>${v}</td></tr>`).join("");
  $("state-status").textContent = "ok";
  log(`state: ${street} vault=${fmtTok(vault)} sold=${fmtTok(sold)} quote=${fmtSol(live.quoteReserve)} SOL`);
  renderBuyBtns();
  renderSellBtns();
  if (walletPk) await refreshWallet();
}

function poolConfigFor(live, cfg) {
  return {
    poolFees: cfg.poolFees,
    collectFeeMode: cfg.collectFeeMode,
    sqrtStartPrice: cfg.sqrtStartPrice,
    migrationQuoteThreshold: cfg.migrationQuoteThreshold,
    curve: cfg.curve,
    migrationSqrtPrice: getMigrationThresholdPrice(cfg.migrationQuoteThreshold, cfg.sqrtStartPrice, cfg.curve),
  };
}
function quoteExactOut(live, cfg, amountOut) {
  const feeMode = getFeeMode(CollectFeeMode.QuoteToken, TradeDirection.QuoteToBase, false);
  void feeMode;
  return swapQuoteExactOut(
    { poolState: { ...live, sqrtPrice: live.sqrtPrice, quoteReserve: live.quoteReserve } },
    poolConfigFor(live, cfg),
    false, amountOut, 100, false, live.activationPoint ?? new BN(0), false,
  );
}

// Max quotable drain in [buyable-10k, buyable] on the local snapshot (no RPC loop).
function tailBest(live, cfg, buyable) {
  const ONE = new BN(1);
  let lo = BN.max(ONE, buyable.sub(TAIL_DUST_CAP));
  let hi = buyable.clone();
  let best = new BN(0);
  while (lo.lte(hi)) {
    const mid = lo.add(hi).div(new BN(2));
    try { quoteExactOut(live, cfg, mid); best = mid; lo = mid.add(ONE); }
    catch { hi = mid.sub(ONE); }
  }
  return best;
}

async function ensureAta(conn, mint, owner) {
  const ata = getAssociatedTokenAddressSync(mint, owner, false, TOKEN_2022_PROGRAM_ID);
  try { await getAccount(conn, ata, "confirmed", TOKEN_2022_PROGRAM_ID); return ata; }
  catch {
    const ix = createAssociatedTokenAccountInstruction(owner, ata, owner, mint, TOKEN_2022_PROGRAM_ID);
    const tx = new Transaction().add(ix);
    tx.feePayer = owner;
    tx.recentBlockhash = (await conn.getLatestBlockhash("confirmed")).blockhash;
    const signed = await window.solana.signTransaction(tx);
    const sig = await conn.sendRawTransaction(signed.serialize());
    await conn.confirmTransaction(sig, "confirmed");
    log(`ATA created: ${sig} ${scanTx(sig)}`);
    return ata;
  }
}

async function sendSwap(tx) {
  tx.feePayer = walletPk;
  tx.recentBlockhash = (await S.conn.getLatestBlockhash("confirmed")).blockhash;
  const signed = await window.solana.signTransaction(tx);
  const sig = await S.conn.sendRawTransaction(signed.serialize());
  await S.conn.confirmTransaction(sig, "confirmed");
  return sig;
}

// Mirror of hook §8 buy rule: chip (25k-multiple ≤ bet) and ≤ buyable.
async function doBuy() {
  try {
    if (!S) await refreshState();
    if (!walletPk) throw new Error("connect wallet first");
    if (!buyChip) throw new Error("no chip selected");
    if (buyChip.gt(S.bet)) throw new Error("chip exceeds street max");
    if (!buyChip.mod(SELL_STEP).isZero()) throw new Error("not a 25k chip");
    if (buyChip.gt(S.buyable)) throw new Error(`chip exceeds buyable remainder (${fmtTok(S.buyable)}) — wait for drain below 25k buyable`);
    const { pool } = cfgOf();
    const slipPct = Math.max(0, Number($("slip").value || "10"));
    const q = quoteExactOut(S.live, S.cfg, buyChip);
    const maxIn = q.includedFeeInputAmount.mul(new BN(100 + slipPct)).div(new BN(100));
    log(`buy ${fmtTok(buyChip)} tokens: cost ~${fmtSol(q.includedFeeInputAmount)} SOL, max ${fmtSol(maxIn)} SOL`);
    await ensureAta(S.conn, cfgOf().mint, walletPk);
    const tx = await S.dbc.pool.swap2WithTransferHook({
      owner: walletPk, pool, swapBaseForQuote: false,
      swapMode: SwapMode.ExactOut, amountOut: buyChip, maximumAmountIn: maxIn, referralTokenAccount: null,
    });
    const sig = await sendSwap(tx);
    log(`buy OK ${sig} ${scanTx(sig)}`);
    await refreshState();
  } catch (e) { log("buy FAILED: " + errName(e)); }
}

// Final drain: only valid when no chip fits (buyable < 25k). Hook enforces
// post-vault − lock ≤ TAIL_DUST_CAP, so this graduates in one tx.
async function doDrain() {
  try {
    if (!S) await refreshState();
    if (!walletPk) throw new Error("connect wallet first");
    if (!(S.lock.gt(new BN(0)) && S.buyable.lt(S.bet))) throw new Error("not in tail zone");
    if (S.buyable.gte(SELL_STEP)) throw new Error(`chips still fit (buyable ${fmtTok(S.buyable)}) — buy fitting chips instead`);
    const { pool } = cfgOf();
    const amountOut = tailBest(S.live, S.cfg, S.buyable);
    if (amountOut.isZero()) throw new Error("nothing quotable in tail window");
    const slipPct = Math.max(0, Number($("slip").value || "10"));
    const q = quoteExactOut(S.live, S.cfg, amountOut);
    const maxIn = q.includedFeeInputAmount.mul(new BN(100 + slipPct)).div(new BN(100));
    log(`drain ${fmtTok(amountOut)} tokens: cost ~${fmtSol(q.includedFeeInputAmount)} SOL, max ${fmtSol(maxIn)} SOL`);
    await ensureAta(S.conn, cfgOf().mint, walletPk);
    const tx = await S.dbc.pool.swap2WithTransferHook({
      owner: walletPk, pool, swapBaseForQuote: false,
      swapMode: SwapMode.ExactOut, amountOut, maximumAmountIn: maxIn, referralTokenAccount: null,
    });
    const sig = await sendSwap(tx);
    log(`drain OK ${sig} ${scanTx(sig)}`);
    await refreshState();
  } catch (e) { log("drain FAILED: " + errName(e)); }
}

async function doSell(chipTokens) {
  try {
    if (!S) await refreshState();
    if (!walletPk) throw new Error("connect wallet first");
    const { pool } = cfgOf();
    const amountIn = new BN(chipTokens * DEC);
    if (amountIn.gt(S.bet)) throw new Error("chip exceeds street max");
    if (!amountIn.mod(SELL_STEP).isZero()) throw new Error("not a 25k multiple");
    await ensureAta(S.conn, cfgOf().mint, walletPk);
    const tx = await S.dbc.pool.swap2WithTransferHook({
      owner: walletPk, pool, swapBaseForQuote: true,
      swapMode: SwapMode.ExactIn, amountIn, minimumAmountOut: new BN(1), referralTokenAccount: null,
    });
    const sig = await sendSwap(tx);
    log(`sell ${fmtTok(amountIn)} OK ${sig} ${scanTx(sig)}`);
    await refreshState();
  } catch (e) { log("sell FAILED: " + errName(e)); }
}

function renderBuyBtns() {
  const el = $("buy-btns");
  el.innerHTML = "";
  if (!S) { el.textContent = "refresh state first"; return; }
  for (const chip of CHIPS) {
    if (chip.gt(S.bet)) continue;
    const t = Number(chip.toString()) / DEC;
    const fits = chip.lte(S.buyable);
    const b = document.createElement("button");
    b.textContent = `Buy ${t.toLocaleString()}`;
    b.disabled = !fits;
    if (!fits) b.title = `exceeds buyable remainder (${fmtTok(S.buyable)})`;
    if (buyChip && chip.eq(buyChip)) b.classList.add("sel");
    b.onclick = () => { buyChip = chip.clone(); renderBuyBtns(); };
    el.appendChild(b);
  }
}

function renderSellBtns() {
  const el = $("sell-btns");
  el.innerHTML = "";
  if (!S) { el.textContent = "refresh state first"; return; }
  for (const chip of CHIPS) {
    if (chip.gt(S.bet)) continue;
    const t = Number(chip.toString()) / DEC;
    const b = document.createElement("button");
    b.textContent = `Sell ${t.toLocaleString()}`;
    b.onclick = () => doSell(t);
    el.appendChild(b);
  }
}

async function refreshWallet() {
  const { mint } = cfgOf();
  const ata = getAssociatedTokenAddressSync(mint, walletPk, false, TOKEN_2022_PROGRAM_ID);
  let bal = new BN(0), sol = 0;
  try { bal = new BN((await getAccount(S.conn, ata, "confirmed", TOKEN_2022_PROGRAM_ID)).amount.toString()); } catch { /* empty */ }
  try { sol = await S.conn.getBalance(walletPk, "confirmed"); } catch { /* rpc hiccup */ }
  const headroom = S.hold.sub(bal);
  $("wallet-table").innerHTML =
    `<tr><td>owner</td><td>${walletPk.toBase58()}</td></tr>` +
    `<tr><td>SOL</td><td>${(sol / 1e9).toFixed(4)}</td></tr>` +
    `<tr><td>balance / hold</td><td>${fmtTok(bal)} / ${fmtTok(S.hold)} (headroom ${fmtTok(headroom)}${headroom.isNeg() ? " — OVER CAP, buys will revert" : ""})</td></tr>`;
}

$("btn-state").onclick = () => refreshState().catch((e) => { $("state-status").textContent = "failed"; log("state FAILED: " + errName(e)); });
$("btn-quote").onclick = async () => {
  try {
    if (!S) await refreshState();
    if (!buyChip) throw new Error("no chip selected");
    const q = quoteExactOut(S.live, S.cfg, buyChip);
    $("quote-out").textContent = `~${fmtSol(q.includedFeeInputAmount)} SOL for ${fmtTok(buyChip)} tokens`;
  } catch (e) { log("quote FAILED: " + errName(e)); }
};
$("btn-buy").onclick = () => doBuy();
$("btn-tail").onclick = () => doDrain();
$("btn-connect").onclick = async () => {
  try {
    if (!window.solana?.isPhantom) throw new Error("Phantom not found (window.solana missing)");
    const r = await window.solana.connect();
    walletPk = r.publicKey;
    $("wallet-status").textContent = "connected: " + walletPk.toBase58();
    log("wallet connected");
    if (S) await refreshWallet();
  } catch (e) { log("connect FAILED: " + errName(e)); }
};

log("panel loaded. Step 1: Refresh state (no wallet needed). Step 2 (optional): connect Phantom on devnet.");
refreshState().catch((e) => log("auto-refresh failed (RPC 429?): " + errName(e)));
