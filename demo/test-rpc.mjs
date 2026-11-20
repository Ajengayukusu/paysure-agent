/* Headless verification of the demo's RPC logic — imports the SAME
 * rpc-core.js the browser page uses, talks to the live Aevum RPC, and
 * asserts the known on-chain truth. Run: node test-rpc.mjs
 */
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const C = require("./rpc-core.js");

const RPC = "https://rpc-test.qday.info";
const CFG = {
  tusd8: "0x456569838f1d43009A91ebA4263147Afd7233483",
  registry: "0x4A31fD9169E2DFaBB0763c1E8B38B24eC516780A",
  invoicePay: "0x2D0ff19258d19d38F6352E8F565dF0BC3F7054ed",
  deployBlock: 3648858,
  owner: "0xB9bD942878724029740A491a1e238449748f8eAe",
  agent: "0x7D89Dc892b34Ec4b1e9d73E5D09A3601d0b8C382",
  payee: "0xA1A90bb88c3F0C12aEC9c1664DA3fAE2fAB88746",
  paidTopic: "0x060bb954af967ecb7aa08a0072a7f8fe308ceee2f5d15f4a9d4a5275a5fe79e9",
  inv1: "0x07671c88b5d222242921494fa102beecf542efc654c9152f83b39b05e2064dc9",
  inv2: "0xdd36fb6695f3f3b84380ed10701fc40a8f190a4c180cdacde783d3321f4cef8d",
  inv3: "0x107d685b386d19c3a39e05315cc271a698d90c0c8af1d202af1a95185a656603",
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

// invoices + receipts
async function invoice(orderId) {
  const res = await call(CFG.invoicePay, C.encodeCall("invoiceOf(bytes32)", [{ type: "bytes32", value: orderId }]));
  const w = C.words(res);
  const base = Number(C.wordToBigInt(w[0])); // dynamic tuple: offset word first
  const hw = C.words(res.slice(2 + base * 2));
  return { merchant: C.wordToAddress(hw[0]), payee: C.wordToAddress(hw[1]),
    payeeName: C.decodeStringAt(res, base + Number(C.wordToBigInt(hw[2]))),
    amount: C.wordToBigInt(hw[3]), expiry: C.wordToBigInt(hw[4]), exists: C.wordToBool(hw[5]) };
}
async function receipt(orderId) {
  const res = await call(CFG.invoicePay, C.encodeCall("receiptOf(bytes32)", [{ type: "bytes32", value: orderId }]));
  const w = C.words(res);
  return { payer: C.wordToAddress(w[0]), agent: C.wordToAddress(w[1]), payee: C.wordToAddress(w[2]),
    amount: C.wordToBigInt(w[3]), paidAt: C.wordToBigInt(w[4]), paid: C.wordToBool(w[5]) };
}
const i1 = await invoice(CFG.inv1), r1 = await receipt(CFG.inv1);
console.log("invoice#1:", JSON.stringify(i1, (k, v) => typeof v === "bigint" ? v.toString() : v));
check("invoice#1.amount", i1.amount, 1250000n);
check("invoice#1.payeeName", i1.payeeName, "Sari Bakery");
check("invoice#1.paid (receipt)", r1.paid, true);
check("receipt#1.amount", r1.amount, 1250000n);
check("receipt#1.agent", r1.agent, CFG.agent.toLowerCase());
check("receipt#1.paidAt", r1.paidAt, 1795164570n);
const i2 = await invoice(CFG.inv2), r2 = await receipt(CFG.inv2);
check("invoice#2.amount", i2.amount, 2500000n);
check("invoice#2.paid", r2.paid, false);
const r3 = await receipt(CFG.inv3);
check("invoice#3.paid (receipt)", r3.paid, true);
check("receipt#3.amount", r3.amount, 750000n);

// session
{
  const res = await call(CFG.invoicePay, C.encodeCall("sessionOf(address)", [{ type: "address", value: CFG.agent }]));
  const w = C.words(res);
  check("session.perTxCap", C.wordToBigInt(w[0]), 2000000n);
  check("session.dailyCap", C.wordToBigInt(w[1]), 3000000n);
  check("session.granted", C.wordToBool(w[3]), true);
  check("session.revoked", C.wordToBool(w[4]), false);
  check("session.spentInDay", C.wordToBigInt(w[6]), 2000000n);
  const resA = await call(CFG.invoicePay, C.encodeCall("payeeAllowed(address,address)",
    [{ type: "address", value: CFG.agent }, { type: "address", value: CFG.payee }]));
  check("payeeAllowed(agent,payee)", C.wordToBool(C.words(resA)[0]), true);
}

// balances
async function tusd8(who) {
  const res = await call(CFG.tusd8, C.encodeCall("balanceOf(address)", [{ type: "address", value: who }]));
  return C.wordToBigInt(C.words(res)[0]);
}
check("payee tUSD8 balance", await tusd8(CFG.payee), 2000000n);
check("owner tUSD8 balance", await tusd8(CFG.owner), 3000000n);
check("agent tUSD8 balance", await tusd8(CFG.agent), 0n);
const agentNative = BigInt(await rpc("eth_getBalance", [CFG.agent, "latest"]));
console.log(`agent tQDAY = ${C.fmtTQDAY(agentNative)} (raw wei ${agentNative})`);
check("agent tQDAY > 0", agentNative > 0n, true);

// watcher: chunked getLogs + dedupe
{
  const seen = new Map();
  for (let from = CFG.deployBlock; from <= latest; from += 1000) {
    const to = Math.min(from + 999, latest);
    const logs = await rpc("eth_getLogs", [{ address: CFG.invoicePay, topics: [CFG.paidTopic],
      fromBlock: "0x" + from.toString(16), toBlock: "0x" + to.toString(16) }]);
    for (const log of logs) {
      const key = log.transactionHash + ":" + C.hexToNum(log.logIndex);
      if (seen.has(key)) continue;
      const dw = C.words(log.data);
      const amount = C.wordToBigInt(dw[1]);
      if (amount === 0n) continue;
      seen.set(key, { orderId: log.topics[1], amount, block: C.hexToNum(log.blockNumber),
        tx: log.transactionHash, payee: C.wordToAddress(dw[0]),
        status: C.hexToNum(log.blockNumber) <= finalized ? "Finalized" : "Seen" });
    }
  }
  const pays = [...seen.values()].sort((a, b) => a.block - b.block);
  console.log("watcher payments:", pays.map(p => `${p.orderId.slice(0, 10)}… ${C.fmtTUSD8(p.amount)} tUSD8 block ${p.block} ${p.status} tx ${p.tx}`).join("\n  "));
  check("watcher payment count", pays.length, 2);
  check("watcher #1 amount", pays[0]?.amount, 1250000n);
  check("watcher #2 amount", pays[1]?.amount, 750000n);
}

console.log(failures === 0 ? "\nALL CHECKS PASSED" : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
