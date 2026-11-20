# Deployments — Aevum testnet (chain 44005)

RPC: `https://rpc-test.qday.info` · Explorer: https://explorer-test.qday.info
All transactions are legacy (type 0), EVM Shanghai. Explorer contract-source
verification is not available on Aevum yet, so these addresses plus the
repository commit are the deployment proof (per the Aevum Starter Kit docs).

## Contracts

| Contract | Address | Deploy tx |
|---|---|---|
| PayeeRegistry | `0x4A31fD9169E2DFaBB0763c1E8B38B24eC516780A` | `0x8e6da8f2cdb208647ba9c18f502e65184be1511533e736f5898f3ab930c8bdcb` |
| AgentInvoicePay (args: tUSD8, PayeeRegistry) | `0x2D0ff19258d19d38F6352E8F565dF0BC3F7054ed` | `0x65ecb6971cb508046539c7750111263dc96a955471d0b182e9fb38eeb6c119f5` |
| tUSD8 (pre-existing, QDay) | `0x456569838f1d43009A91ebA4263147Afd7233483` | — |

Deployed 20 Nov 2026 from deployer `0xB9bD942878724029740A491a1e238449748f8eAe`
with `forge create --legacy --broadcast`. AgentInvoicePay deploy block:
3,648,858 (the receipts watcher scans `Paid` events from this block).

## Roles used in the live evidence

| Role | Address |
|---|---|
| Owner / merchant (session grantor, invoice creator, payer) | `0xB9bD942878724029740A491a1e238449748f8eAe` |
| Agent (session holder) | `0x7D89Dc892b34Ec4b1e9d73E5D09A3601d0b8C382` |
| Payee — "Sari Bakery" (self-registered) | `0xA1A90bb88c3F0C12aEC9c1664DA3fAE2fAB88746` |

## Source fidelity

The contracts were deployed from this working tree on 20 Nov 2026, before the
repository's first commit. The sources under `src/` have not been modified
since deployment; the initial commit only adds documentation, tests, scripts
and the demo around them. Rebuilding `src/` with the pinned toolchain
(Foundry, solc 0.8.24, `evm_version = "shanghai"`, optimizer 200 runs)
reproduces the deployed bytecode.
