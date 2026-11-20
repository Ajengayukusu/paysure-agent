/**
 * PaySure Agent — Milestone 3a: GASLESS live payment on Aevum testnet.
 *
 * Flow:
 *   1. Owner (merchant) creates invoice #3: 0.75 tUSD8 to "Sari Bakery", expiry +7 days.
 *   2. Owner signs an EIP-3009 ReceiveWithAuthorization OFF-CHAIN (to = AgentInvoicePay,
 *      value = 750000, nonce = authorizationNonce(orderId) — bound to this one invoice).
 *   3. The AGENT wallet relays payInvoiceWithAuthorization (legacy tx) and pays the gas;
 *      the owner's funds move owner -> contract -> payee inside the session budget.
 *
 * Keys are read from ~/workspace/aevum-challenge/.wallet/{deployer,agent}.txt and are
 * NEVER printed, logged, or written anywhere by this script.
 */
import { readFileSync } from "node:fs";
import {
  createPublicClient,
  createWalletClient,
  defineChain,
  http,
  keccak256,
  parseSignature,
  toHex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";

const RPC = "https://rpc-test.qday.info";
const EXPLORER = "https://explorer-test.qday.info";
const TUSD8 = "0x456569838f1d43009A91ebA4263147Afd7233483";
const AGENT_INVOICE_PAY = "0x2D0ff19258d19d38F6352E8F565dF0BC3F7054ed";
const PAYEE = "0xA1A90bb88c3F0C12aEC9c1664DA3fAE2fAB88746";
const PAYEE_NAME = "Sari Bakery";
const AMOUNT = 750000n; // 0.75 tUSD8 (6 decimals)
const ORDER_ID = keccak256(toHex("paysure-invoice-3"));
const WALLET_DIR = `${process.env.HOME}/workspace/aevum-challenge/.wallet`;

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

const erc20Abi = [
  {
    type: "function",
    name: "balanceOf",
    stateMutability: "view",
    inputs: [{ name: "a", type: "address" }],
    outputs: [{ type: "uint256" }],
  },
];
const payAbi = [
  {
    type: "function",
    name: "createInvoice",
    stateMutability: "nonpayable",
    inputs: [
      { name: "orderId", type: "bytes32" },
      { name: "payeeName", type: "string" },
      { name: "payee", type: "address" },
      { name: "amount", type: "uint256" },
      { name: "expiry", type: "uint64" },
    ],
    outputs: [{ type: "bytes32" }],
  },
  {
    type: "function",
    name: "payInvoiceWithAuthorization",
    stateMutability: "nonpayable",
    inputs: [
      { name: "orderId", type: "bytes32" },
      { name: "amount", type: "uint256" },
      { name: "validAfter", type: "uint256" },
      { name: "validBefore", type: "uint256" },
      { name: "v", type: "uint8" },
      { name: "r", type: "bytes32" },
      { name: "s", type: "bytes32" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "authorizationNonce",
    stateMutability: "view",
    inputs: [{ name: "orderId", type: "bytes32" }],
    outputs: [{ type: "bytes32" }],
  },
  {
    type: "function",
    name: "invoiceOf",
    stateMutability: "view",
    inputs: [{ name: "orderId", type: "bytes32" }],
    outputs: [
      {
        type: "tuple",
        components: [
          { name: "merchant", type: "address" },
          { name: "payee", type: "address" },
          { name: "payeeName", type: "string" },
          { name: "amount", type: "uint256" },
          { name: "expiry", type: "uint64" },
          { name: "exists", type: "bool" },
        ],
      },
    ],
  },
  {
    type: "function",
    name: "isPaid",
    stateMutability: "view",
    inputs: [{ name: "orderId", type: "bytes32" }],
    outputs: [{ type: "bool" }],
  },
  {
    type: "function",
    name: "receiptOf",
    stateMutability: "view",
    inputs: [{ name: "orderId", type: "bytes32" }],
    outputs: [
      {
        type: "tuple",
        components: [
          { name: "payer", type: "address" },
          { name: "agent", type: "address" },
          { name: "payee", type: "address" },
          { name: "amount", type: "uint256" },
          { name: "paidAt", type: "uint64" },
          { name: "paid", type: "bool" },
        ],
      },
    ],
  },
];

const bal = (addr) =>
  publicClient.readContract({ address: TUSD8, abi: erc20Abi, functionName: "balanceOf", args: [addr] });

console.log(`orderId (invoice #3): ${ORDER_ID}`);
console.log(`owner/payer: ${owner.address}`);
console.log(`agent/relayer: ${agent.address}`);

const ownerBefore = await bal(owner.address);
const payeeBefore = await bal(PAYEE);
console.log(`balances BEFORE: owner=${ownerBefore} payee=${payeeBefore}`);

// ---- 1. Create invoice #3 (owner), unless it already exists
const existing = await publicClient.readContract({
  address: AGENT_INVOICE_PAY,
  abi: payAbi,
  functionName: "invoiceOf",
  args: [ORDER_ID],
});
let createTx = null;
if (existing.exists) {
  console.log("invoice #3 already exists on-chain — skipping creation");
} else {
  const latest = await publicClient.getBlock();
  const expiry = latest.timestamp + 7n * 24n * 3600n;
  createTx = await ownerWallet.writeContract({
    address: AGENT_INVOICE_PAY,
    abi: payAbi,
    functionName: "createInvoice",
    args: [ORDER_ID, PAYEE_NAME, PAYEE, AMOUNT, expiry],
    type: "legacy",
  });
  const rc = await publicClient.waitForTransactionReceipt({ hash: createTx });
  console.log(`invoice #3 created: tx ${createTx} (status ${rc.status}, block ${rc.blockNumber})`);
  console.log(`  ${EXPLORER}/tx/${createTx}`);
  console.log(`  expiry set to ${expiry} (chain time + 7 days)`);
}

// ---- 2. Owner signs EIP-3009 ReceiveWithAuthorization off-chain
const nonce = await publicClient.readContract({
  address: AGENT_INVOICE_PAY,
  abi: payAbi,
  functionName: "authorizationNonce",
  args: [ORDER_ID],
});
const now = (await publicClient.getBlock()).timestamp;
const validAfter = 0n;
const validBefore = now + 3600n; // 1-hour window, same as the M1 tests
const signature = await owner.signTypedData({
  domain: { name: "tUSD8", version: "2", chainId: 44005, verifyingContract: TUSD8 },
  types: {
    ReceiveWithAuthorization: [
      { name: "from", type: "address" },
      { name: "to", type: "address" },
      { name: "value", type: "uint256" },
      { name: "validAfter", type: "uint256" },
      { name: "validBefore", type: "uint256" },
      { name: "nonce", type: "bytes32" },
    ],
  },
  primaryType: "ReceiveWithAuthorization",
  message: {
    from: owner.address,
    to: AGENT_INVOICE_PAY,
    value: AMOUNT,
    validAfter,
    validBefore,
    nonce,
  },
});
const { r, s, v, yParity } = parseSignature(signature);
const vVal = v !== undefined ? Number(v) : 27 + (yParity ?? 0);
console.log(`owner signed ReceiveWithAuthorization (nonce ${nonce}, validBefore ${validBefore})`);

// ---- 3. Agent relays the gasless payment (legacy tx, agent pays gas)
const call = {
  address: AGENT_INVOICE_PAY,
  abi: payAbi,
  functionName: "payInvoiceWithAuthorization",
  args: [ORDER_ID, AMOUNT, validAfter, validBefore, vVal, r, s],
};
await publicClient.simulateContract({ ...call, account: agent });
console.log("simulation OK — submitting via agent wallet");
const payTx = await agentWallet.writeContract({ ...call, type: "legacy" });
const payRc = await publicClient.waitForTransactionReceipt({ hash: payTx });
console.log(`gasless pay: tx ${payTx} (status ${payRc.status}, block ${payRc.blockNumber})`);
console.log(`  ${EXPLORER}/tx/${payTx}`);

// ---- 4. Read back
const ownerAfter = await bal(owner.address);
const payeeAfter = await bal(PAYEE);
const isPaid = await publicClient.readContract({
  address: AGENT_INVOICE_PAY,
  abi: payAbi,
  functionName: "isPaid",
  args: [ORDER_ID],
});
const receipt = await publicClient.readContract({
  address: AGENT_INVOICE_PAY,
  abi: payAbi,
  functionName: "receiptOf",
  args: [ORDER_ID],
});
console.log(`balances AFTER: owner=${ownerAfter} payee=${payeeAfter}`);
console.log(`isPaid(#3): ${isPaid}`);
console.log(
  `receipt: payer=${receipt.payer} agent=${receipt.agent} payee=${receipt.payee} amount=${receipt.amount} paidAt=${receipt.paidAt} paid=${receipt.paid}`,
);
console.log(
  JSON.stringify({
    orderId: ORDER_ID,
    createTx,
    payTx,
    payBlock: payRc.blockNumber.toString(),
    ownerBefore: ownerBefore.toString(),
    ownerAfter: ownerAfter.toString(),
    payeeBefore: payeeBefore.toString(),
    payeeAfter: payeeAfter.toString(),
  }),
);
