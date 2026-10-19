# Repository Guide (`capped`)

**capped** is a Solana Token-2022 transfer-hook program paired with a Meteora Dynamic Bonding Curve (DBC) launch configuration and a static, zero-backend trade panel.

## Repository Layout

* `programs/hook/src/lib.rs` — On-chain Token-2022 transfer hook enforcing the 4-street fixed-chip rules (`25k` multiples up to the street max), per-wallet hold caps (`ExceedsHold`), P2P transfer blocking (`P2PBlocked`), and the final `<25k` tail drain.
* `tests/hook.ts` — Anchor integration test suite.
* `migrations/deploy.ts` — Canonical launch parameters (`LAUNCH_PARAMS`).
* `ui/` — Static open-source trade panel (`ui/index.html`, `ui/trade.js`, `ui/params.json`, `ui/devnet.json`). Runs directly in the browser against Solana RPC with no backend and no build step.
* `docs/limits-architecture.md` — Public specification of the street mechanics, curve parameters, and graduation lifecycle.
* `docs/SECURITY.md` — Security and verification overview.

## Build & Verification Commands

* **Hook unit tests (38 tests):**
  ```bash
  cargo test -p hook --locked --features local-test
  ```
* **Production program build (excludes `local-test` helpers):**
  ```bash
  anchor build
  ```
* **UI syntax check:**
  ```bash
  node --check ui/trade.js
  ```

## Guidelines

* Keep `ui/` dependency-free and buildless (pinned ESM imports in `ui/index.html` matching `bun.lock`).
* Keep on-chain constants in `programs/hook/src/lib.rs`, `migrations/deploy.ts`, `ui/trade.js`, and `ui/params.json` in exact sync.
* Respond in clear, simple English (or in the language explicitly requested by the user).
