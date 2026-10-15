// Tiny pool #3 for Variant C graduation rehearsal (devnet).
// Reuses tiny DBC config; new Token-2022 mint + pool + hook binding.
// Prints pool/mint/lock JSON for the buyout script.
import { Connection, Keypair, PublicKey, sendAndConfirmTransaction } from "@solana/web3.js";
import {
  DynamicBondingCurveClient,
  getBaseTokenForSwap,
} from "@meteora-ag/dynamic-bonding-curve-sdk";
import * as anchor from "@anchor-lang/core";
import { readFileSync, writeFileSync } from "fs";
import BN from "bn.js";

const TINY_CONFIG = new PublicKey("GPduPehufvwcwFK4mmDck3VkPRuD8uBEEXapV8iNhuWR");
const HOOK_ID = new PublicKey("3vRrCG5RnmrpTAr91rq9NnZqKCPgaDCmpEWKRLUTdqnH");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const conn = new Connection("https://api.devnet.solana.com", "confirmed");
  const wallet = Keypair.fromSecretKey(
    Buffer.from(JSON.parse(readFileSync(process.env.HOME + "/.config/solana/id.json", "utf8")))
  );
  const dbc = DynamicBondingCurveClient.create(conn, "confirmed");

  // 1. Fresh mint keypair — DBC's InitializeVirtualPoolWithToken2022TransferHook
  // Allocates + initializes the Token-2022 mint itself (with transfer-hook
  // extension: program = hook, authority = POOL_AUTHORITY) and mints supply
  // to the vault. Do NOT pre-create the mint (Allocate would collide).
  const baseMint = Keypair.generate();
  console.log("mint:", baseMint.publicKey.toBase58());

  // 2. DBC transfer-hook pool (SDK mints supply to vault, sets authorities).
  const poolTx = await dbc.creator.createPoolWithTransferHook({
    payer: wallet.publicKey,
    poolCreator: wallet.publicKey,
    config: TINY_CONFIG,
    baseMint: baseMint.publicKey,
    name: "TinyC3",
    symbol: "TINYC3",
    uri: "https://example.com/tinyc3.json",
    transferHookProgram: HOOK_ID,
  });
  poolTx.feePayer = wallet.publicKey;
  console.log(await sendAndConfirmTransaction(conn, poolTx, [wallet, baseMint], { commitment: "confirmed" }));

  // 3. Derive pool address, read vault_0 + buyable -> lock.
  const cfg: any = await dbc.state.getPoolConfig(TINY_CONFIG);
  const { deriveDbcPoolAddress, deriveDbcTokenVaultAddress } = await import("@meteora-ag/dynamic-bonding-curve-sdk");
  const pool = deriveDbcPoolAddress(cfg.quoteMint ?? cfg.quoteMint, baseMint.publicKey, TINY_CONFIG);
  await sleep(3000);
  const poolState: any = await dbc.state.getPool(pool);
  const live = poolState.poolState ?? poolState;
  const baseVault = deriveDbcTokenVaultAddress(pool, baseMint.publicKey);
  const vaultAcc = await conn.getTokenAccountBalance(baseVault, "confirmed");
  const vault0 = new BN(vaultAcc.value.amount);
  // Closed-form buyable (getCurveBreakdown trips on on-chain curve shape).
  // NOTE: mainnet lock must come from this closed form, never from a fee
  // walk (see MEDIUM-C1): a ~562k-token lock error would brick all transfers
  // at the tail via checked_sub underflow. Verify byte-for-byte at launch.
  const { getMigrationThresholdPrice } = await import("@meteora-ag/dynamic-bonding-curve-sdk");
  const finalSqrt = getMigrationThresholdPrice(cfg.migrationQuoteThreshold, cfg.sqrtStartPrice, cfg.curve);
  const buyable = getBaseTokenForSwap(cfg.sqrtStartPrice, finalSqrt, cfg.curve);
  const lock = vault0.sub(buyable);
  console.log("pool:", pool.toBase58(), "vault0:", vault0.toString(), "buyable:", buyable.toString(), "lock:", lock.toString());

  // 4. Hook binding (must precede first swap).
  const provider = new anchor.AnchorProvider(conn, new anchor.Wallet(wallet), { commitment: "confirmed" });
  anchor.setProvider(provider);
  const idl = JSON.parse(readFileSync("target/idl/hook.json", "utf8"));
  const program = new anchor.Program(idl, provider) as any;
  const [configPda] = PublicKey.findProgramAddressSync([Buffer.from("config"), baseMint.publicKey.toBuffer()], HOOK_ID);
  await program.methods.initializeConfig(pool, lock).accounts({ authority: wallet.publicKey, mint: baseMint.publicKey, config: configPda, pool }).signers([wallet]).rpc();
  await program.methods.initializeExtraAccountMetaList().accounts({ payer: wallet.publicKey, mint: baseMint.publicKey, config: configPda }).signers([wallet]).rpc();
  console.log("hook bound");

  const out = { pool: pool.toBase58(), mint: baseMint.publicKey.toBase58(), lock: lock.toString(), threshold: cfg.migrationQuoteThreshold.toString() };
  writeFileSync("/tmp/opencode/tiny3.json", JSON.stringify(out, null, 2));
  console.log(JSON.stringify(out));
}

main().catch((e) => { console.error("FAILED:", e); process.exit(1); });
