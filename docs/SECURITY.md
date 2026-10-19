# Security

* The transfer-hook program (`programs/hook/src/lib.rs`) is fully open source
  in this repo so anyone can verify what it enforces.
* Unit (38/38) and integration (19/19) suites run in CI on every push
  (`.github/workflows/ci.yml`).
* The full lifecycle — street chips, wrong-size and P2P reverts, tail drain,
  hook revocation at graduation, DAMM v2 migration — was rehearsed end to end
  on Solana devnet before mainnet.
* Mainnet rule: hook logic is finalized before the pool exists. No upgrades
  after launch; the upgrade authority is locked (multisig/immutable) before
  serious volume.

Found an issue? Open a GitHub issue with a reproduction (cluster, pool,
tx signature, expected vs observed behavior).
