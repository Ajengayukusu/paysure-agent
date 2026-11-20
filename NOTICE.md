# NOTICE — credits & licenses

**PaySure Agent** is built for the Aevum Builder Challenge #1 (QDay.io / PQA Labs).

Derived from / inspired by:
- **Aevum Starter Kit** — MIT License, Copyright (c) 2026 PQA Labs
  (https://github.com/qday-io/aevum-starter-kit). Reused patterns: the EIP-3009
  `receiveWithAuthorization` flow with the order-bound nonce
  (`keccak256(abi.encode(contract, orderId))`), the Shanghai bytecode checker
  (`tools/check-shanghai.mjs`), the EIP-3009 signing helper (`test/Signing.sol`),
  and the local tUSD8 mock (adapted as `src/mocks/MockTUSD8.sol`). The kit's
  license text is preserved in `LICENSE`.
  The core contracts (`PayeeRegistry`, `AgentInvoicePay`) are original work —
  not a copy of the kit's `Checkout` — and deliberately fix Checkout's documented
  missing amount check.

Libraries (each with its own license file preserved inside its directory after install):
- **OpenZeppelin Contracts v5.1.0** — MIT License (see `lib/openzeppelin-contracts/LICENSE`).
- **forge-std v1.9.6** — MIT / Apache-2.0 (see `lib/forge-std/LICENSE-MIT`, `LICENSE-APACHE`).

In this repository `lib/` is not vendored; install the pinned versions with
`forge install foundry-rs/forge-std@v1.9.6` and
`forge install OpenZeppelin/openzeppelin-contracts@v5.1.0` (see README).
