/**
 * PaySure Agent — watcher + provable receipts.
 *
 * Polls eth_getLogs for AgentInvoicePay `Paid` events in chunks of at most
 * 1,000 blocks (the Aevum public RPC rejects wider ranges), starting at the
 * contract's deploy block. Dedupes by txHash:logIndex (idempotent rescans),
 * skips zero-value payments, and emits one receipt per payment with everything
 * a third party needs to verify it on the explorer: orderId, amount in base
 * units + decimals + token address, chainId, tx hash, log index, block,
 * payer, agent, payee, seen time, and a two-stage status:
 *   Seen     — the payment block is above the chain's finalized block
 *   Finalized — the payment block is at or below the finalized block
 * The finalized height comes from eth_getBlockByNumber("finalized"). If that
 * tag is unavailable, the script falls back to the latest block and SAYS SO
 * in its output (see `finalizedSource` in receipts.json and the summary).
 *
 * v2 note (21 Nov 2026): AgentInvoicePay v2 (per-payee cap) superseded v1.
 * The watcher scans BOTH contracts — each from its own deploy block — and
 * merges their payments into one receipt list; every receipt is tagged with
 * the contract address and version that produced it.
 *
 * No dependencies: plain JSON-RPC over fetch (Node 18+). Read-only.
 * Output: scripts/receipts.json + a human summary on stdout.
 */
import { writeFileSync } from "node:fs";

const RPC = "https://rpc-test.qday.info";
const EXPLORER = "https://explorer-test.qday.info";
const CHAIN_ID = 44005;
const TOKEN = "0x456569838f1d43009A91ebA4263147Afd7233483"; // tUSD8
const DECIMALS = 6;
const CONTRACTS = [
  {
    version: "v1",
    address: "0x2D0ff19258d19d38F6352E8F565dF0BC3F7054ed",
    deployTx: "0x65ecb6971cb508046539c7750111263dc96a955471d0b182e9fb38eeb6c119f5",
    fallbackStartBlock: 3640000,
  },
  {
    version: "v2",
    address: "0xeEBa81989B929F21354851a0F00F92239f5faCC8",
    deployTx: "0x8c4d7b31d456993532e9e63021dbf37bf7c852b215c4068f4c8ba89c5b3e4fd7",
    fallbackStartBlock: 3739911,
  },
];
const CHUNK = 1000; // RPC max range: 1,000 blocks per eth_getLogs call
// keccak256("Paid(bytes32,address,address,address,uint256)") — from AgentInvoicePay.sol
const PAID_TOPIC = "0x060bb954af967ecb7aa08a0072a7f8fe308ceee2f5d15f4a9d4a5275a5fe79e9";

let rpcId = 0;
async function rpc(method, params) {
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await fetch(RPC, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method, params }),
        signal: AbortSignal.timeout(20000),
      });
      const json = await res.json();
      if (json.error) throw new Error(`${method}: ${JSON.stringify(json.error)}`);
      return json.result;
    } catch (e) {
      if (attempt === 3) throw e;
      await new Promise((r) => setTimeout(r, 1000 * attempt));
    }
  }
}

const hex = (n) => "0x" + n.toString(16);
const topicToAddress = (t) => "0x" + t.slice(-40);
function formatUnits(raw, decimals) {
  const s = raw.toString().padStart(decimals + 1, "0");
  const int = s.slice(0, -decimals);
  const frac = s.slice(-decimals).replace(/0+$/, "");
  return frac ? `${int}.${frac}` : int;
}

// ---- heights
const latest = Number(BigInt(await rpc("eth_blockNumber", [])));
let finalizedBlock;
let finalizedSource;
try {
  const fb = await rpc("eth_getBlockByNumber", ["finalized", false]);
  if (!fb || !fb.number) throw new Error("finalized tag returned no block");
  finalizedBlock = Number(BigInt(fb.number));
  finalizedSource = 'eth_getBlockByNumber("finalized")';
} catch {
  finalizedBlock = latest;
  finalizedSource = "FALLBACK: finalized tag unavailable — latest block used as the finalized reference";
}

// ---- chunked scan of BOTH contracts, merged
const seen = new Map(); // `${contract}:${txHash}:${logIndex}` -> {log, contract}
let chunks = 0;
const contractScans = [];
for (const c of CONTRACTS) {
  let startBlock = c.fallbackStartBlock;
  try {
    const rc = await rpc("eth_getTransactionReceipt", [c.deployTx]);
    if (rc && rc.blockNumber) startBlock = Number(BigInt(rc.blockNumber));
  } catch {
    /* keep fallback */
  }
  contractScans.push({ ...c, startBlock });
  for (let from = startBlock; from <= latest; from += CHUNK) {
    const to = Math.min(from + CHUNK - 1, latest);
    const logs = await rpc("eth_getLogs", [
      { address: c.address, topics: [PAID_TOPIC], fromBlock: hex(from), toBlock: hex(to) },
    ]);
    chunks++;
    for (const log of logs) {
      const key = `${c.address}:${log.transactionHash}:${Number(BigInt(log.logIndex))}`;
      if (!seen.has(key)) seen.set(key, { log, contract: c });
    }
  }
}
const minStartBlock = Math.min(...contractScans.map((c) => c.startBlock));

// ---- build receipts
const receipts = [];
for (const { log, contract } of [...seen.values()].sort(
  (a, b) =>
    Number(BigInt(a.log.blockNumber)) - Number(BigInt(b.log.blockNumber)) ||
    Number(BigInt(a.log.logIndex)) - Number(BigInt(b.log.logIndex)),
)) {
  const blockNumber = Number(BigInt(log.blockNumber));
  const amount = BigInt("0x" + log.data.slice(66, 130));
  if (amount === 0n) continue; // skip zero-value payments
  const block = await rpc("eth_getBlockByNumber", [hex(blockNumber), false]);
  const seenAt = Number(BigInt(block.timestamp));
  receipts.push({
    orderId: log.topics[1],
    amount: amount.toString(),
    amountFormatted: formatUnits(amount, DECIMALS),
    decimals: DECIMALS,
    token: TOKEN,
    chainId: CHAIN_ID,
    contract: contract.address,
    contractVersion: contract.version,
    txHash: log.transactionHash,
    logIndex: Number(BigInt(log.logIndex)),
    blockNumber,
    payer: topicToAddress(log.topics[2]),
    agent: topicToAddress(log.topics[3]),
    payee: topicToAddress("0x" + log.data.slice(2, 66)),
    seenAt,
    seenAtISO: new Date(seenAt * 1000).toISOString(),
    status: blockNumber <= finalizedBlock ? "Finalized" : "Seen",
    explorerTx: `${EXPLORER}/tx/${log.transactionHash}`,
  });
}

const out = {
  generatedAt: new Date().toISOString(),
  chainId: CHAIN_ID,
  contracts: contractScans.map((c) => ({
    version: c.version,
    address: c.address,
    deployTx: c.deployTx,
    scannedFromBlock: c.startBlock,
  })),
  scannedFromBlock: minStartBlock,
  scannedToBlock: latest,
  chunks,
  finalizedBlock,
  finalizedSource,
  payments: receipts,
};
writeFileSync(new URL("./receipts.json", import.meta.url), JSON.stringify(out, null, 2) + "\n");

// ---- human summary
console.log("PaySure Agent — payment watcher (v1 + v2 contracts, merged)");
console.log(
  `scanned ${contractScans.map((c) => `${c.version} from block ${c.startBlock}`).join(", ")} .. ${latest} in ${chunks} chunk(s) of <=${CHUNK} blocks`,
);
console.log(`finalized block: ${finalizedBlock} (source: ${finalizedSource})`);
if (finalizedSource.startsWith("FALLBACK")) {
  console.log("NOTE: the RPC finalized tag was unavailable, so statuses were computed against the latest block instead.");
}
console.log(`found ${receipts.length} payment(s):`);
for (const r of receipts) {
  console.log(
    `- [${r.contractVersion}] order ${r.orderId.slice(0, 10)}… amount ${r.amountFormatted} tUSD8 (${r.amount} base units) payer ${r.payer.slice(0, 10)}… agent ${r.agent.slice(0, 10)}… payee ${r.payee.slice(0, 10)}… block ${r.blockNumber} status ${r.status}`,
  );
  console.log(`  tx ${r.txHash} (log ${r.logIndex}, seen ${r.seenAtISO}) ${r.explorerTx}`);
}
console.log("wrote scripts/receipts.json");
