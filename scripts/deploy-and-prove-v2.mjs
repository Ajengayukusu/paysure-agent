/**
 * PaySure Agent — v2 (21 Nov 2026): deploy AgentInvoicePay v2 (per-payee cap)
 * and produce the live proofs on Aevum testnet.
 *
 * What it does, in order (every step is guarded — re-running skips work that
 * is already on-chain, so the tUSD8 proof budget cannot be spent twice):
 *   1. Deploy AgentInvoicePay v2 wired to tUSD8 + the EXISTING PayeeRegistry
 *      (the registry is NOT redeployed; it holds the live "Sari Bakery" name).
 *      NOTE: the contract address is deterministic per run only via the saved
 *      state file scripts/.v2-deploy-state.json (gitignored, local only) — if a
 *      deploy already happened, the script reuses that address instead of
 *      deploying a second contract.
 *   2. Owner grants the agent a v2 session: per-tx cap 2, daily cap 3,
 *      per-payee cap 1.50 tUSD8/day, expiry +7 days; payee allowlisted.
 *   3. Owner approves the new contract for exactly the approve-path amount.
 *   4. Owner (merchant) creates invoices A 1.25, B 0.75, C 0.25 tUSD8.
 *   5. Agent pays A (1.25) via the approve path — success.
 *   6. Agent payment of B (0.75) is SIMULATED ONLY (eth_call): it must revert
 *      PerPayeeCapExceeded(750000, 1250000, 1500000) — 1.25 + 0.75 > 1.50
 *      per-payee cap. No failing transaction is broadcast; B stays unpaid.
 *   7. Invoice C (0.25) is paid GASLESS via EIP-3009 (owner signs off-chain,
 *      agent relays) — cumulative to the payee today lands exactly at 1.50.
 *   8. Final balances + session state are read back and printed as JSON.
 *
 * Keys are read from ~/workspace/aevum-challenge/.wallet/{deployer,agent}.txt
 * and are NEVER printed, logged, or written anywhere by this script.
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import {
  createPublicClient,
  createWalletClient,
  defineChain,
  http,
  keccak256,
  parseSignature,
  toHex,
  encodeFunctionData,
  decodeErrorResult,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";

const RPC = "https://rpc-test.qday.info";
const EXPLORER = "https://explorer-test.qday.info";
const TUSD8 = "0x456569838f1d43009A91ebA4263147Afd7233483";
const REGISTRY = "0x4A31fD9169E2DFaBB0763c1E8B38B24eC516780A";
const PAYEE = "0xA1A90bb88c3F0C12aEC9c1664DA3fAE2fAB88746";
const PAYEE_NAME = "Sari Bakery";
const PER_TX_CAP = 2000000n;
const DAILY_CAP = 3000000n;
const PER_PAYEE_CAP = 1500000n;
const INV_A = { id: keccak256(toHex("paysure-v2-invoice-1")), amount: 1250000n, label: "A" };
const INV_B = { id: keccak256(toHex("paysure-v2-invoice-2")), amount: 750000n, label: "B" };
const INV_C = { id: keccak256(toHex("paysure-v2-invoice-3")), amount: 250000n, label: "C" };
const WALLET_DIR = `${process.env.HOME}/workspace/aevum-challenge/.wallet`;
const STATE_FILE = new URL("./.v2-deploy-state.json", import.meta.url);

const aevum = defineChain({
  id: 44005,
  name: "QDay Aevum Testnet",
  nativeCurrency: { name: "tQDAY", symbol: "tQDAY", decimals: 18 },
  rpcUrls: { default: { http: [RPC] } },
  blockExplorers: { default: { name: "Aevum Explorer", url: EXPLORER } },
});

function loadKey(file) {
  const text = readFileSync(`${WALLET_DIR}/${file}`, "utf8");
  const m = text.match(/Private key:\s*(0x[0-9a-fA-F]{64})/);
  if (!m) throw new Error(`private key not found in ${file}`);
  return m[1];
}

const owner = privateKeyToAccount(loadKey("deployer.txt"));
const agent = privateKeyToAccount(loadKey("agent.txt"));
const publicClient = createPublicClient({ chain: aevum, transport: http(RPC) });
const ownerWallet = createWalletClient({ account: owner, chain: aevum, transport: http(RPC) });
const agentWallet = createWalletClient({ account: agent, chain: aevum, transport: http(RPC) });

const artifact = JSON.parse(
  readFileSync(new URL("../out/AgentInvoicePay.sol/AgentInvoicePay.json", import.meta.url), "utf8"),
);
const payAbi = artifact.abi;
const erc20Abi = [
  { type: "function", name: "balanceOf", stateMutability: "view", inputs: [{ name: "a", type: "address" }], outputs: [{ type: "uint256" }] },
  { type: "function", name: "approve", stateMutability: "nonpayable", inputs: [{ name: "spender", type: "address" }, { name: "amount", type: "uint256" }], outputs: [{ type: "bool" }] },
  { type: "function", name: "allowance", stateMutability: "view", inputs: [{ name: "o", type: "address" }, { name: "s", type: "address" }], outputs: [{ type: "uint256" }] },
];
const registryAbi = [
  { type: "function", name: "lookup", stateMutability: "view", inputs: [{ name: "name", type: "string" }], outputs: [{ type: "address" }, { type: "bool" }] },
];

const read = (address, functionName, args = []) =>
  publicClient.readContract({ address, abi: payAbi, functionName, args });
const bal = (addr) => publicClient.readContract({ address: TUSD8, abi: erc20Abi, functionName: "balanceOf", args: [addr] });
async function send(wallet, call, label) {
  const hash = await wallet.writeContract({ ...call, type: "legacy" });
  const rc = await publicClient.waitForTransactionReceipt({ hash });
  console.log(`${label}: tx ${hash} (status ${rc.status}, block ${rc.blockNumber})`);
  if (rc.status !== "success") throw new Error(`${label} reverted on-chain`);
  return { hash, block: rc.blockNumber };
}

const summary = { steps: {} };
console.log(`owner: ${owner.address}`);
console.log(`agent: ${agent.address}`);

// ---- 0. Sanity: registry still resolves "Sari Bakery" to the payee
const [resolved, registered] = await publicClient.readContract({
  address: REGISTRY, abi: registryAbi, functionName: "lookup", args: [PAYEE_NAME],
});
if (!registered || resolved.toLowerCase() !== PAYEE.toLowerCase()) {
  throw new Error(`registry lookup mismatch: registered=${registered} resolved=${resolved}`);
}
console.log(`registry: "${PAYEE_NAME}" -> ${resolved} ✓`);
const ownerBefore = await bal(owner.address);
const payeeBefore = await bal(PAYEE);
console.log(`balances BEFORE: owner=${ownerBefore} payee=${payeeBefore}`);

// ---- 1. Deploy (or reuse the address from a previous partial run)
let state = existsSync(STATE_FILE) ? JSON.parse(readFileSync(STATE_FILE, "utf8")) : {};
let CONTRACT = state.contract ?? null;
if (CONTRACT) {
  const code = await publicClient.getCode({ address: CONTRACT });
  if (!code || code === "0x") throw new Error(`state file names ${CONTRACT} but it has no code`);
  console.log(`reusing already-deployed v2 contract: ${CONTRACT}`);
} else {
  const hash = await ownerWallet.deployContract({
    abi: payAbi, bytecode: artifact.bytecode.object, args: [TUSD8, REGISTRY], type: "legacy",
  });
  const rc = await publicClient.waitForTransactionReceipt({ hash });
  if (rc.status !== "success" || !rc.contractAddress) throw new Error("deploy failed");
  CONTRACT = rc.contractAddress;
  state = { contract: CONTRACT, deployTx: hash, deployBlock: rc.blockNumber.toString() };
  writeFileSync(STATE_FILE, JSON.stringify(state, null, 2) + "\n");
  console.log(`deployed AgentInvoicePay v2: ${CONTRACT}`);
  console.log(`  deploy tx ${hash} (block ${rc.blockNumber}) ${EXPLORER}/tx/${hash}`);
}
summary.contract = CONTRACT;
summary.deployTx = state.deployTx;
summary.deployBlock = state.deployBlock;

// ---- 2. Grant the v2 session + allowlist the payee
const chainNow = (await publicClient.getBlock()).timestamp;
const session = await read(CONTRACT, "sessionOf", [agent.address]);
if (!(session.granted && !session.revoked && session.perPayeeCap === PER_PAYEE_CAP)) {
  summary.steps.grantSession = await send(ownerWallet, {
    address: CONTRACT, abi: payAbi, functionName: "grantSession",
    args: [agent.address, PER_TX_CAP, DAILY_CAP, PER_PAYEE_CAP, chainNow + 7n * 24n * 3600n],
  }, "grantSession (per-tx 2, daily 3, per-payee 1.50, +7d)");
} else console.log("session already granted with per-payee cap 1.50 — skipping");
const allowed = await read(CONTRACT, "payeeAllowed", [agent.address, PAYEE]);
if (!allowed) {
  summary.steps.setPayeeAllowed = await send(ownerWallet, {
    address: CONTRACT, abi: payAbi, functionName: "setPayeeAllowed", args: [agent.address, PAYEE, true],
  }, "setPayeeAllowed");
} else console.log("payee already allowlisted — skipping");

// ---- 3. Owner approves the new contract for the approve-path amount (invoice A)
const allowance = await publicClient.readContract({
  address: TUSD8, abi: erc20Abi, functionName: "allowance", args: [owner.address, CONTRACT],
});
if (allowance < INV_A.amount) {
  summary.steps.approve = await send(ownerWallet, {
    address: TUSD8, abi: erc20Abi, functionName: "approve", args: [CONTRACT, INV_A.amount],
  }, "approve tUSD8 for invoice A");
} else console.log("allowance already sufficient — skipping approve");

// ---- 4. Create invoices A, B, C (merchant = owner)
for (const inv of [INV_A, INV_B, INV_C]) {
  const existing = await read(CONTRACT, "invoiceOf", [inv.id]);
  if (existing.exists) { console.log(`invoice ${inv.label} already exists — skipping create`); continue; }
  const t = (await publicClient.getBlock()).timestamp;
  summary.steps[`create${inv.label}`] = await send(ownerWallet, {
    address: CONTRACT, abi: payAbi, functionName: "createInvoice",
    args: [inv.id, PAYEE_NAME, PAYEE, inv.amount, t + 7n * 24n * 3600n],
  }, `createInvoice ${inv.label} (${inv.amount})`);
}

// ---- 5. Agent pays invoice A via the approve path
if (await read(CONTRACT, "isPaid", [INV_A.id])) {
  console.log("invoice A already paid — skipping");
} else {
  const call = { address: CONTRACT, abi: payAbi, functionName: "payInvoice", args: [INV_A.id, INV_A.amount] };
  await publicClient.simulateContract({ ...call, account: agent });
  summary.steps.payA = await send(agentWallet, call, "payInvoice A (approve path, 1.25)");
}

// ---- 6. SIMULATE paying invoice B — must revert PerPayeeCapExceeded; never broadcast
const bPaid = await read(CONTRACT, "isPaid", [INV_B.id]);
if (bPaid) throw new Error("invoice B is PAID — the per-payee cap proof is invalid");
{
  const data = encodeFunctionData({ abi: payAbi, functionName: "payInvoice", args: [INV_B.id, INV_B.amount] });
  const res = await fetch(RPC, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_call",
      params: [{ from: agent.address, to: CONTRACT, data }, "latest"] }),
  }).then((r) => r.json());
  if (!res.error) throw new Error("invoice B simulation unexpectedly SUCCEEDED — cap not enforced");
  const errData = res.error.data;
  const decoded = decodeErrorResult({ abi: payAbi, data: typeof errData === "string" ? errData : errData?.data ?? errData });
  console.log(`invoice B simulation reverted as required: ${decoded.errorName}(${decoded.args.join(", ")})`);
  if (decoded.errorName !== "PerPayeeCapExceeded") throw new Error(`wrong revert: ${decoded.errorName}`);
  summary.steps.simulateB = {
    result: "reverted (eth_call simulation only — no transaction broadcast)",
    error: decoded.errorName,
    args: decoded.args.map((a) => a.toString()),
  };
}

// ---- 7. Gasless payment of invoice C via EIP-3009 (owner signs, agent relays)
if (await read(CONTRACT, "isPaid", [INV_C.id])) {
  console.log("invoice C already paid — skipping");
} else {
  const nonce = await read(CONTRACT, "authorizationNonce", [INV_C.id]);
  const now = (await publicClient.getBlock()).timestamp;
  const validAfter = 0n;
  const validBefore = now + 3600n;
  const signature = await owner.signTypedData({
    domain: { name: "tUSD8", version: "2", chainId: 44005, verifyingContract: TUSD8 },
    types: {
      ReceiveWithAuthorization: [
        { name: "from", type: "address" }, { name: "to", type: "address" },
        { name: "value", type: "uint256" }, { name: "validAfter", type: "uint256" },
        { name: "validBefore", type: "uint256" }, { name: "nonce", type: "bytes32" },
      ],
    },
    primaryType: "ReceiveWithAuthorization",
    message: { from: owner.address, to: CONTRACT, value: INV_C.amount, validAfter, validBefore, nonce },
  });
  const { r, s, v, yParity } = parseSignature(signature);
  const vVal = v !== undefined ? Number(v) : 27 + (yParity ?? 0);
  const call = {
    address: CONTRACT, abi: payAbi, functionName: "payInvoiceWithAuthorization",
    args: [INV_C.id, INV_C.amount, validAfter, validBefore, vVal, r, s],
  };
  await publicClient.simulateContract({ ...call, account: agent });
  summary.steps.payC = await send(agentWallet, call, "payInvoiceWithAuthorization C (gasless, 0.25)");
}

// ---- 8. Read back final state
const ownerAfter = await bal(owner.address);
const payeeAfter = await bal(PAYEE);
const s2 = await read(CONTRACT, "sessionOf", [agent.address]);
const spentToPayee = await read(CONTRACT, "spentToPayeeToday", [agent.address, PAYEE]);
summary.final = {
  ownerTusd8: ownerAfter.toString(),
  payeeTusd8: payeeAfter.toString(),
  isPaidA: await read(CONTRACT, "isPaid", [INV_A.id]),
  isPaidB: await read(CONTRACT, "isPaid", [INV_B.id]),
  isPaidC: await read(CONTRACT, "isPaid", [INV_C.id]),
  sessionSpentInDay: s2.spentInDay.toString(),
  spentToPayeeToday: spentToPayee.toString(),
  perPayeeCap: s2.perPayeeCap.toString(),
};
console.log(`balances AFTER: owner=${ownerAfter} payee=${payeeAfter}`);
console.log(`spentToPayeeToday(agent, payee) = ${spentToPayee} (cap ${PER_PAYEE_CAP})`);
console.log("SUMMARY " + JSON.stringify(summary, (k2, v2) => (typeof v2 === "bigint" ? v2.toString() : v2)));
