/* Headless verification of the demo's RPC logic — imports the SAME
 * rpc-core.js the browser page uses, talks to the live Aevum RPC, and
 * asserts the known on-chain truth. Run: node test-rpc.mjs
 *
 * Updated 21 Nov 2026 for the v2 upgrade: AgentInvoicePay v2 (per-payee cap)
 * is the current contract; v1 is superseded but its evidence stays on-chain.
 * NOTE: the two "spent today" checks assert the proof-day truth of
 * 21 Nov 2026 (the UTC day the v2 live proofs were produced); on a later UTC
 * day the day-window rolls and those two values read 0 by design.
 */
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const C = require("./rpc-core.js");

const RPC = "https://rpc-test.qday.info";
const CFG = {
  tusd8: "0x456569838f1d43009A91ebA4263147Afd7233483",
  registry: "0x4A31fD9169E2DFaBB0763c1E8B38B24eC516780A",
  invoicePay: "0xeEBa81989B929F21354851a0F00F92239f5faCC8", // v2 (current)
  invoicePayV1: "0x2D0ff19258d19d38F6352E8F565dF0BC3F7054ed", // v1 (superseded)
  deployBlock: 3739911,
  deployBlockV1: 3648858,
  owner: "0xB9bD942878724029740A491a1e238449748f8eAe",
  agent: "0x7D89Dc892b34Ec4b1e9d73E5D09A3601d0b8C382",
  payee: "0xA1A90bb88c3F0C12aEC9c1664DA3fAE2fAB88746",
  paidTopic: "0x060bb954af967ecb7aa08a0072a7f8fe308ceee2f5d15f4a9d4a5275a5fe79e9",
  // v1 invoices (20 Nov 2026)
  inv1: "0x07671c88b5d222242921494fa102beecf542efc654c9152f83b39b05e2064dc9",
  inv2: "0xdd36fb6695f3f3b84380ed10701fc40a8f190a4c180cdacde783d3321f4cef8d",
  inv3: "0x107d685b386d19c3a39e05315cc271a698d90c0c8af1d202af1a95185a656603",
  // v2 invoices (21 Nov 2026): A paid (approve), B blocked by per-payee cap, C paid (gasless)
  invA: "0x7ba5bd9052fda0850c42149a35efe5e7b24ad274a4434755cda690c3280a04aa",
  invB: "0x75867a4071dd3a1d56ff22183e5b222f5cdf3c4011ff5aabf202af4e8fc2e22c",
  invC: "0x87ce7fb2e9983c50b39eae06eb8d794d72b2e0bdff76860aa673b78d5e729ca9",
};

let id = 0, failures = 0;
async function rpc(method, params) {
  const r = await fetch(RPC, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params }),
  });
  const j = await r.json();
  if (j.error) throw new Error(method + ": " + j.error.message);
  return j.result;
}
const call = (to, data) => rpc("eth_call", [{ to, data }, "latest"]);
function check(label, actual, expected) {
  const ok = String(actual) === String(expected);
  console.log(`${ok ? "PASS" : "FAIL"}  ${label} = ${actual}${ok ? "" : " (expected " + expected + ")"}`);
  if (!ok) failures++;
}

// selector sanity: pure-JS keccak must reproduce the known selectors
check("selector lookup(string)", C.selector("lookup(string)"), "0xf67187ac");
check("selector balanceOf(address)", C.selector("balanceOf(address)"), "0x70a08231");
check("Paid topic matches watcher", C.bytesToHex(C.keccak256(C.utf8Bytes("Paid(bytes32,address,address,address,uint256)"))), CFG.paidTopic);

// parseUnits: the write panel's amount parser (string math, no floats)
check("parseUnits 1.25", C.parseUnits("1.25", 6), 1250000n);
check("parseUnits 0.75", C.parseUnits("0.75", 6), 750000n);
check("parseUnits 2", C.parseUnits("2", 6), 2000000n);

const latest = C.hexToNum(await rpc("eth_blockNumber", []));
const finBlock = await rpc("eth_getBlockByNumber", ["finalized", false]);
const finalized = C.hexToNum(finBlock.number);
console.log(`chain: latest=${latest} finalized=${finalized}`);

// registry lookup
{
  const res = await call(CFG.registry, C.encodeCall("lookup(string)", [{ type: "string", value: "Sari Bakery" }]));
  const w = C.words(res);
  check("lookup(Sari Bakery).address", C.wordToAddress(w[0]), CFG.payee.toLowerCase());
  check("lookup(Sari Bakery).registered", C.wordToBool(w[1]), true);
  const res2 = await call(CFG.registry, C.encodeCall("lookup(string)", [{ type: "string", value: "Nobody Here" }]));
  check("lookup(Nobody Here).registered", C.wordToBool(C.words(res2)[1]), false);
}

// invoices + receipts (per contract)
async function invoice(contract, orderId) {
  const res = await call(contract, C.encodeCall("invoiceOf(bytes32)", [{ type: "bytes32", value: orderId }]));
  const w = C.words(res);
  const base = Number(C.wordToBigInt(w[0])); // dynamic tuple: offset word first
  const hw = C.words(res.slice(2 + base * 2));
  return { merchant: C.wordToAddress(hw[0]), payee: C.wordToAddress(hw[1]),
    payeeName: C.decodeStringAt(res, base + Number(C.wordToBigInt(hw[2]))),
    amount: C.wordToBigInt(hw[3]), expiry: C.wordToBigInt(hw[4]), exists: C.wordToBool(hw[5]) };
}
async function receipt(contract, orderId) {
  const res = await call(contract, C.encodeCall("receiptOf(bytes32)", [{ type: "bytes32", value: orderId }]));
  const w = C.words(res);
  return { payer: C.wordToAddress(w[0]), agent: C.wordToAddress(w[1]), payee: C.wordToAddress(w[2]),
    amount: C.wordToBigInt(w[3]), paidAt: C.wordToBigInt(w[4]), paid: C.wordToBool(w[5]) };
}
// v1 evidence (superseded contract, still on-chain)
const i1 = await invoice(CFG.invoicePayV1, CFG.inv1), r1 = await receipt(CFG.invoicePayV1, CFG.inv1);
check("v1 invoice#1.amount", i1.amount, 1250000n);
check("v1 invoice#1.payeeName", i1.payeeName, "Sari Bakery");
check("v1 invoice#1.paid (receipt)", r1.paid, true);
check("v1 receipt#1.amount", r1.amount, 1250000n);
check("v1 receipt#1.agent", r1.agent, CFG.agent.toLowerCase());
check("v1 receipt#1.paidAt", r1.paidAt, 1795164570n);
const i2 = await invoice(CFG.invoicePayV1, CFG.inv2), r2 = await receipt(CFG.invoicePayV1, CFG.inv2);
check("v1 invoice#2.amount", i2.amount, 2500000n);
check("v1 invoice#2.paid", r2.paid, false);
const r3 = await receipt(CFG.invoicePayV1, CFG.inv3);
check("v1 invoice#3.paid (receipt)", r3.paid, true);
check("v1 receipt#3.amount", r3.amount, 750000n);
// v2 evidence (current contract)
const iA = await invoice(CFG.invoicePay, CFG.invA), rA = await receipt(CFG.invoicePay, CFG.invA);
check("v2 invoiceA.amount", iA.amount, 1250000n);
check("v2 invoiceA.payeeName", iA.payeeName, "Sari Bakery");
check("v2 invoiceA.paid (receipt)", rA.paid, true);
check("v2 receiptA.agent", rA.agent, CFG.agent.toLowerCase());
const iB = await invoice(CFG.invoicePay, CFG.invB), rB = await receipt(CFG.invoicePay, CFG.invB);
check("v2 invoiceB.amount", iB.amount, 750000n);
check("v2 invoiceB.paid (blocked by per-payee cap)", rB.paid, false);
const rC = await receipt(CFG.invoicePay, CFG.invC);
check("v2 invoiceC.paid (gasless, receipt)", rC.paid, true);
check("v2 receiptC.amount", rC.amount, 250000n);

// v2 session (incl. the new per-payee cap fields)
{
  const res = await call(CFG.invoicePay, C.encodeCall("sessionOf(address)", [{ type: "address", value: CFG.agent }]));
  const w = C.words(res);
  check("v2 session.perTxCap", C.wordToBigInt(w[0]), 2000000n);
  check("v2 session.dailyCap", C.wordToBigInt(w[1]), 3000000n);
  check("v2 session.granted", C.wordToBool(w[3]), true);
  check("v2 session.revoked", C.wordToBool(w[4]), false);
  check("v2 session.spentInDay (proof day)", C.wordToBigInt(w[6]), 1500000n);
  check("v2 session.perPayeeCap", C.wordToBigInt(w[7]), 1500000n);
  const resP = await call(CFG.invoicePay, C.encodeCall("spentToPayeeToday(address,address)",
    [{ type: "address", value: CFG.agent }, { type: "address", value: CFG.payee }]));
  check("v2 spentToPayeeToday(agent,payee) (proof day)", C.wordToBigInt(C.words(resP)[0]), 1500000n);
  const resA = await call(CFG.invoicePay, C.encodeCall("payeeAllowed(address,address)",
    [{ type: "address", value: CFG.agent }, { type: "address", value: CFG.payee }]));
  check("v2 payeeAllowed(agent,payee)", C.wordToBool(C.words(resA)[0]), true);
}

// balances (after BOTH v1 and v2 flows)
async function tusd8(who) {
  const res = await call(CFG.tusd8, C.encodeCall("balanceOf(address)", [{ type: "address", value: who }]));
  return C.wordToBigInt(C.words(res)[0]);
}
check("payee tUSD8 balance (2.00 v1 + 1.50 v2)", await tusd8(CFG.payee), 3500000n);
check("owner tUSD8 balance", await tusd8(CFG.owner), 1500000n);
check("agent tUSD8 balance", await tusd8(CFG.agent), 0n);
const agentNative = BigInt(await rpc("eth_getBalance", [CFG.agent, "latest"]));
console.log(`agent tQDAY = ${C.fmtTQDAY(agentNative)} (raw wei ${agentNative})`);
check("agent tQDAY > 0", agentNative > 0n, true);

// watcher: chunked getLogs over BOTH contracts + dedupe + merge
{
  const seen = new Map();
  const targets = [
    { v: "v1", address: CFG.invoicePayV1, from: CFG.deployBlockV1 },
    { v: "v2", address: CFG.invoicePay, from: CFG.deployBlock },
  ];
  for (const t of targets) {
    for (let from = t.from; from <= latest; from += 1000) {
      const to = Math.min(from + 999, latest);
      const logs = await rpc("eth_getLogs", [{ address: t.address, topics: [CFG.paidTopic],
        fromBlock: "0x" + from.toString(16), toBlock: "0x" + to.toString(16) }]);
      for (const log of logs) {
        const key = t.address + ":" + log.transactionHash + ":" + C.hexToNum(log.logIndex);
        if (seen.has(key)) continue;
        const dw = C.words(log.data);
        const amount = C.wordToBigInt(dw[1]);
        if (amount === 0n) continue;
        seen.set(key, { v: t.v, orderId: log.topics[1], amount, block: C.hexToNum(log.blockNumber),
          tx: log.transactionHash, payee: C.wordToAddress(dw[0]),
          status: C.hexToNum(log.blockNumber) <= finalized ? "Finalized" : "Seen" });
      }
    }
  }
  const pays = [...seen.values()].sort((a, b) => a.block - b.block);
  console.log("watcher payments:", pays.map(p => `[${p.v}] ${p.orderId.slice(0, 10)}… ${C.fmtTUSD8(p.amount)} tUSD8 block ${p.block} ${p.status} tx ${p.tx}`).join("\n  "));
  check("watcher payment count (v1 + v2 merged)", pays.length, 4);
  check("watcher #1 (v1) amount", pays[0]?.amount, 1250000n);
  check("watcher #2 (v1) amount", pays[1]?.amount, 750000n);
  check("watcher #3 (v2) amount", pays[2]?.amount, 1250000n);
  check("watcher #4 (v2) amount", pays[3]?.amount, 250000n);
}

console.log(failures === 0 ? "\nALL CHECKS PASSED" : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
