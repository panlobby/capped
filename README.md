# A capped token on Meteora DBC with a hook.

![capped](ui/banner.svg)

**capped** turns a Solana bonding curve into a four-street limit-holdem table.
While the pool trades on its Meteora Dynamic Bonding Curve (DBC), an on-chain Token-2022 transfer hook enforces **fixed chip sizes** and **per-wallet bag caps** on every single trade. No single wallet can snipe the supply, and no custom router is required.

Once the curve fills (~$1M market cap / ~2,245.88 SOL net inflow), the graduating swap **automatically revokes the hook** and migrates liquidity to **Meteora DAMM v2** — from that block forward, all limits are gone and the token trades freely.

---

## Mainnet Addresses

| Item | Address |
| :--- | :--- |
| **Token Mint (`capped`)** | [`CAPU3xPH4a435pnba47uwDM7o94Dy2F5psWimCGPpMBE`](https://solscan.io/token/CAPU3xPH4a435pnba47uwDM7o94Dy2F5psWimCGPpMBE) |
| **Meteora DBC Pool** | [`7Bng3rv1XdWQvW4VHXuSr4gZJqdjgRD16DNyQJeciNkL`](https://solscan.io/account/7Bng3rv1XdWQvW4VHXuSr4gZJqdjgRD16DNyQJeciNkL) |
| **Hook Program** | [`3vRrCG5RnmrpTAr91rq9NnZqKCPgaDCmpEWKRLUTdqnH`](https://solscan.io/account/3vRrCG5RnmrpTAr91rq9NnZqKCPgaDCmpEWKRLUTdqnH) |
| **Hook Config PDA** | [`HHMiymv2C5r9LFXGxY3jkDM5h2FiDbTq9v6JfauDW1Df`](https://solscan.io/account/HHMiymv2C5r9LFXGxY3jkDM5h2FiDbTq9v6JfauDW1Df) |
| **Trade Panel (GitHub Pages)** | [`https://panlobby.github.io/capped/ui/`](https://panlobby.github.io/capped/ui/) |

---

## Why Capped?

* **Anti-Snipe by Construction:** Early buyers in Street 1 can only buy `25,000` or `50,000` tokens per transaction and hold at most `200,000` tokens (`0.02%` of supply). Clearing the full curve requires at least **10,004 net buy transactions** across all four streets.
* **Symmetric Chip Play:** Buys and sells use the exact same `25,000`-multiple chips up to the active street limit.
* **Hard Wallet Ceiling:** Even in the final street (River), the maximum wallet hold is capped at **20M tokens (2% of supply)**.
* **100% On-Chain & Temporary:** Rules are enforced by the Token-2022 transfer hook (`programs/hook/src/lib.rs`), not by a frontend. At graduation, DBC revokes the hook in the same transaction.

---

## The 4 Streets

Supply is **1,000,000,000 tokens** (6 decimals): **775.41M buyable** on the curve + **224.59M (22.5%) locked** for DAMM v2 migration liquidity. The active street is determined live by how many curve tokens have been sold:

| Street | Curve Tokens Sold | Allowed Chips (Buy & Sell) | Max Wallet Hold | Min Net Buys to Clear |
| :--- | :--- | :--- | :--- | :--- |
| **S1 · Preflop** | `0 → 50M` | `25k` / `50k` | `200k` *(0.02%)* | `1,000` |
| **S2 · Flop** | `50M → 150M` | `25k` / `50k` | `1M` *(0.10%)* | `2,000` |
| **S3 · Turn** | `150M → 375M` | `25k` / `50k` / `75k` | `4.5M` *(0.45%)* | `3,000` |
| **S4 · River** | `375M → 775.41M` | `25k` / `50k` / `75k` / `100k` | `20M` *(2.00%)* | `4,004 + final tail` |

* **Streets are reversible:** Selling returns tokens to the pool vault. Heavy selling can push the table back to an earlier street (existing holders are never bricked).
* **Final Tail Graduation:** Near the end of Street 4, any fitting chip (`25k` / `50k` / `75k`) continues to work while `buyable ≥ 25k`. Once less than `25,000` tokens remain buyable, the Buy button automatically switches to **Drain Final Tail & Graduate**, buying the remaining tokens in a single swap, revoking the hook, and graduating the pool.

---

## How to Trade

> **Important:** Standard `ExactIn` buys (typing `"0.1 SOL"` on a generic swap UI) output an arbitrary token amount like `142,831.19` tokens — the on-chain hook will reject that with `InvalidBetSize`. **Buys must be quoted as `ExactOut(chip)`** so the exact chip size lands in your wallet.

### Using the Official Static Trade Panel (`ui/`)

1. **Open the Trade Panel** (`ui/index.html` locally or via GitHub Pages). No wallet is required to view live street state, vault balances, and chip quotes.
2. **Connect Phantom (Opt-in):** Click **Connect Phantom** in the top bar to load your SOL balance, token balance, and remaining street hold headroom (`Disconnect` anytime with one click).
3. **Buy a Chip (`ExactOut`):** Select an unlocked chip (`+25,000`, `+50,000`, `+75,000`, or `+100,000`), check the live SOL quote and slippage tolerance, and click **Buy Selected Chip**.
4. **Sell a Chip (`ExactIn`):** Select a chip (`−25,000` up to street max) and click **Sell Selected Chip**.

### On-Chain Hook Error Reference

| Error Name | Code | Meaning |
| :--- | :--- | :--- |
| `InvalidBetSize` | `6005` (`0x1775`) | Trade amount is not an allowed `25k`-multiple chip for the current street (or you used `ExactIn` on a buy). |
| `ExceedsHold` | `6006` (`0x1776`) | Buying this chip would push your wallet balance above the current street's hold cap. |
| `P2PBlocked` | `6007` (`0x1777`) | Direct wallet-to-wallet transfers are blocked while the bonding curve is active (DEX swaps only). |

---

## Transparency & Verification

* **Zero Backend / Zero Trackers:** `ui/index.html` and `ui/trade.js` run entirely in your browser with no build step, talking directly to the Solana RPC and official Meteora DBC SDK.
* **On-Chain Hook Source:** [`programs/hook/src/lib.rs`](programs/hook/src/lib.rs)
* **Architecture & Tokenomics Spec:** [`docs/limits-architecture.md`](docs/limits-architecture.md)
* **Security & Verification:** [`docs/SECURITY.md`](docs/SECURITY.md)
* **Launch Parameters:** [`migrations/deploy.ts`](migrations/deploy.ts)
