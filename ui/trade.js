// Transparent static trade panel logic (chip streets).
// No backend, no Helius. Read-only state via public RPC; swaps via official
// Meteora DBC SDK; wallet signs locally (Phantom). Chip math mirrors
// programs/hook/src/lib.rs §8 (is_chip shared by buys/sells, tail drain only
// when buyable < 25k). Full rules: docs/limits-architecture.md.
import { Connection, PublicKey, Transaction } from "@solana/web3.js";
import {
  DynamicBondingCurveClient,
  SwapMode,
  swapQuoteExactOut,
  swapQuoteExactIn,
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

// ---- on-chain constants (lib.rs; human copy in ui/params.json) ----
const DEC = 1_000_000;
const BET = { S1: new BN(50_000_000_000), S2: new BN(50_000_000_000), S3: new BN(75_000_000_000), S4: new BN(100_000_000_000) };
const HOLD = { S1: new BN(200_000_000_000), S2: new BN(1_000_000_000_000), S3: new BN(4_500_000_000_000), S4: new BN(20_000_000_000_000) };
const STREET_NAMES = { S1: "S1 Preflop", S2: "S2 Flop", S3: "S3 Turn", S4: "S4 River" };
const STREET_ORDER = ["S1", "S2", "S3", "S4"];
const CHIP_UNLOCK_STREET = { 25000: "S1", 50000: "S1", 75000: "S3", 100000: "S4" };
const REMAIN_S1_MIN = new BN("950000000000000");
const REMAIN_S2_MIN = new BN("850000000000000");
const REMAIN_S3_MIN = new BN("625000000000000");
const SUPPLY_RAW = new BN("1000000000000000"); // 1B * 1e6
const DEFAULT_BUYABLE_RAW = new BN("775411323000000");
const TAIL_DUST_CAP = new BN(10_000);
const SELL_STEP = new BN(25_000_000_000); // min chip; also HookConfig-free shared divisor
const CHIPS = [25_000, 50_000, 75_000, 100_000].map((t) => new BN(t * DEC));

const PRESETS = {
  devnet: {
    rpc: "https://api.devnet.solana.com",
    pool: "GDb8yv3CEBQpsUuthMatW5zMp9RCTiamigpCZjJfN4VZ",
    mint: "JBaZd2GNaV5Fmv3UVd4s2SP4bXQ22vWoQqbZdJ4fi2Jk",
    hook: "3vRrCG5RnmrpTAr91rq9NnZqKCPgaDCmpEWKRLUTdqnH",
  },
  mainnet: {
    rpc: "https://solana-rpc.publicnode.com",
    pool: "7Bng3rv1XdWQvW4VHXuSr4gZJqdjgRD16DNyQJeciNkL",
    mint: "CAPU3xPH4a435pnba47uwDM7o94Dy2F5psWimCGPpMBE",
    hook: "3vRrCG5RnmrpTAr91rq9NnZqKCPgaDCmpEWKRLUTdqnH",
  },
};

const $ = (id) => document.getElementById(id);
const logEl = $("log");

let currentCluster = "mainnet";
let S = null; // last live state snapshot
let walletPk = null;
let walletBal = null; // BN token balance when connected
let buyChip = new BN(50_000 * DEC);
let sellChip = new BN(25_000 * DEC);

function shortPk(s) {
  const str = String(s || "");
  if (str.length <= 10) return str || "—";
  return `${str.slice(0, 4)}…${str.slice(-4)}`;
}

function clusterQuery() {
  return currentCluster === "devnet" ? "?cluster=devnet" : "";
}

function scanTx(sig) {
  return `https://solscan.io/tx/${sig}${clusterQuery()}`;
}

function scanAccount(addr) {
  return `https://solscan.io/account/${addr}${clusterQuery()}`;
}

function scanToken(addr) {
  return `https://solscan.io/token/${addr}${clusterQuery()}`;
}

function log(msg) {
  const ts = new Date().toISOString().slice(11, 19);
  const line = document.createElement("div");
  const urlMatch = msg.match(/(https:\/\/solscan\.io\/\S+)/);
  if (urlMatch) {
    const [fullUrl] = urlMatch;
    const [before, after] = msg.split(fullUrl);
    line.append(`[${ts}] ${before}`);
    const a = document.createElement("a");
    a.href = fullUrl;
    a.target = "_blank";
    a.rel = "noopener";
    a.textContent = "View on Solscan ↗";
    line.appendChild(a);
    if (after) line.append(after);
  } else {
    line.textContent = `[${ts}] ${msg}`;
  }
  logEl.appendChild(line);
  logEl.scrollTop = logEl.scrollHeight;
}

function setStatus(state, text) {
  $("state-status").textContent = text;
  const dot = $("state-dot");
  dot.className = "status-dot " + (state === "ok" ? "ok" : state === "busy" ? "busy" : state === "err" ? "err" : "");
}

function errName(e) {
  const s = String(e?.message ?? e);
  if (s.includes("0x1775") || s.includes("6005") || s.includes("InvalidBetSize")) return "InvalidBetSize (amount must be a 25k chip up to the street max)";
  if (s.includes("0x1776") || s.includes("6006") || s.includes("ExceedsHold")) return "ExceedsHold (wallet hold cap reached for this street)";
  if (s.includes("0x1777") || s.includes("6007") || s.includes("P2PBlocked")) return "P2PBlocked (wallet-to-wallet blocked, DEX only)";
  if (s.includes("InvalidPool") || s.includes("6011")) return "InvalidPool (vault/desync check)";
  if (s.includes("429") || s.includes("Too Many")) return "RPC 429 (public rate limit — retry or paste custom RPC in Configure)";
  return s.slice(0, 300);
}

const fmtTok = (bn) => (Number(bn.toString()) / DEC).toLocaleString("en-US", { maximumFractionDigits: 2 });
const fmtSol = (bn) => (Number(bn.toString()) / 1e9).toFixed(6);

function streetOf(vault) {
  if (vault.gt(REMAIN_S1_MIN)) return "S1";
  if (vault.gt(REMAIN_S2_MIN)) return "S2";
  if (vault.gt(REMAIN_S3_MIN)) return "S3";
  return "S4";
}

function chipsOf(street) {
  return CHIPS.filter((c) => c.lte(BET[street])).map((c) => `${Number(c.toString()) / DEC / 1000}k`);
}

function cfgOf() {
  const rpc = $("rpc").value.trim();
  const poolStr = $("pool").value.trim();
  const mintStr = $("mint").value.trim();
  const hookStr = $("hook").value.trim();
  if (!poolStr || !mintStr) {
    throw new Error(`Pool and Mint addresses are required (${currentCluster})`);
  }
  return {
    rpc,
    pool: new PublicKey(poolStr),
    mint: new PublicKey(mintStr),
    hook: new PublicKey(hookStr),
  };
}

function updateExplorerLinks() {
  const poolStr = $("pool").value.trim();
  const mintStr = $("mint").value.trim();
  $("link-scan").href = `https://solscan.io/${clusterQuery()}`;
  const poolLink = $("link-pool-short");
  const mintLink = $("link-mint-short");
  if (poolStr) {
    poolLink.textContent = shortPk(poolStr);
    poolLink.href = scanAccount(poolStr);
  } else {
    poolLink.textContent = "not set";
    poolLink.href = `https://solscan.io/${clusterQuery()}`;
  }
  if (mintStr) {
    mintLink.textContent = shortPk(mintStr);
    mintLink.href = scanToken(mintStr);
  } else {
    mintLink.textContent = "not set";
    mintLink.href = `https://solscan.io/${clusterQuery()}`;
  }
  const rpcHost = (() => {
    try { return new URL($("rpc").value.trim()).host; } catch { return "custom RPC"; }
  })();
  $("conn-summary-label").textContent = `${currentCluster} · ${rpcHost}`;
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

function quoteExactInSell(live, cfg, amountIn) {
  return swapQuoteExactIn(
    { poolState: { ...live, sqrtPrice: live.sqrtPrice, quoteReserve: live.quoteReserve } },
    poolConfigFor(live, cfg),
    true, amountIn, 100, false, live.activationPoint ?? new BN(0), false,
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

function updateStreetStepper(activeStreet) {
  const activeIdx = STREET_ORDER.indexOf(activeStreet);
  document.querySelectorAll("#street-stepper .street-step").forEach((el) => {
    const st = el.getAttribute("data-street");
    const idx = STREET_ORDER.indexOf(st);
    el.classList.toggle("active", st === activeStreet);
    el.classList.toggle("done", idx < activeIdx);
  });
}

function inDrainMode() {
  return Boolean(S && S.lock.gt(new BN(0)) && S.buyable.lt(SELL_STEP) && S.buyable.gt(new BN(0)));
}

function updateQuoteBoxes() {
  const slipPct = Math.max(0, Number($("slip").value || "10"));
  const drain = inDrainMode();

  if (drain) {
    const drainAmt = tailBest(S.live, S.cfg, S.buyable);
    $("quote-chip-label").textContent = "Final tail drain (<25k left)";
    $("quote-chip-amt").textContent = `${fmtTok(drainAmt)} tokens`;
    $("btn-buy").textContent = `Drain Final Tail & Graduate (${fmtTok(drainAmt)} tokens)`;
    if (!drainAmt.isZero()) {
      try {
        const q = quoteExactOut(S.live, S.cfg, drainAmt);
        const maxIn = q.includedFeeInputAmount.mul(new BN(100 + slipPct)).div(new BN(100));
        $("quote-out").textContent = `~${fmtSol(q.includedFeeInputAmount)} SOL`;
        $("quote-max-sol").textContent = `${fmtSol(maxIn)} SOL (${slipPct}% slip)`;
      } catch {
        $("quote-out").textContent = "unquotable";
        $("quote-max-sol").textContent = "—";
      }
    } else {
      $("quote-out").textContent = "— SOL";
      $("quote-max-sol").textContent = "— SOL";
    }
  } else if (buyChip) {
    $("quote-chip-label").textContent = "Selected buy chip";
    $("quote-chip-amt").textContent = `${fmtTok(buyChip)} tokens`;
    $("btn-buy").textContent = "Buy Selected Chip";
    if (S && buyChip.lte(S.buyable)) {
      try {
        const q = quoteExactOut(S.live, S.cfg, buyChip);
        const maxIn = q.includedFeeInputAmount.mul(new BN(100 + slipPct)).div(new BN(100));
        $("quote-out").textContent = `~${fmtSol(q.includedFeeInputAmount)} SOL`;
        $("quote-max-sol").textContent = `${fmtSol(maxIn)} SOL (${slipPct}% slip)`;
      } catch {
        $("quote-out").textContent = "unquotable";
        $("quote-max-sol").textContent = "—";
      }
    } else {
      $("quote-out").textContent = "— SOL";
      $("quote-max-sol").textContent = "— SOL";
    }
  }

  // Sell quote box
  if (sellChip) {
    $("sell-chip-amt").textContent = `${fmtTok(sellChip)} tokens`;
    if (S && S.sold.gt(new BN(0))) {
      try {
        const q = quoteExactInSell(S.live, S.cfg, sellChip);
        const minOut = q.outputAmount.mul(new BN(Math.max(0, 100 - slipPct))).div(new BN(100));
        $("sell-quote-out").textContent = `~${fmtSol(q.outputAmount)} SOL`;
        $("sell-min-sol").textContent = `${fmtSol(minOut)} SOL (${slipPct}% slip)`;
      } catch {
        $("sell-quote-out").textContent = "— SOL";
        $("sell-min-sol").textContent = "— SOL";
      }
    } else {
      $("sell-quote-out").textContent = "— SOL";
      $("sell-min-sol").textContent = "— SOL";
    }
  }
}

// Read-only: pool + config + vault + hook lock. No wallet needed.
async function refreshState() {
  updateExplorerLinks();
  const { rpc, pool, mint, hook } = cfgOf();
  setStatus("busy", "loading…");
  const conn = new Connection(rpc, "confirmed");
  const dbc = DynamicBondingCurveClient.create(conn, "confirmed");
  const p = await dbc.state.getPool(pool);
  if (!p) throw new Error("Pool account not found on this cluster");
  const live = p.poolState ?? p;
  const cfg = await dbc.state.getPoolConfig(live.config ?? p.config);
  const vaultAddr = deriveDbcTokenVaultAddress(pool, mint);
  const vaultAcc = await getAccount(conn, vaultAddr, "confirmed", TOKEN_2022_PROGRAM_ID);
  const vault = new BN(vaultAcc.amount.toString());

  // Hook lock from config PDA ["config", mint]; legacy (105B) => lock 0.
  let lock = new BN(0);
  let configPdaStr = "?";
  try {
    const [configPda] = PublicKey.findProgramAddressSync([new TextEncoder().encode("config"), mint.toBuffer()], hook);
    configPdaStr = configPda.toBase58();
    const acc = await conn.getAccountInfo(configPda, "confirmed");
    if (acc && acc.data.length >= 113) {
      const dv = new DataView(acc.data.buffer, acc.data.byteOffset + 105, 8);
      lock = new BN(dv.getBigUint64(0, true).toString());
    }
  } catch (e) {
    log("lock read failed, using 0: " + errName(e));
  }

  const street = streetOf(vault);
  const bet = BET[street], hold = HOLD[street];
  const buyable = vault.sub(lock);
  const sold = SUPPLY_RAW.sub(vault);
  const totalBuyable = lock.gt(new BN(0)) ? SUPPLY_RAW.sub(lock) : DEFAULT_BUYABLE_RAW;

  S = { conn, dbc, live, cfg, vault, lock, street, bet, hold, buyable, sold, totalBuyable, configPda: configPdaStr };

  // Keep selected chip within street max, or default to street max for buys
  if (!buyChip || buyChip.gt(bet)) buyChip = bet.clone();
  if (!sellChip || sellChip.gt(bet)) sellChip = SELL_STEP.clone();

  const thr = cfg.migrationQuoteThreshold;
  const isMigrated = Number(live.isMigrated?.toString?.() ?? live.isMigrated ?? 0) === 1;
  const inDrain = lock.gt(new BN(0)) && buyable.lt(SELL_STEP) && buyable.gt(new BN(0));
  const tailState = !lock.gt(new BN(0)) || buyable.gte(bet)
    ? "No (normal chip play)"
    : buyable.gte(SELL_STEP)
      ? `Fitting chips ≤ ${fmtTok(buyable)}`
      : "DRAIN READY (<25k left)";

  // Update visual dashboard
  updateStreetStepper(street);
  $("badge-street").textContent = STREET_NAMES[street];
  const migBadge = $("badge-migrated");
  if (isMigrated) {
    migBadge.textContent = "Graduated · Hook Revoked";
    migBadge.className = "badge badge-ok";
  } else {
    migBadge.textContent = "Curve Live · Hook Active";
    migBadge.className = "badge";
  }

  const soldPct = Math.min(100, Math.max(0, (Number(sold.toString()) / Number(totalBuyable.toString())) * 100));
  $("meter-sold-label").textContent = `${fmtTok(sold)} / ${fmtTok(totalBuyable)} (${soldPct.toFixed(2)}%)`;
  $("meter-sold-fill").style.width = `${soldPct}%`;

  const solPct = Math.min(100, Math.max(0, (Number(live.quoteReserve.toString()) / Number(thr.toString())) * 100));
  $("meter-sol-label").textContent = `${fmtSol(live.quoteReserve)} / ${fmtSol(thr)} SOL (${solPct.toFixed(3)}%)`;
  $("meter-sol-fill").style.width = `${solPct}%`;

  $("stat-chips").textContent = `${chipsOf(street).join(" | ")} tokens`;
  $("stat-hold").textContent = `${fmtTok(hold)} tokens`;
  $("stat-buyable").textContent = `${fmtTok(buyable)} tokens`;
  $("stat-tail").textContent = tailState;

  // Populate legacy state-table for compatibility
  const rows = [
    ["street", `${street} (chips ${chipsOf(street).join(" | ")} / hold ${fmtTok(hold)})`],
    ["vault / sold", `${fmtTok(vault)} / ${fmtTok(sold)} tokens`],
    ["buyable (vault-lock)", `${fmtTok(buyable)} tokens`],
    ["quote / threshold", `${fmtSol(live.quoteReserve)} / ${fmtSol(thr)} SOL (${solPct.toFixed(4)}%)`],
    ["tail zone?", tailState],
    ["migrated", String(live.isMigrated?.toString?.() ?? live.isMigrated ?? "?")],
    ["hook config", S.configPda ?? "?"],
  ];
  $("state-table").innerHTML = rows.map(([k, v]) => `<tr><td>${k}</td><td>${v}</td></tr>`).join("");

  setStatus("ok", `${street} · live`);
  log(`state synced: ${street} | sold=${fmtTok(sold)} | buyable=${fmtTok(buyable)} | reserve=${fmtSol(live.quoteReserve)} SOL`);

  if (walletPk) await refreshWallet();
  renderBuyBtns();
  renderSellBtns();
  updateQuoteBoxes();
}

async function ensureAta(conn, mint, owner) {
  const ata = getAssociatedTokenAddressSync(mint, owner, false, TOKEN_2022_PROGRAM_ID);
  try {
    await getAccount(conn, ata, "confirmed", TOKEN_2022_PROGRAM_ID);
    return ata;
  } catch {
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

async function waitSig(conn, sig) {
  for (let i = 0; i < 30; i++) {
    try {
      const { value } = await conn.getSignatureStatuses([sig]);
      const st = value?.[0];
      if (st) {
        if (st.err) throw new Error(JSON.stringify(st.err));
        if (st.confirmationStatus === "confirmed" || st.confirmationStatus === "finalized") return sig;
      }
    } catch (e) {
      if (String(e?.message ?? e).includes("InstructionError")) throw e;
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  return sig;
}

async function sendSwap(tx) {
  tx.feePayer = walletPk;
  tx.recentBlockhash = (await S.conn.getLatestBlockhash("confirmed")).blockhash;
  const signed = await window.solana.signTransaction(tx);
  const sig = await S.conn.sendRawTransaction(signed.serialize());
  await waitSig(S.conn, sig);
  return sig;
}

// Mirror of hook §8 buy rule: chip (25k-multiple ≤ bet) and ≤ buyable.
async function doBuy() {
  try {
    if (!S) await refreshState();
    if (!walletPk) throw new Error("connect Phantom wallet first");
    if (!buyChip) throw new Error("no chip selected");
    if (buyChip.gt(S.bet)) throw new Error("chip exceeds street max");
    if (!buyChip.mod(SELL_STEP).isZero()) throw new Error("not a 25k chip");
    if (buyChip.gt(S.buyable)) throw new Error(`chip exceeds buyable remainder (${fmtTok(S.buyable)}) — wait for drain below 25k buyable`);
    if (walletBal && walletBal.add(buyChip).gt(S.hold)) {
      throw new Error(`ExceedsHold: buying ${fmtTok(buyChip)} would put your bag over the ${fmtTok(S.hold)} street cap`);
    }
    const { pool } = cfgOf();
    const slipPct = Math.max(0, Number($("slip").value || "10"));
    const q = quoteExactOut(S.live, S.cfg, buyChip);
    const maxIn = q.includedFeeInputAmount.mul(new BN(100 + slipPct)).div(new BN(100));
    log(`buying ${fmtTok(buyChip)} tokens: ~${fmtSol(q.includedFeeInputAmount)} SOL (max ${fmtSol(maxIn)} SOL)…`);
    const tx = await S.dbc.pool.swap2WithTransferHook({
      owner: walletPk, pool, swapBaseForQuote: false,
      swapMode: SwapMode.ExactOut, amountOut: buyChip, maximumAmountIn: maxIn, referralTokenAccount: null,
    });
    const sig = await sendSwap(tx);
    log(`buy OK ${sig} ${scanTx(sig)}`);
    await refreshState();
  } catch (e) {
    log("buy FAILED: " + errName(e));
  }
}

// Final drain: only valid when no chip fits (buyable < 25k).
async function doDrain() {
  try {
    if (!S) await refreshState();
    if (!walletPk) throw new Error("connect Phantom wallet first");
    if (!(S.lock.gt(new BN(0)) && S.buyable.lt(S.bet))) throw new Error("not in tail zone");
    if (S.buyable.gte(SELL_STEP)) throw new Error(`chips still fit (buyable ${fmtTok(S.buyable)}) — buy fitting chips instead`);
    const { pool } = cfgOf();
    const amountOut = tailBest(S.live, S.cfg, S.buyable);
    if (amountOut.isZero()) throw new Error("nothing quotable in tail window");
    const slipPct = Math.max(0, Number($("slip").value || "10"));
    const q = quoteExactOut(S.live, S.cfg, amountOut);
    const maxIn = q.includedFeeInputAmount.mul(new BN(100 + slipPct)).div(new BN(100));
    log(`draining tail ${fmtTok(amountOut)} tokens: ~${fmtSol(q.includedFeeInputAmount)} SOL (max ${fmtSol(maxIn)} SOL)…`);
    const tx = await S.dbc.pool.swap2WithTransferHook({
      owner: walletPk, pool, swapBaseForQuote: false,
      swapMode: SwapMode.ExactOut, amountOut, maximumAmountIn: maxIn, referralTokenAccount: null,
    });
    const sig = await sendSwap(tx);
    log(`drain OK ${sig} ${scanTx(sig)}`);
    await refreshState();
  } catch (e) {
    log("drain FAILED: " + errName(e));
  }
}

async function doSell(amountInBn) {
  try {
    if (!S) await refreshState();
    if (!walletPk) throw new Error("connect Phantom wallet first");
    const amountIn = amountInBn ?? sellChip;
    if (!amountIn) throw new Error("select a sell chip first");
    if (amountIn.gt(S.bet)) throw new Error("chip exceeds street max");
    if (!amountIn.mod(SELL_STEP).isZero()) throw new Error("not a 25k multiple");
    if (walletBal && amountIn.gt(walletBal)) {
      throw new Error(`insufficient token balance (${fmtTok(walletBal)}) for ${fmtTok(amountIn)} chip`);
    }
    const { pool } = cfgOf();
    const slipPct = Math.max(0, Number($("slip").value || "10"));
    let minOut = new BN(1);
    try {
      const q = quoteExactInSell(S.live, S.cfg, amountIn);
      minOut = BN.max(new BN(1), q.outputAmount.mul(new BN(Math.max(0, 100 - slipPct))).div(new BN(100)));
    } catch { /* fallback to 1 lamport if quote unavailable */ }
    log(`selling ${fmtTok(amountIn)} tokens (min ${fmtSol(minOut)} SOL)…`);
    const tx = await S.dbc.pool.swap2WithTransferHook({
      owner: walletPk, pool, swapBaseForQuote: true,
      swapMode: SwapMode.ExactIn, amountIn, minimumAmountOut: minOut, referralTokenAccount: null,
    });
    const sig = await sendSwap(tx);
    log(`sell ${fmtTok(amountIn)} OK ${sig} ${scanTx(sig)}`);
    await refreshState();
  } catch (e) {
    log("sell FAILED: " + errName(e));
  }
}

function renderBuyBtns() {
  const el = $("buy-btns");
  el.innerHTML = "";
  for (const chip of CHIPS) {
    const t = Number(chip.toString()) / DEC;
    const unlocked = !S || chip.lte(S.bet);
    const fitsBuyable = !S || chip.lte(S.buyable);
    const fitsHold = !S || !walletBal || walletBal.add(chip).lte(S.hold);
    const enabled = unlocked && fitsBuyable && fitsHold;

    const b = document.createElement("button");
    b.type = "button";
    b.className = "chip-btn" + (buyChip && chip.eq(buyChip) && unlocked ? " sel" : "");
    b.disabled = !enabled;

    let tagText = `${t / 1000}k CHIP`;
    let quoteText = "refresh state for quote";
    if (!unlocked) {
      tagText = `UNLOCKS ${CHIP_UNLOCK_STREET[t]}`;
      quoteText = "above street max";
    } else if (!fitsBuyable) {
      tagText = "TAIL LIMIT";
      quoteText = `exceeds buyable (${fmtTok(S.buyable)})`;
    } else if (!fitsHold) {
      tagText = "HOLD CAP";
      quoteText = `exceeds ${fmtTok(S.hold)} cap`;
    } else if (S) {
      try {
        const q = quoteExactOut(S.live, S.cfg, chip);
        quoteText = `~${fmtSol(q.includedFeeInputAmount)} SOL`;
      } catch {
        quoteText = "quote unavailable";
      }
    }

    b.innerHTML =
      `<div class="chip-top">` +
      `<span class="chip-amt">+${t.toLocaleString("en-US")}</span>` +
      `<span class="chip-tag">${tagText}</span>` +
      `</div>` +
      `<div class="chip-quote">${quoteText}</div>`;

    b.onclick = () => {
      buyChip = chip.clone();
      renderBuyBtns();
      updateQuoteBoxes();
    };
    el.appendChild(b);
  }
}

function renderSellBtns() {
  const el = $("sell-btns");
  el.innerHTML = "";
  for (const chip of CHIPS) {
    const t = Number(chip.toString()) / DEC;
    const unlocked = !S || chip.lte(S.bet);
    const hasBal = !walletBal || chip.lte(walletBal);
    const enabled = unlocked && hasBal;

    const b = document.createElement("button");
    b.type = "button";
    b.className = "chip-btn" + (sellChip && chip.eq(sellChip) && unlocked ? " sel" : "");
    b.disabled = !enabled;

    let tagText = `${t / 1000}k CHIP`;
    let quoteText = "select to quote sell";
    if (!unlocked) {
      tagText = `UNLOCKS ${CHIP_UNLOCK_STREET[t]}`;
      quoteText = "above street max";
    } else if (!hasBal) {
      tagText = "LOW BAL";
      quoteText = `need ${t.toLocaleString("en-US")} tokens`;
    } else if (S && S.sold.gt(new BN(0))) {
      try {
        const q = quoteExactInSell(S.live, S.cfg, chip);
        quoteText = `~${fmtSol(q.outputAmount)} SOL`;
      } catch {
        quoteText = "pool at 0 sold";
      }
    }

    b.innerHTML =
      `<div class="chip-top">` +
      `<span class="chip-amt">−${t.toLocaleString("en-US")}</span>` +
      `<span class="chip-tag">${tagText}</span>` +
      `</div>` +
      `<div class="chip-quote">${quoteText}</div>`;

    b.onclick = () => {
      sellChip = chip.clone();
      renderSellBtns();
      updateQuoteBoxes();
    };
    el.appendChild(b);
  }
}

async function refreshWallet() {
  if (!walletPk || !S) return;
  const { mint } = cfgOf();
  const ata = getAssociatedTokenAddressSync(mint, walletPk, false, TOKEN_2022_PROGRAM_ID);
  let bal = new BN(0), sol = 0;
  try { bal = new BN((await getAccount(S.conn, ata, "confirmed", TOKEN_2022_PROGRAM_ID)).amount.toString()); } catch { /* empty ATA */ }
  try { sol = await S.conn.getBalance(walletPk, "confirmed"); } catch { /* rpc hiccup */ }
  walletBal = bal;
  const headroom = S.hold.sub(bal);
  const holdPct = Math.min(100, Math.max(0, (Number(bal.toString()) / Number(S.hold.toString())) * 100));

  $("wallet-balances").style.display = "flex";
  $("wallet-hold-box").style.display = "block";
  $("wallet-sol").textContent = `${(sol / 1e9).toFixed(4)} SOL`;
  $("wallet-tok").textContent = `${fmtTok(bal)} tokens`;
  $("wallet-hold-label").textContent = `${fmtTok(bal)} / ${fmtTok(S.hold)} (${headroom.isNeg() ? "OVER CAP" : `${fmtTok(headroom)} headroom`})`;
  $("wallet-hold-fill").style.width = `${holdPct}%`;

  $("wallet-table").innerHTML =
    `<tr><td>owner</td><td>${walletPk.toBase58()}</td></tr>` +
    `<tr><td>SOL</td><td>${(sol / 1e9).toFixed(4)}</td></tr>` +
    `<tr><td>balance / hold</td><td>${fmtTok(bal)} / ${fmtTok(S.hold)} (headroom ${fmtTok(headroom)}${headroom.isNeg() ? " — OVER CAP, buys will revert" : ""})</td></tr>`;
}

function setCluster(cluster, applyPreset = true) {
  currentCluster = cluster === "mainnet" ? "mainnet" : "devnet";
  $("cluster-devnet").classList.toggle("active", currentCluster === "devnet");
  $("cluster-mainnet").classList.toggle("active", currentCluster === "mainnet");
  if (applyPreset) {
    const p = PRESETS[currentCluster];
    $("rpc").value = p.rpc;
    $("pool").value = p.pool;
    $("mint").value = p.mint;
    $("hook").value = p.hook;
  }
  S = null;
  updateExplorerLinks();
  renderBuyBtns();
  renderSellBtns();
  if ($("pool").value.trim() && $("mint").value.trim()) {
    refreshState().catch((e) => {
      setStatus("err", "error");
      log("state FAILED: " + errName(e));
    });
  } else {
    setStatus("idle", `${currentCluster} (paste pool & mint)`);
    $("conn-details").open = true;
    log(`switched to ${currentCluster}. Paste mainnet Pool & Mint addresses in Configure to load live state.`);
  }
}

// Wire controls
$("cluster-devnet").onclick = () => setCluster("devnet", true);
$("cluster-mainnet").onclick = () => setCluster("mainnet", true);

$("btn-state").onclick = () => refreshState().catch((e) => {
  setStatus("err", "failed");
  log("state FAILED: " + errName(e));
});
$("btn-apply-conn").onclick = () => refreshState().catch((e) => {
  setStatus("err", "failed");
  log("state FAILED: " + errName(e));
});

$("btn-quote").onclick = async () => {
  try {
    if (!S) await refreshState();
    updateQuoteBoxes();
    const targetAmt = inDrainMode() ? tailBest(S.live, S.cfg, S.buyable) : buyChip;
    const q = quoteExactOut(S.live, S.cfg, targetAmt);
    log(`quote: ${fmtTok(targetAmt)} tokens costs ~${fmtSol(q.includedFeeInputAmount)} SOL`);
  } catch (e) {
    log("quote FAILED: " + errName(e));
  }
};

document.querySelectorAll(".slip-preset").forEach((btn) => {
  btn.onclick = () => {
    document.querySelectorAll(".slip-preset").forEach((b) => b.classList.remove("active"));
    btn.classList.add("active");
    $("slip").value = btn.getAttribute("data-slip");
    updateQuoteBoxes();
  };
});
$("slip").oninput = () => {
  document.querySelectorAll(".slip-preset").forEach((b) => {
    b.classList.toggle("active", b.getAttribute("data-slip") === $("slip").value.trim());
  });
  updateQuoteBoxes();
};

$("btn-buy").onclick = () => (inDrainMode() ? doDrain() : doBuy());
$("btn-sell").onclick = () => doSell(sellChip);
$("btn-clear-log").onclick = () => { logEl.innerHTML = ""; };

$("btn-copy-link").onclick = async () => {
  const u = new URL(window.location.href);
  u.searchParams.set("cluster", currentCluster);
  if ($("pool").value.trim()) u.searchParams.set("pool", $("pool").value.trim());
  if ($("mint").value.trim()) u.searchParams.set("mint", $("mint").value.trim());
  try {
    await navigator.clipboard.writeText(u.toString());
    log("shareable URL copied to clipboard");
  } catch {
    log("shareable URL: " + u.toString());
  }
};

async function disconnectWallet() {
  try { await window.solana?.disconnect?.(); } catch { /* ignore */ }
  walletPk = null;
  walletBal = null;
  $("wallet-status").textContent = "Not connected — read-only mode active";
  $("btn-connect").textContent = "Connect Phantom";
  $("btn-disconnect").style.display = "none";
  $("wallet-balances").style.display = "none";
  $("wallet-hold-box").style.display = "none";
  $("wallet-table").innerHTML = "";
  renderBuyBtns();
  renderSellBtns();
  log("wallet disconnected");
}

$("btn-connect").onclick = async () => {
  try {
    if (!window.solana?.isPhantom) throw new Error("Phantom wallet not detected (window.solana missing)");
    const r = await window.solana.connect();
    walletPk = r.publicKey;
    $("wallet-status").textContent = walletPk.toBase58();
    $("btn-connect").textContent = shortPk(walletPk.toBase58());
    $("btn-disconnect").style.display = "inline-block";
    log(`wallet connected: ${walletPk.toBase58()}`);
    if (S) {
      await refreshWallet();
      renderBuyBtns();
      renderSellBtns();
    }
  } catch (e) {
    log("connect FAILED: " + errName(e));
  }
};

$("btn-disconnect").onclick = () => disconnectWallet();
window.solana?.on?.("disconnect", () => {
  if (walletPk) disconnectWallet();
});

// Apply URL query overrides (?cluster=mainnet&pool=...&mint=...&rpc=...)
(function init() {
  const params = new URLSearchParams(window.location.search);
  const qCluster = params.get("cluster");
  if (qCluster === "mainnet" || qCluster === "devnet") {
    setCluster(qCluster, true);
  }
  if (params.get("rpc")) $("rpc").value = params.get("rpc");
  if (params.get("pool")) $("pool").value = params.get("pool");
  if (params.get("mint")) $("mint").value = params.get("mint");
  if (params.get("hook")) $("hook").value = params.get("hook");

  updateExplorerLinks();
  renderBuyBtns();
  renderSellBtns();
  updateQuoteBoxes();

  log("capped panel ready. Reading on-chain state directly via Solana RPC (no wallet required).");
  if ($("pool").value.trim() && $("mint").value.trim()) {
    refreshState().catch((e) => {
      setStatus("err", "RPC error");
      log("auto-refresh failed (RPC 429?): " + errName(e));
    });
  }
})();
