# PaySure Agent — Design

**Working name:** PaySure Agent (renameable). Built for the **Aevum Builder Challenge #1**
(QDay.io / PQA Labs, DoraHacks): one end-to-end tUSD8 payment flow on the Aevum testnet
(chain 44005), where an AI agent pays merchant invoices **inside a contract-enforced
session budget** — and can only ever pay the *named, verified* payee the *exact* amount.

> Status: **Milestones 1–4 done** (contracts → testnet deploy + live flows → gasless +
> watcher → live demo UI → public repo + GitHub Pages). See "Milestone status" below.
> Repo: https://github.com/Ajengayukusu/paysure-agent ·
> Live demo: https://ajengayukusu.github.io/paysure-agent/

## The problem

Letting an AI agent hold a wallet key is letting it spend without limits, to any address
it (or a prompt injection) chooses. Two failure stories repeat in agent payments:
1. **Wrong recipient** — address poisoning / a hallucinated address sends funds to a
   lookalike. Raw `Transfer` events carry no payee name, so nothing checks *who* was meant.
2. **Runaway or mispriced spend** — a generic checkout that records *any* amount as
   "paid" (the starter kit's own docs warn its example lets `pay(orderId, 1)` settle an
   order for 0.000001 tUSD8) and no caps if the agent key leaks or loops.

PaySure answers both on-chain, not in UI promises.

## Architecture

```
Merchant ──createInvoice(orderId, payeeName, payee, exactAmount, expiry)──► AgentInvoicePay
                                                                                 │
Payee ──register("Alice Payee" → own address)──► PayeeRegistry ◄──lookup(name)───┤ checked at
                                                                                 │ create AND pay
Owner ──grantSession(agent, perTxCap, dailyCap, expiry) + setPayeeAllowed────►   │
Owner ──revokeSession(agent)  (instant kill switch)──────────────────────────►   │
                                                                                 │
Agent ──payInvoice(orderId, exactAmount)──────────────► transferFrom(owner → payee)
Agent ──payInvoiceWithAuthorization(owner's EIP-3009 sig, nonce = f(orderId))──► gasless relay
                                                                                 │
Receipt (payer, agent, payee, amount, paidAt) stored on-chain + Paid event ◄─────┘
Merchant ──recordRefund(orderId, amount, refundTxRef)──► refund bookkeeping + event
```

### Contracts (`src/`)

| Contract | Role |
|---|---|
| `PayeeRegistry.sol` | **Confirmation of Payee.** Case-insensitive name → address registry (QDay's ERC-8004 is not open for this challenge, so the mapping lives here, per the kit docs). Self-registration can only claim a name for the caller's own address; a registered name can never be overwritten by someone else; only the registrant or the registry owner can update/remove. Every change emits an event. |
| `AgentInvoicePay.sol` | **Core.** Invoices with an exact amount + expiry; owner-granted agent *sessions* (per-tx cap, daily cap on a UTC-day window, session expiry, per-payee allowlist, instant revoke); two payment paths (approve+`transferFrom`, and gasless EIP-3009 relay with the signature nonce bound to the orderId, the kit's pattern); on-chain receipts; merchant refund bookkeeping. |
| `mocks/MockTUSD8.sol` | Local test token adapted from the kit's `MockUSD8` (MIT, PQA Labs): 6 decimals, EIP-712 domain `("tUSD8", "2")`, full EIP-3009. Local testing only. |

### Payment rules (all enforced in `_validatePayment`, both paths)

An agent payment succeeds **only if all** hold — otherwise it reverts with a specific error:
invoice exists · not already paid · not expired · `amount == invoice.amount` **exactly**
(under *and* over rejected — the kit flaw, fixed) · registry still resolves the invoice's
payee name to the invoice's payee (re-checked at payment time, so a registry change
blocks payment instead of paying a stale address) · session granted, not revoked, not
expired · payee is on the session's allowlist · `amount ≤ perTxCap` ·
`spentToday + amount ≤ dailyCap`.

Funds always move **payer (session owner) → payee**; the contract never holds a balance.

## How each judging criterion is addressed

1. **UX & presentation** — *(M3, UI milestone)* One flow, plain-language states; contract
   errors are already specific (`AmountMismatch(expected, got)`, `DailyCapExceeded(...)`)
   so the UI can show exact reasons instead of "transaction failed".
2. **Demo clarity** — *(M3–M4)* The full flow is a handful of transactions with a `Paid`
   event + stored receipt per payment: every demo step is verifiable on the explorer.
3. **Documentation** — This file + `NOTICE.md` (credits/licenses) + `README.md`
   (turnkey setup, deployed addresses + evidence table, reproduction steps,
   limitations, roadmap) + `deployments.md` (deployment provenance).
4. **Innovation** — Confirmation-of-Payee + scoped agent sessions + exact-amount
   enforcement combined in one invoice flow; goes beyond the kit's template (which has
   no price check, no caps, no payee identity). Not an escrow clone — the crowded lane
   in this challenge.
5. **Technical quality & platform integration** — Session keys with budgets/expiry are
   implemented in-contract (the challenge has no supported bundler/paymaster, per kit
   FAQ); EIP-3009 gasless relay; Shanghai-only build verified by the kit's bytecode
   checker; 35 unit tests, all passing, covering every rejection rule.
6. **Real-world utility** — Freelancers/agencies paying contractors through agents:
   named payees, exact invoices, daily budgets, instant revoke, provable receipts and a
   refund trail map 1:1 onto real AP workflows; path to mainnet = same contracts on
   Aevum mainnet with USD8.
7. **Safety, trust & controls** — Least-privilege by construction: an agent key can only
   pay allowlisted, registry-verified payees, exact invoice amounts, inside caps, until
   session expiry or one-tx revocation. Full on-chain audit trail (invoices, sessions,
   receipts, refunds — all events + stored state).
8. **Ecosystem contribution** — `PayeeRegistry` is a standalone Confirmation-of-Payee
   primitive any Aevum payment app can reuse (ERC-8004-shaped: name → address + events);
   session-cap logic is a reusable pattern for agent payments. MIT licensed, kit credited.

## Aevum specifics honored

- `evm_version = "shanghai"`, solc 0.8.24 (Cancun opcodes revert on Aevum); bytecode
  checked with the kit's `tools/check-shanghai.mjs`.
- tUSD8 = `0x456569838f1d43009A91ebA4263147Afd7233483`, 6 decimals, EIP-3009 domain
  `("tUSD8", "2")` — mirrored by the local mock.
- Legacy transactions and the 1,000-block `eth_getLogs` limit are deployment/watcher
  concerns for M2–M3 (chunked reader from the kit's `packages/aevum`).

## Milestone status

- **M1 — contracts (local): DONE, 20 Nov 2026.**
  `forge build` OK · Shanghai check: **6 bytecode blobs, safe** ·
  `forge test`: **35 passed, 0 failed** (22 `AgentInvoicePay` + 13 `PayeeRegistry`),
  including: happy path, under/over/dust amount rejection, double-pay, expired invoice,
  per-tx cap, daily cap across two payments (+ next-day rollover), revoked session,
  expired session, no session, non-allowlisted payee, registry-changed-after-creation,
  creation-time mismatch + unregistered name, gasless happy path, gasless signature
  bound to order, gasless amount mismatch, refund record + two refund rejections,
  registry squatting/case/update/remove rules.
- **M2 — fork tests + testnet deploy + live flow: DONE, 20 Nov 2026.**
  Fork suite vs real tUSD8: **3 passed, 0 failed** (full flow + over-cap revert); local suite
  still 35/35. Deployed on Aevum (44005): PayeeRegistry `0x4A31fD9169E2DFaBB0763c1E8B38B24eC516780A`,
  AgentInvoicePay `0x2D0ff19258d19d38F6352E8F565dF0BC3F7054ed`. Live flow proven on-chain:
  payee self-registered "Sari Bakery" → invoice 1.25 tUSD8 created → session granted
  (2 / 3 tUSD8 caps) → agent paid, payee balance 0 → 1.25 tUSD8 exactly, receipt on-chain;
  negative proof: a 2.5 tUSD8 payment reverted `PerTxCapExceeded`. Full tx hashes:
  `build-milestone-2.md` in the goal's hidden_files.
- **M3a — gasless live payment + watcher/receipts: DONE, 20 Nov 2026.**
  Invoice #3 (0.75 tUSD8) paid gasless on the real testnet: owner signed EIP-3009
  off-chain, the agent relayed `payInvoiceWithAuthorization` (tx
  `0xf8340950…ccc0`), payee 1.25 → 2.00 tUSD8 exactly, session `spentInDay`
  1,250,000 → 2,000,000, signature nonce consumed (no replay). Watcher
  (`scripts/watch-receipts.mjs`, chunked ≤1,000-block `eth_getLogs`, dedupe by
  txHash:logIndex) found exactly the 2 real payments; both honestly reported
  **Seen**, not Finalized — Aevum's `finalized` block lagged ~3,700 blocks at scan
  time. Evidence: `build-milestone-3a.md` in the goal's hidden_files.
- **M3b — live demo UI: DONE, 20 Nov 2026.**
  Static demo in `demo/` (no build step, no libraries, plain JSON-RPC): payee
  lookup, the 3 evidence invoices with live state, session + caps, live balances,
  and the chunked receipts watcher with Seen → Finalized. Verified headlessly by
  `demo/test-rpc.mjs` — **28 checks passed** against known on-chain truth,
  including invoice #2's "cannot be paid" state computed live (2.5 tUSD8 amount vs
  2 tUSD8 per-tx cap). Evidence: `build-milestone-3b.md`.
- **M4 — public repo + turnkey README + GitHub Pages demo: DONE, 20 Nov 2026.**
  Repo: https://github.com/Ajengayukusu/paysure-agent (public) — turnkey README
  (architecture, deployed addresses, evidence table with tx links, run-it-yourself
  commands, limitations, roadmap), `deployments.md` provenance, demo published at
  https://ajengayukusu.github.io/paysure-agent/ (gh-pages branch: only
  `index.html`, `app.js`, `rpc-core.js`, `style.css`). Remaining for the challenge:
  demo recording + DoraHacks submission (tracked outside this repo).

### Known limitations / TODOs (honest list)

- Refunds are *bookkeeping* (merchant records the refund transfer's reference); the
  refund transfer itself is a normal token transfer — no escrowed refund path yet.
- Daily cap uses a UTC calendar-day window, not a rolling 24 h window.
- The gasless path requires the *agent* (session holder) to relay; a third-party
  relayer mode (relayer ≠ agent) is an M3 design question.
- The mock has no EIP-2612 `permit` (same as the kit mock); no project flow uses permit.
