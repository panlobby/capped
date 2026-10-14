import * as anchor from "@anchor-lang/core";
import { Program, BN } from "@anchor-lang/core";
import { Hook } from "../target/types/hook";
import { Keypair, PublicKey } from "@solana/web3.js";
import {
  createMint,
  getOrCreateAssociatedTokenAccount,
  mintTo,
} from "@solana/spl-token";
import { assert } from "chai";

const POOL_AUTHORITY = new PublicKey("FhVo3mqL8PW5pH5U2CN4XE33DokiyZnUwuGpH2hmHLuM");
const U = new BN(1_000_000);
const TOK = (n: number) => new BN(n).mul(U);

const BET = { s1: TOK(50_000), s2: TOK(50_000), s3: TOK(25_000), s4: TOK(12_500) };

function extraMetasPda(mint: PublicKey, programId: PublicKey): PublicKey {
  const [pda] = PublicKey.findProgramAddressSync(
    [Buffer.from("extra-account-metas"), mint.toBuffer()],
    programId
  );
  return pda;
}

describe("hookasino caps", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const program = anchor.workspace.hook as Program<Hook>;
  const payer = (provider.wallet as anchor.Wallet).payer as Keypair;

  type StreetCtx = {
    mint: PublicKey;
    config: PublicKey;
    pool: PublicKey;
    vault: PublicKey; // ATA owned by POOL_AUTHORITY
  };

  async function setupStreet(
    remainingTokens: number,
    seed: number,
    lockTokens: number = 1
  ): Promise<StreetCtx> {
    // Throwaway SPL mint stands in for the Token-2022 base mint (only key is checked).
    const mint = await createMint(provider.connection, payer, payer.publicKey, null, 6);
    const [config] = PublicKey.findProgramAddressSync(
      [Buffer.from("config"), mint.toBuffer()],
      program.programId
    );
    const [pool] = PublicKey.findProgramAddressSync(
      [
        Buffer.from("mock-pool"),
        payer.publicKey.toBuffer(),
        new BN(seed).toArrayLike(Buffer, "le", 8),
      ],
      program.programId
    );
    await program.methods
      .initMockPool(new BN(seed), new BN(remainingTokens).mul(U))
      .accounts({ authority: payer.publicKey, mockPool: pool })
      .rpc();
    await program.methods
      .initializeConfig(pool, new BN(lockTokens).mul(U))
      .accounts({ authority: payer.publicKey, mint, config, pool })
      .rpc();
    const vaultAcc = await getOrCreateAssociatedTokenAccount(
      provider.connection,
      payer,
      mint,
      POOL_AUTHORITY,
      true
    );
    await mintTo(provider.connection, payer, mint, vaultAcc.address, payer.publicKey, BigInt(1_000_000) * BigInt(1_000_000));
    return { mint, config, pool, vault: vaultAcc.address };
  }

  async function userAta(mint: PublicKey, owner: Keypair, fundTokens: number) {
    const acc = await getOrCreateAssociatedTokenAccount(
      provider.connection,
      payer,
      mint,
      owner.publicKey
    );
    if (fundTokens > 0) {
      await mintTo(
        provider.connection,
        payer,
        mint,
        acc.address,
        payer.publicKey,
        BigInt(fundTokens) * BigInt(1_000_000)
      );
    }
    return acc.address;
  }

  async function check(
    s: StreetCtx,
    source: PublicKey,
    destination: PublicKey,
    authority: PublicKey,
    amount: BN
  ) {
    return program.methods
      .transferHook(amount)
      .accounts({
        source,
        mint: s.mint,
        destination,
        authority,
        extraAccountMetaList: extraMetasPda(s.mint, program.programId),
        config: s.config,
        pool: s.pool,
      })
      .rpc();
  }

  let s1: StreetCtx, s2: StreetCtx, s3: StreetCtx, s4: StreetCtx;
  let sTailBuy: StreetCtx, sTailPartial: StreetCtx, sTailFull: StreetCtx, sTailSell: StreetCtx;

  before(async () => {
    s1 = await setupStreet(990_000_000, 1); // S1: >950M
    s2 = await setupStreet(900_000_000, 2); // S2
    s3 = await setupStreet(700_000_000, 3); // S3
    s4 = await setupStreet(100_000_000, 4); // S4 river
    // Mock `remaining` is the POST-debit vault (hook observes post-transfer).
    // lock 100k everywhere; true remainder R implied per case.
    sTailBuy = await setupStreet(100_000, 5, 100_000); // R=7k fully taken
    sTailPartial = await setupStreet(106_000, 6, 100_000); // R=7k, 1k in flight
    sTailFull = await setupStreet(94_500, 7, 100_000); // R=7k, 12.5k in flight
    sTailSell = await setupStreet(119_500, 8, 100_000); // sell side
  });

  it("S1 buy exact 50k passes", async () => {
    const user = Keypair.generate();
    const dest = await userAta(s1.mint, user, 0);
    const sig = await check(s1, s1.vault, dest, POOL_AUTHORITY, BET.s1);
    assert.isString(sig);
  });

  it("S1 buy wrong size 30k reverts", async () => {
    const user = Keypair.generate();
    const dest = await userAta(s1.mint, user, 0);
    try {
      await check(s1, s1.vault, dest, POOL_AUTHORITY, TOK(30_000));
      assert.fail("should revert");
    } catch (e: any) {
      assert.include(e.toString(), "InvalidBetSize");
    }
  });

  it("S1 buy over hold 200k reverts", async () => {
    // Direct hook call observes the funded balance as-is: 250k > 200k cap.
    const user = Keypair.generate();
    const dest = await userAta(s1.mint, user, 250_000); // over cap already
    try {
      await check(s1, s1.vault, dest, POOL_AUTHORITY, BET.s1);
      assert.fail("should revert");
    } catch (e: any) {
      assert.include(e.toString(), "ExceedsHold");
    }
  });

  it("S1 buy with wrong authority reverts", async () => {
    const user = Keypair.generate();
    const dest = await userAta(s1.mint, user, 0);
    try {
      await check(s1, s1.vault, dest, user.publicKey, BET.s1);
      assert.fail("should revert");
    } catch (e: any) {
      assert.include(e.toString(), "Unauthorized");
    }
  });

  it("S2 buy 50k passes, 25k reverts", async () => {
    const user = Keypair.generate();
    const dest = await userAta(s2.mint, user, 0);
    await check(s2, s2.vault, dest, POOL_AUTHORITY, BET.s2);
    try {
      await check(s2, s2.vault, dest, POOL_AUTHORITY, TOK(25_000));
      assert.fail("should revert");
    } catch (e: any) {
      assert.include(e.toString(), "InvalidBetSize");
    }
  });

  it("S3 buy 25k passes, 50k reverts", async () => {
    const user = Keypair.generate();
    const dest = await userAta(s3.mint, user, 0);
    await check(s3, s3.vault, dest, POOL_AUTHORITY, BET.s3);
    try {
      await check(s3, s3.vault, dest, POOL_AUTHORITY, TOK(50_000));
      assert.fail("should revert");
    } catch (e: any) {
      assert.include(e.toString(), "InvalidBetSize");
    }
  });

  it("S4 buy 12.5k passes, 25k reverts", async () => {
    const user = Keypair.generate();
    const dest = await userAta(s4.mint, user, 0);
    await check(s4, s4.vault, dest, POOL_AUTHORITY, BET.s4);
    try {
      await check(s4, s4.vault, dest, POOL_AUTHORITY, TOK(25_000));
      assert.fail("should revert");
    } catch (e: any) {
      assert.include(e.toString(), "InvalidBetSize");
    }
  });

  it("S1 sell exact 50k passes, 30k reverts", async () => {
    const user = Keypair.generate();
    const src = await userAta(s1.mint, user, 100_000);
    await check(s1, src, s1.vault, user.publicKey, BET.s1);
    try {
      await check(s1, src, s1.vault, user.publicKey, TOK(30_000));
      assert.fail("should revert");
    } catch (e: any) {
      assert.include(e.toString(), "InvalidBetSize");
    }
  });

  it("sell with delegate authority reverts", async () => {
    const user = Keypair.generate();
    const other = Keypair.generate();
    const src = await userAta(s1.mint, user, 100_000);
    try {
      await check(s1, src, s1.vault, other.publicKey, BET.s1);
      assert.fail("should revert");
    } catch (e: any) {
      assert.include(e.toString(), "Unauthorized");
    }
  });

  it("P2P wallet-to-wallet blocked", async () => {
    const a = Keypair.generate();
    const b = Keypair.generate();
    const src = await userAta(s4.mint, a, 100_000);
    const dst = await userAta(s4.mint, b, 0);
    try {
      await check(s4, src, dst, a.publicKey, BET.s4);
      assert.fail("should revert");
    } catch (e: any) {
      assert.include(e.toString(), "P2PBlocked");
    }
  });

  it("TAIL buy exact remainder 7k passes", async () => {
    const user = Keypair.generate();
    const dest = await userAta(sTailBuy.mint, user, 0);
    const sig = await check(sTailBuy, sTailBuy.vault, dest, POOL_AUTHORITY, TOK(7_000));
    assert.isString(sig);
  });

  it("TAIL buy partial 1k reverts", async () => {
    const user = Keypair.generate();
    const dest = await userAta(sTailPartial.mint, user, 0);
    try {
      await check(sTailPartial, sTailPartial.vault, dest, POOL_AUTHORITY, TOK(1_000));
      assert.fail("should revert");
    } catch (e: any) {
      assert.include(e.toString(), "InvalidBetSize");
    }
  });

  it("TAIL buy full 12.5k bet reverts (does not fit)", async () => {
    const user = Keypair.generate();
    const dest = await userAta(sTailFull.mint, user, 0);
    try {
      await check(sTailFull, sTailFull.vault, dest, POOL_AUTHORITY, BET.s4);
      assert.fail("should revert");
    } catch (e: any) {
      assert.include(e.toString(), "InvalidBetSize");
    }
  });

  it("TAIL sell 12.5k passes, 7k reverts (sells stay exact)", async () => {
    const user = Keypair.generate();
    const src = await userAta(sTailSell.mint, user, 100_000);
    await check(sTailSell, src, sTailSell.vault, user.publicKey, BET.s4);
    try {
      await check(sTailSell, src, sTailSell.vault, user.publicKey, TOK(7_000));
      assert.fail("should revert");
    } catch (e: any) {
      assert.include(e.toString(), "InvalidBetSize");
    }
  });
});
