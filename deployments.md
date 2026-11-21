# Deployments — Aevum testnet (chain 44005)

RPC: `https://rpc-test.qday.info` · Explorer: https://explorer-test.qday.info
All transactions are legacy (type 0), EVM Shanghai. Explorer contract-source
verification is not available on Aevum yet, so these addresses plus the
repository commit are the deployment proof (per the Aevum Starter Kit docs).

## Contracts

| Contract | Address | Deploy tx |
|---|---|---|
| PayeeRegistry | `0x4A31fD9169E2DFaBB0763c1E8B38B24eC516780A` | `0x8e6da8f2cdb208647ba9c18f502e65184be1511533e736f5898f3ab930c8bdcb` |
| **AgentInvoicePay v2** (args: tUSD8, PayeeRegistry) — **current** | `0xeEBa81989B929F21354851a0F00F92239f5faCC8` | `0x8c4d7b31d456993532e9e63021dbf37bf7c852b215c4068f4c8ba89c5b3e4fd7` |
| AgentInvoicePay v1 (args: tUSD8, PayeeRegistry) — superseded 21 Nov 2026 | `0x2D0ff19258d19d38F6352E8F565dF0BC3F7054ed` | `0x65ecb6971cb508046539c7750111263dc96a955471d0b182e9fb38eeb6c119f5` |
| tUSD8 (pre-existing, QDay) | `0x456569838f1d43009A91ebA4263147Afd7233483` | — |

Deployed from deployer `0xB9bD942878724029740A491a1e238449748f8eAe`:
v1 on 20 Nov 2026 (deploy block 3,648,858) and v2 on 21 Nov 2026 (deploy
block 3,739,911), both with `forge create`-equivalent legacy broadcasts.
**The PayeeRegistry was NOT redeployed for v2** — v2 is wired to the same
registry, which still holds the live "Sari Bakery" registration. The receipts
watcher scans `Paid` events from both contracts' deploy blocks and merges
them.

## v2 live evidence (21 Nov 2026)

Session granted on v2: per-tx cap 2 tUSD8 · daily cap 3 tUSD8 · **per-payee
cap 1.50 tUSD8/day** · expiry +7 days · payee allowlisted.

| Step | Result | Transaction |
|---|---|---|
| Session granted (v2, with per-payee cap) | caps above | [`0xccc67b32…7f19`](https://explorer-test.qday.info/tx/0xccc67b32768a459d6488dfa9cbe121b22584ac4e60fbc257dbcad0a500997f19) · allowlist [`0xacc6ed3a…4599`](https://explorer-test.qday.info/tx/0xacc6ed3a9c8323ba670948d723920c48997a09f17936d4fa3d49af2ec8604599) |
| Invoice A created — 1.25 tUSD8 | order `0x7ba5bd90…04aa` | [`0x35723e97…fdc`](https://explorer-test.qday.info/tx/0x35723e97ba4463259e2ef7503b04aa3e357fe540c04eea96d2e180268cd9afdc) |
| **Invoice A paid — 1.25 tUSD8** (agent, approve path) | success, block 3,739,955 | [`0x7861a801…c30`](https://explorer-test.qday.info/tx/0x7861a801e12cd58fe6e653a1a7c80f536a02a7e972a0325cb8719e2cdc9b8c30) |
| Invoice B created — 0.75 tUSD8 | order `0x75867a40…22c` | [`0xdeef370e…8e2b`](https://explorer-test.qday.info/tx/0xdeef370efba630d7318886d47cab6cd4ca24266f9089d638a150491422658e2b) |
| **Invoice B payment refused** | `eth_call` simulation reverts `PerPayeeCapExceeded(750000, 1250000, 1500000)` — 1.25 already paid + 0.75 > 1.50 per-payee cap; no transaction broadcast, B verified still unpaid | simulation only (see `scripts/deploy-and-prove-v2.mjs`) |
| Invoice C created — 0.25 tUSD8 | order `0x87ce7fb2…9ca9` | [`0xf1c984bc…af7`](https://explorer-test.qday.info/tx/0xf1c984bc0469eebca3e73b59a73b52010a2248f94507c8bee76ca2792e5abaf7) |
| **Invoice C paid gasless — 0.25 tUSD8** (owner signed EIP-3009 off-chain, agent relayed) | success, block 3,739,963; cumulative to payee today = exactly 1.50 (at cap) | [`0xaa5569bf…29f`](https://explorer-test.qday.info/tx/0xaa5569bf11c08481c3a486c13e26e36d2e6080786bb82f24dcf1222c8c76829f) |

Final balances after the v2 proofs (tUSD8): payee **3.50** (2.00 from v1 +
1.50 from v2), owner **1.50**. `spentToPayeeToday(agent, payee)` read back
**1,500,000** — exactly the per-payee cap.

## Roles used in the live evidence

| Role | Address |
|---|---|
| Owner / merchant (session grantor, invoice creator, payer) | `0xB9bD942878724029740A491a1e238449748f8eAe` |
| Agent (session holder) | `0x7D89Dc892b34Ec4b1e9d73E5D09A3601d0b8C382` |
| Payee — "Sari Bakery" (self-registered) | `0xA1A90bb88c3F0C12aEC9c1664DA3fAE2fAB88746` |

## Source fidelity

The v1 contracts were deployed on 20 Nov 2026 from this working tree before
the repository's first commit; the v1 sources are preserved in git history
(the commit before the v2 upgrade). The v2 contract was deployed on
21 Nov 2026 from the tree that adds the per-payee cap (`src/AgentInvoicePay.sol`
at the v2-upgrade commit) via `scripts/deploy-and-prove-v2.mjs`. Rebuilding
`src/` with the pinned toolchain (Foundry, solc 0.8.24,
`evm_version = "shanghai"`, optimizer 200 runs) reproduces the deployed v2
bytecode.
