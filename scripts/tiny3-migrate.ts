// Migrate graduated tiny #3 to DAMM v2 (devnet). Reuses the cp-amm config
// from the tiny#2 migration (configs are reusable fee templates).
import { Connection, Keypair, PublicKey, sendAndConfirmTransaction } from "@solana/web3.js";
import { DynamicBondingCurveClient } from "@meteora-ag/dynamic-bonding-curve-sdk";
import { readFileSync } from "fs";

const DAMM_CONFIG = new PublicKey("7F6dnUcRuyM2TwR8myT1dYypFXpPSxqwKNSFNkxyNESd");

async function main() {
  const { pool: POOL_S } = JSON.parse(readFileSync("/tmp/opencode/tiny3.json", "utf8"));
  const conn = new Connection("https://api.devnet.solana.com", "confirmed");
  const wallet = Keypair.fromSecretKey(
    Buffer.from(JSON.parse(readFileSync(process.env.HOME + "/.config/solana/id.json", "utf8")))
  );
  const dbc = DynamicBondingCurveClient.create(conn, "confirmed");
  const res: any = await dbc.migration.migrateToDammV2({
    payer: wallet.publicKey, pool: new PublicKey(POOL_S), dammConfig: DAMM_CONFIG,
  });
  res.transaction.feePayer = wallet.publicKey;
  const sig = await sendAndConfirmTransaction(conn, res.transaction,
    [wallet, res.firstPositionNftKeypair, res.secondPositionNftKeypair], { commitment: "confirmed" });
  console.log("migrated:", sig);
  const p: any = await dbc.state.getPool(new PublicKey(POOL_S));
  console.log("isMigrated:", (p.poolState ?? p).isMigrated.toString());
}

main().catch((e) => { console.error("FAILED:", e); process.exit(1); });
