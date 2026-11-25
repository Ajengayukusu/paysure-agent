/* PaySure Agent demo — dependency-free Aevum JSON-RPC core.
 * Manual ABI encoding/decoding + a small pure-JS Keccak-256 (for function
 * selectors). Works in the browser (window.PaySureCore) and in Node
 * (module.exports) so the exact same logic can be verified headlessly.
 */
(function (global) {
  "use strict";

  // ---------------- Keccak-256 (Keccak-f[1600], rate 1088, suffix 0x01) ----
  var MASK64 = (1n << 64n) - 1n;
  var RC = [
    0x0000000000000001n, 0x0000000000008082n, 0x800000000000808an, 0x8000000080008000n,
    0x000000000000808bn, 0x0000000080000001n, 0x8000000080008081n, 0x8000000000008009n,
    0x000000000000008an, 0x0000000000000088n, 0x0000000080008009n, 0x000000008000000an,
    0x000000008000808bn, 0x800000000000008bn, 0x8000000000008089n, 0x8000000000008003n,
    0x8000000000008002n, 0x8000000000000080n, 0x000000000000800an, 0x800000008000000an,
    0x8000000080008081n, 0x8000000000008080n, 0x0000000080000001n, 0x8000000080008008n
  ];
  var RHO = [
    [0, 36, 3, 41, 18], [1, 44, 10, 45, 2], [62, 6, 43, 15, 61],
    [28, 55, 25, 21, 56], [27, 20, 39, 8, 14]
  ];
  function rotl(x, n) {
    if (n === 0) return x;
    var b = BigInt(n);
    return ((x << b) | (x >> (64n - b))) & MASK64;
  }
  function keccakF(state) {
    var B = new Array(25), C = new Array(5), D = new Array(5);
    for (var round = 0; round < 24; round++) {
      for (var x = 0; x < 5; x++)
        C[x] = state[x] ^ state[x + 5] ^ state[x + 10] ^ state[x + 15] ^ state[x + 20];
      for (x = 0; x < 5; x++) D[x] = C[(x + 4) % 5] ^ rotl(C[(x + 1) % 5], 1);
      for (x = 0; x < 5; x++) for (var y = 0; y < 5; y++) state[x + 5 * y] ^= D[x];
      for (x = 0; x < 5; x++) for (y = 0; y < 5; y++)
        B[y + 5 * ((2 * x + 3 * y) % 5)] = rotl(state[x + 5 * y], RHO[x][y]);
      for (x = 0; x < 5; x++) for (y = 0; y < 5; y++)
        state[x + 5 * y] = B[x + 5 * y] ^ ((~B[(x + 1) % 5 + 5 * y] & MASK64) & B[(x + 2) % 5 + 5 * y]);
      state[0] ^= RC[round];
    }
  }
  function keccak256(bytes) {
    var rate = 136, state = new Array(25).fill(0n);
    var padded = Array.prototype.slice.call(bytes);
    padded.push(0x01);
    while (padded.length % rate !== rate - 1) padded.push(0);
    padded.push(0x80);
    for (var off = 0; off < padded.length; off += rate) {
      for (var i = 0; i < rate / 8; i++) {
        var lane = 0n;
        for (var j = 7; j >= 0; j--) lane = (lane << 8n) | BigInt(padded[off + i * 8 + j]);
        state[i] ^= lane;
      }
      keccakF(state);
    }
    var out = [];
    for (i = 0; i < 4; i++) {
      var v = state[i];
      for (j = 0; j < 8; j++) { out.push(Number(v & 0xffn)); v >>= 8n; }
    }
    return out;
  }
  function bytesToHex(bytes) {
    return "0x" + bytes.map(function (b) { return b.toString(16).padStart(2, "0"); }).join("");
  }
  function utf8Bytes(str) {
    if (typeof TextEncoder !== "undefined") return Array.from(new TextEncoder().encode(str));
    var out = [];
    for (var i = 0; i < str.length; i++) {
      var c = str.charCodeAt(i);
      if (c < 0x80) out.push(c);
      else if (c < 0x800) { out.push(0xc0 | (c >> 6), 0x80 | (c & 63)); }
      else { out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63)); }
    }
    return out;
  }
  function selector(signature) {
    return bytesToHex(keccak256(utf8Bytes(signature)).slice(0, 4));
  }

  // ---------------- ABI encode --------------------------------------------
  function wordFromBigInt(v) { return v.toString(16).padStart(64, "0"); }
  function wordFromAddress(addr) { return "0".repeat(24) + addr.toLowerCase().replace(/^0x/, ""); }
  function encodeCall(sig, args) {
    // args: array of {type, value}; supports address, bytes32, uint256, uint64, string, bool
    var head = "", tail = "", headBytes = args.length * 32;
    args.forEach(function (a) {
      if (a.type === "address") head += wordFromAddress(a.value);
      else if (a.type === "bytes32") head += a.value.toLowerCase().replace(/^0x/, "").padStart(64, "0");
      else if (a.type === "uint256" || a.type === "uint64") head += wordFromBigInt(BigInt(a.value));
      else if (a.type === "bool") head += wordFromBigInt(a.value ? 1n : 0n);
      else if (a.type === "string") {
        head += wordFromBigInt(BigInt(headBytes + tail.length / 2));
        var b = utf8Bytes(a.value);
        var dataHex = b.map(function (x) { return x.toString(16).padStart(2, "0"); }).join("");
        dataHex = dataHex.padEnd(Math.ceil(b.length / 32) * 64, "0");
        tail += wordFromBigInt(BigInt(b.length)) + dataHex;
      } else throw new Error("unsupported arg type " + a.type);
    });
    return selector(sig) + head + tail;
  }

  // ---------------- ABI decode --------------------------------------------
  function words(hex) {
    var h = hex.replace(/^0x/, "");
    var out = [];
    for (var i = 0; i + 64 <= h.length; i += 64) out.push(h.slice(i, i + 64));
    return out;
  }
  function wordToBigInt(w) { return BigInt("0x" + w); }
  function wordToAddress(w) { return "0x" + w.slice(24).toLowerCase(); }
  function wordToBool(w) { return BigInt("0x" + w) !== 0n; }
  function decodeStringAt(hex, byteOffset) {
    var h = hex.replace(/^0x/, "");
    var len = Number(BigInt("0x" + h.slice(byteOffset * 2, byteOffset * 2 + 64)));
    var dataHex = h.slice(byteOffset * 2 + 64, byteOffset * 2 + 64 + len * 2);
    var bytes = [];
    for (var i = 0; i < dataHex.length; i += 2) bytes.push(parseInt(dataHex.slice(i, i + 2), 16));
    if (typeof TextDecoder !== "undefined") return new TextDecoder().decode(new Uint8Array(bytes));
    return decodeURIComponent(bytes.map(function (b) { return "%" + b.toString(16).padStart(2, "0"); }).join(""));
  }

  // ---------------- Formatting ---------------------------------------------
  function fmtUnits(raw, decimals, minFrac) {
    var v = BigInt(raw), base = 10n ** BigInt(decimals);
    var whole = v / base, frac = (v % base).toString().padStart(decimals, "0");
    frac = frac.replace(/0+$/, "");
    if (frac.length < (minFrac || 2)) frac = frac.padEnd(minFrac || 2, "0");
    return whole.toString() + "." + frac;
  }
  function fmtTUSD8(raw) { return fmtUnits(raw, 6, 2); }
  // Parse a human decimal string ("1.25") into base units (1250000n at 6 dp).
  // String-only math — no floats, so no rounding surprises. Throws on junk.
  function parseUnits(str, decimals) {
    var s = String(str).trim();
    if (!/^\d+(\.\d+)?$/.test(s)) throw new Error("not a valid amount: " + str);
    var parts = s.split("."), whole = parts[0], frac = parts[1] || "";
    if (frac.length > decimals) throw new Error("too many decimal places (max " + decimals + ")");
    frac = frac.padEnd(decimals, "0");
    return BigInt(whole) * (10n ** BigInt(decimals)) + BigInt(frac || "0");
  }
  function fmtTQDAY(wei) { return fmtUnits(wei, 18, 4); }
  function fmtTime(unixSeconds) {
    var n = Number(unixSeconds);
    if (!n) return "—";
    return new Date(n * 1000).toISOString().replace("T", " ").replace(".000Z", " UTC");
  }
  function shortAddr(a) { return a ? a.slice(0, 6) + "…" + a.slice(-4) : "—"; }
  function hexToNum(hex) { return Number(BigInt(hex)); }

  var api = {
    keccak256: keccak256, bytesToHex: bytesToHex, utf8Bytes: utf8Bytes, selector: selector,
    encodeCall: encodeCall, words: words, wordToBigInt: wordToBigInt,
    wordToAddress: wordToAddress, wordToBool: wordToBool, decodeStringAt: decodeStringAt,
    fmtUnits: fmtUnits, fmtTUSD8: fmtTUSD8, fmtTQDAY: fmtTQDAY, fmtTime: fmtTime, parseUnits: parseUnits,
    shortAddr: shortAddr, hexToNum: hexToNum
  };
  global.PaySureCore = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof window !== "undefined" ? window : globalThis);
