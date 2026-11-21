/* PaySure Agent demo — all values are read LIVE from the Aevum testnet
 * via plain JSON-RPC (eth_call / eth_getLogs / eth_getBalance). No libraries.
 */
(function () {
  "use strict";
  var C = window.PaySureCore;

  // ---- Live config (addresses + order ids only; every value is read live) --
  // v2 (21 Nov 2026) is the current AgentInvoicePay — it added the per-payee
  // session cap. v1 is superseded; its invoices and payments stay on-chain and
  // are still shown (labelled v1) so the full evidence trail remains visible.
  var V1 = "0x2D0ff19258d19d38F6352E8F565dF0BC3F7054ed";
  var V2 = "0xeEBa81989B929F21354851a0F00F92239f5faCC8";
  var CONFIG = {
    rpc: "https://rpc-test.qday.info",
    explorer: "https://explorer-test.qday.info",
    chainId: 44005,
    chainName: "QDay Aevum Testnet",
    tusd8: "0x456569838f1d43009A91ebA4263147Afd7233483",
    registry: "0x4A31fD9169E2DFaBB0763c1E8B38B24eC516780A",
    invoicePay: V2,
    invoicePayV1: V1,
    deployBlock: 3739911, // v2 deploy block (receipts scan starts here for v2)
    deployBlockV1: 3648858,
    owner: "0xB9bD942878724029740A491a1e238449748f8eAe",
    agent: "0x7D89Dc892b34Ec4b1e9d73E5D09A3601d0b8C382",
    payee: "0xA1A90bb88c3F0C12aEC9c1664DA3fAE2fAB88746",
    payeeName: "Sari Bakery",
    paidTopic: "0x060bb954af967ecb7aa08a0072a7f8fe308ceee2f5d15f4a9d4a5275a5fe79e9",
    invoices: [
      { v: "v2", n: 1, contract: V2, orderId: "0x7ba5bd9052fda0850c42149a35efe5e7b24ad274a4434755cda690c3280a04aa", note: "v2 · Paid by the agent (approve path)" },
      { v: "v2", n: 2, contract: V2, orderId: "0x75867a4071dd3a1d56ff22183e5b222f5cdf3c4011ff5aabf202af4e8fc2e22c", note: "v2 · Blocked by the per-payee cap: 1.25 already paid today + 0.75 would exceed the 1.50 tUSD8/day per-payee cap" },
      { v: "v2", n: 3, contract: V2, orderId: "0x87ce7fb2e9983c50b39eae06eb8d794d72b2e0bdff76860aa673b78d5e729ca9", note: "v2 · Paid gasless (EIP-3009) — lands exactly at the per-payee cap" },
      { v: "v1", n: 1, contract: V1, orderId: "0x07671c88b5d222242921494fa102beecf542efc654c9152f83b39b05e2064dc9", note: "v1 · Paid by the agent (approve path)" },
      { v: "v1", n: 2, contract: V1, orderId: "0xdd36fb6695f3f3b84380ed10701fc40a8f190a4c180cdacde783d3321f4cef8d", note: "v1 · Created as the over-cap proof (per-transaction cap)" },
      { v: "v1", n: 3, contract: V1, orderId: "0x107d685b386d19c3a39e05315cc271a698d90c0c8af1d202af1a95185a656603", note: "v1 · Paid gasless (EIP-3009 signature, relayed by the agent)" }
    ]
  };

  var state = { latest: 0, finalized: 0, session: null, spentToPayee: 0n, invoices: [], wallet: null };

  function $(id) { return document.getElementById(id); }
  function esc(s) {
    return String(s).replace(/[&<>"']/g, function (ch) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch];
    });
  }
  function addrLink(a) {
    return '<a href="' + CONFIG.explorer + "/address/" + a + '" target="_blank" rel="noopener" class="mono">' +
      esc(C.shortAddr(a)) + "</a>";
  }
  function txLink(h) {
    return '<a href="' + CONFIG.explorer + "/tx/" + h + '" target="_blank" rel="noopener" class="mono">' +
      esc(h.slice(0, 10)) + "…" + esc(h.slice(-6)) + "</a>";
  }

  // ---- JSON-RPC ------------------------------------------------------------
  var rpcId = 0;
  function rpc(method, params) {
    return fetch(CONFIG.rpc, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method: method, params: params })
    }).then(function (r) {
      if (!r.ok) throw new Error("RPC HTTP " + r.status);
      return r.json();
    }).then(function (j) {
      if (j.error) throw new Error("RPC error: " + (j.error.message || JSON.stringify(j.error)));
      return j.result;
    });
  }
  function ethCall(to, data) { return rpc("eth_call", [{ to: to, data: data }, "latest"]); }
  function blockNumber(tag) {
    if (tag === "latest") return rpc("eth_blockNumber", []).then(C.hexToNum);
    return rpc("eth_getBlockByNumber", [tag, false]).then(function (b) {
      if (!b) throw new Error("no " + tag + " block");
      return C.hexToNum(b.number);
    });
  }
  function blockTimestamp(n) {
    return rpc("eth_getBlockByNumber", ["0x" + n.toString(16), false]).then(function (b) {
      return b ? C.hexToNum(b.timestamp) : 0;
    });
  }

  // ---- Contract reads --------------------------------------------------------
  function lookupPayee(name) {
    var data = C.encodeCall("lookup(string)", [{ type: "string", value: name }]);
    return ethCall(CONFIG.registry, data).then(function (res) {
      var w = C.words(res);
      return { address: C.wordToAddress(w[0]), registered: C.wordToBool(w[1]) };
    });
  }
  function invoiceOf(orderId, contract) {
    var data = C.encodeCall("invoiceOf(bytes32)", [{ type: "bytes32", value: orderId }]);
    return ethCall(contract || CONFIG.invoicePay, data).then(function (res) {
      // Invoice contains a string, so the returned tuple is dynamic: word 0 is
      // the tuple offset, the struct head follows, and the string offset is
      // relative to the struct start.
      var w = C.words(res);
      var base = Number(C.wordToBigInt(w[0]));
      var hw = C.words(res.slice(2 + base * 2));
      return {
        merchant: C.wordToAddress(hw[0]),
        payee: C.wordToAddress(hw[1]),
        payeeName: C.decodeStringAt(res, base + Number(C.wordToBigInt(hw[2]))),
        amount: C.wordToBigInt(hw[3]),
        expiry: C.wordToBigInt(hw[4]),
        exists: C.wordToBool(hw[5])
      };
    });
  }
  function receiptOf(orderId, contract) {
    var data = C.encodeCall("receiptOf(bytes32)", [{ type: "bytes32", value: orderId }]);
    return ethCall(contract || CONFIG.invoicePay, data).then(function (res) {
      var w = C.words(res);
      return {
        payer: C.wordToAddress(w[0]), agent: C.wordToAddress(w[1]), payee: C.wordToAddress(w[2]),
        amount: C.wordToBigInt(w[3]), paidAt: C.wordToBigInt(w[4]), paid: C.wordToBool(w[5])
      };
    });
  }
  function sessionOf(agent, contract) {
    var data = C.encodeCall("sessionOf(address)", [{ type: "address", value: agent }]);
    return ethCall(contract || CONFIG.invoicePay, data).then(function (res) {
      var w = C.words(res);
      return {
        perTxCap: C.wordToBigInt(w[0]), dailyCap: C.wordToBigInt(w[1]), expiresAt: C.wordToBigInt(w[2]),
        granted: C.wordToBool(w[3]), revoked: C.wordToBool(w[4]),
        dayIndex: C.wordToBigInt(w[5]), spentInDay: C.wordToBigInt(w[6]),
        perPayeeCap: w.length > 7 ? C.wordToBigInt(w[7]) : 0n // v2 field; v1 returns 7 words
      };
    });
  }
  function spentToPayeeToday(agent, payee) {
    var data = C.encodeCall("spentToPayeeToday(address,address)",
      [{ type: "address", value: agent }, { type: "address", value: payee }]);
    return ethCall(CONFIG.invoicePay, data).then(function (res) { return C.wordToBigInt(C.words(res)[0]); });
  }
  function payeeAllowed(agent, payee) {
    var data = C.encodeCall("payeeAllowed(address,address)",
      [{ type: "address", value: agent }, { type: "address", value: payee }]);
    return ethCall(CONFIG.invoicePay, data).then(function (res) { return C.wordToBool(C.words(res)[0]); });
  }
  function tusd8Balance(who) {
    var data = C.encodeCall("balanceOf(address)", [{ type: "address", value: who }]);
    return ethCall(CONFIG.tusd8, data).then(function (res) { return C.wordToBigInt(C.words(res)[0]); });
  }
  function nativeBalance(who) {
    return rpc("eth_getBalance", [who, "latest"]).then(function (h) { return BigInt(h); });
  }

  // ---- Sections --------------------------------------------------------------
  function loadChainStatus() {
    return Promise.all([blockNumber("latest"), blockNumber("finalized")]).then(function (r) {
      state.latest = r[0]; state.finalized = r[1];
      $("chain-dot").className = "dot dot-ok";
      $("chain-text").textContent =
        "Live · latest block " + state.latest.toLocaleString("en-US") +
        " · finalized block " + state.finalized.toLocaleString("en-US") + " · chain " + CONFIG.chainId;
    }).catch(function (e) {
      $("chain-dot").className = "dot dot-err";
      $("chain-text").textContent = "Could not reach the Aevum RPC. Check your connection and press Refresh.";
      throw e;
    });
  }

  function loadPayee(name) {
    var box = $("payee-result");
    box.innerHTML = '<p class="loading">Looking up “' + esc(name) + '” in the registry…</p>';
    return lookupPayee(name).then(function (r) {
      if (r.registered) {
        box.innerHTML =
          '<p class="kv"><b>' + esc(name) + "</b> is registered.</p>" +
          '<p class="kv">Pays to: <span class="mono">' + esc(r.address) + "</span> " +
          '<a href="' + CONFIG.explorer + "/address/" + r.address + '" target="_blank" rel="noopener">explorer</a></p>' +
          '<p class="kv">Payments may only go to this address for this name.</p>';
      } else {
        box.innerHTML =
          '<p class="kv"><b>' + esc(name) + "</b> is <b>not registered</b>.</p>" +
          '<p class="kv">An invoice for an unregistered name cannot be created or paid.</p>';
      }
    }).catch(function (e) {
      box.innerHTML = '<p class="err">Lookup failed: ' + esc(e.message) + "</p>";
    });
  }

  function invoiceCard(inv, receipt, session) {
    var status = receipt.paid
      ? '<span class="badge badge-paid">Paid</span>'
      : '<span class="badge badge-unpaid">Unpaid</span>';
    var html = '<div class="invoice"><h3>Invoice ' + inv.v + " #" + inv.n + " " + status + "</h3>" +
      '<p class="kv">Amount: <b>' + C.fmtTUSD8(inv.data.amount) + " tUSD8</b></p>" +
      '<p class="kv">Payee: ' + esc(inv.data.payeeName) + " · " + addrLink(inv.data.payee) + "</p>" +
      '<p class="kv">Merchant: ' + addrLink(inv.data.merchant) + "</p>" +
      '<p class="kv">Expires: ' + C.fmtTime(inv.data.expiry) + "</p>" +
      '<p class="kv">Order ID: <span class="mono">' + esc(inv.orderId.slice(0, 14)) + "…" + esc(inv.orderId.slice(-6)) + "</span></p>";
    if (receipt.paid) {
      html += '<p class="kv">Paid at: ' + C.fmtTime(receipt.paidAt) + "</p>" +
        '<p class="kv">Paid by agent: ' + addrLink(receipt.agent) + "</p>" +
        '<p class="kv">Funds from: ' + addrLink(receipt.payer) + "</p>";
    } else if (session && inv.data.amount > session.perTxCap) {
      html += '<div class="warn">Cannot be paid by the agent: the amount (' + C.fmtTUSD8(inv.data.amount) +
        " tUSD8) is above the session per-transaction cap (" + C.fmtTUSD8(session.perTxCap) +
        " tUSD8). On-chain, this payment reverts with PerTxCapExceeded.</div>";
    } else if (inv.v === "v2" && session && session.perPayeeCap > 0n &&
               state.spentToPayee + inv.data.amount > session.perPayeeCap) {
      html += '<div class="warn">Cannot be paid today: the agent already paid ' + C.fmtTUSD8(state.spentToPayee) +
        " tUSD8 to this payee today, and the session per-payee cap is " + C.fmtTUSD8(session.perPayeeCap) +
        " tUSD8/day. On-chain, this payment reverts with PerPayeeCapExceeded.</div>";
    }
    html += '<p class="kv hint">' + esc(inv.note) + "</p></div>";
    return html;
  }

  function loadInvoices(session) {
    var jobs = CONFIG.invoices.map(function (inv) {
      return Promise.all([invoiceOf(inv.orderId, inv.contract), receiptOf(inv.orderId, inv.contract)]).then(function (r) {
        return { v: inv.v, n: inv.n, contract: inv.contract, orderId: inv.orderId, note: inv.note, data: r[0], receipt: r[1] };
      });
    });
    return Promise.all(jobs).then(function (list) {
      state.invoices = list;
      $("invoices").innerHTML = list.map(function (x) { return invoiceCard(x, x.receipt, session); }).join("");
      renderPayPanel();
    }).catch(function (e) {
      $("invoices").innerHTML = '<p class="err">Could not load invoices: ' + esc(e.message) + "</p>";
    });
  }

  function loadSession() {
    return Promise.all([
      sessionOf(CONFIG.agent), payeeAllowed(CONFIG.agent, CONFIG.payee),
      spentToPayeeToday(CONFIG.agent, CONFIG.payee)
    ]).then(function (r) {
      var s = r[0]; state.session = s; state.spentToPayee = r[2];
      var status = !s.granted ? "Not granted" : s.revoked ? "Revoked" : "Active";
      $("session").innerHTML =
        "<table>" +
        "<tr><th>Agent</th><td>" + addrLink(CONFIG.agent) + "</td></tr>" +
        "<tr><th>Status</th><td>" + status + " · contract v2 (per-payee cap)</td></tr>" +
        "<tr><th>Per-transaction cap</th><td>" + C.fmtTUSD8(s.perTxCap) + " tUSD8</td></tr>" +
        "<tr><th>Daily cap</th><td>" + C.fmtTUSD8(s.dailyCap) + " tUSD8</td></tr>" +
        "<tr><th>Per-payee cap (v2)</th><td>" + (s.perPayeeCap > 0n ? C.fmtTUSD8(s.perPayeeCap) + " tUSD8 / day" : "Disabled") + "</td></tr>" +
        "<tr><th>Spent in current day</th><td>" + C.fmtTUSD8(s.spentInDay) + " tUSD8</td></tr>" +
        "<tr><th>Spent to “" + esc(CONFIG.payeeName) + "” today</th><td>" + C.fmtTUSD8(r[2]) + " tUSD8</td></tr>" +
        "<tr><th>Session expires</th><td>" + C.fmtTime(s.expiresAt) + "</td></tr>" +
        "<tr><th>“" + esc(CONFIG.payeeName) + "” on allowlist</th><td>" + (r[1] ? "Yes" : "No") + "</td></tr>" +
        "</table>";
      return s;
    }).catch(function (e) {
      $("session").innerHTML = '<p class="err">Could not load the session: ' + esc(e.message) + "</p>";
      return null;
    });
  }

  function loadBalances() {
    return Promise.all([
      tusd8Balance(CONFIG.owner), tusd8Balance(CONFIG.agent), tusd8Balance(CONFIG.payee),
      nativeBalance(CONFIG.agent), nativeBalance(CONFIG.owner)
    ]).then(function (b) {
      $("balances").innerHTML =
        "<table>" +
        "<tr><th>Owner / merchant</th><td>" + C.fmtTUSD8(b[0]) + " tUSD8 · " + C.fmtTQDAY(b[4]) + " tQDAY</td></tr>" +
        "<tr><th>Agent</th><td>" + C.fmtTUSD8(b[1]) + " tUSD8 · " + C.fmtTQDAY(b[3]) + " tQDAY</td></tr>" +
        "<tr><th>Payee — " + esc(CONFIG.payeeName) + "</th><td>" + C.fmtTUSD8(b[2]) + " tUSD8</td></tr>" +
        "</table>" +
        '<p class="hint">The agent holds no tUSD8: it pays out of the owner’s balance, inside the session caps above.</p>';
    }).catch(function (e) {
      $("balances").innerHTML = '<p class="err">Could not load balances: ' + esc(e.message) + "</p>";
    });
  }

  // ---- Watcher: Paid events from BOTH contracts (v1 + v2), chunked ≤1000
  // ---- blocks, dedupe per contract+tx+logIndex, merged, Seen/Finalized -----
  function scanPayments() {
    var targets = [
      { v: "v1", address: CONFIG.invoicePayV1, from: CONFIG.deployBlockV1 },
      { v: "v2", address: CONFIG.invoicePay, from: CONFIG.deployBlock }
    ];
    var jobs = [];
    targets.forEach(function (t) {
      var from = t.from;
      while (from <= state.latest) {
        var to = Math.min(from + 999, state.latest);
        jobs.push({ v: t.v, address: t.address, from: from, to: to });
        from = to + 1;
      }
    });
    var seen = {}, payments = [];
    var chain = Promise.resolve();
    jobs.forEach(function (job) {
      chain = chain.then(function () {
        return rpc("eth_getLogs", [{
          address: job.address, topics: [CONFIG.paidTopic],
          fromBlock: "0x" + job.from.toString(16), toBlock: "0x" + job.to.toString(16)
        }]).then(function (logs) {
          logs.forEach(function (log) {
            var key = job.address + ":" + log.transactionHash + ":" + C.hexToNum(log.logIndex);
            if (seen[key]) return; seen[key] = true;
            var dw = C.words(log.data);
            var amount = C.wordToBigInt(dw[1]);
            if (amount === 0n) return; // zero-value events are not payments
            payments.push({
              v: job.v,
              orderId: log.topics[1], payer: C.wordToAddress(log.topics[2]),
              agent: C.wordToAddress(log.topics[3]), payee: C.wordToAddress(dw[0]),
              amount: amount, txHash: log.transactionHash,
              block: C.hexToNum(log.blockNumber), logIndex: C.hexToNum(log.logIndex)
            });
          });
        });
      });
    });
    return chain.then(function () {
      payments.sort(function (a, b) { return a.block - b.block || a.logIndex - b.logIndex; });
      return Promise.all(payments.map(function (p) {
        return blockTimestamp(p.block).then(function (ts) { p.seenAt = ts; return p; });
      }));
    });
  }

  function loadReceipts() {
    return scanPayments().then(function (payments) {
      if (!payments.length) {
        $("receipts").innerHTML = "<p>No payments found yet.</p>"; return;
      }
      $("receipts").innerHTML = payments.map(function (p) {
        var fin = p.block <= state.finalized;
        return '<div class="receipt">' +
          '<p class="kv"><b>' + C.fmtTUSD8(p.amount) + " tUSD8</b> · contract " + p.v + " · order <span class=\"mono\">" +
          esc(p.orderId.slice(0, 14)) + "…" + esc(p.orderId.slice(-6)) + "</span> " +
          '<span class="badge ' + (fin ? "badge-final" : "badge-seen") + '">' + (fin ? "Finalized" : "Seen") + "</span></p>" +
          '<p class="kv">Payee: ' + addrLink(p.payee) + " · Agent: " + addrLink(p.agent) + "</p>" +
          '<p class="kv">Block ' + p.block.toLocaleString("en-US") + " · " + C.fmtTime(p.seenAt) +
          " · Tx " + txLink(p.txHash) + "</p></div>";
      }).join("");
    }).catch(function (e) {
      $("receipts").innerHTML = '<p class="err">Watcher failed: ' + esc(e.message) + "</p>";
    });
  }

  // ---- Try it live: writes via the visitor's own wallet (EIP-1193) --------
  // This page never holds a key: calldata is built locally with the same
  // pure-JS ABI encoder as the reads, and the visitor's wallet signs/sends.
  var REVERT_REASONS = [
    ["NameTaken(bytes32)", "That name is already registered — a registered name can never be taken over."],
    ["SelfRegisterOnlyOwnAddress()", "You can only register a name for your own wallet address."],
    ["NameNotRegistered(bytes32)", "That name is not registered."],
    ["NotRegistrant(bytes32)", "Only the name's registrant (or the registry owner) can change it."],
    ["EmptyName()", "The name is empty."],
    ["PayeeNotRegistered(string)", "That payee name is not registered, so no invoice can be created or paid for it."],
    ["PayeeMismatch(string,address,address)", "The name now resolves to a different address — payment is blocked instead of paying the wrong address."],
    ["InvoiceExists(bytes32)", "An invoice with this order ID already exists."],
    ["InvoiceAlreadyPaid(bytes32)", "This invoice is already paid."],
    ["InvoiceExpired(bytes32)", "This invoice has expired."],
    ["InvalidAmount()", "The amount is invalid (zero, or the session caps are inconsistent)."],
    ["InvalidExpiry()", "The expiry must be in the future."],
    ["AmountMismatch(uint256,uint256)", "The amount must equal the invoice amount exactly — under- and over-payment both revert."],
    ["NoSession(address)", "This wallet holds no agent session, so it cannot pay invoices."],
    ["SessionRevokedErr(address)", "This wallet's session has been revoked by the owner."],
    ["SessionExpired(address)", "This wallet's session has expired."],
    ["PerTxCapExceeded(uint256,uint256)", "That payment is above the session's per-transaction cap."],
    ["DailyCapExceeded(uint256,uint256,uint256)", "That payment would exceed the session's daily cap."],
    ["PerPayeeCapExceeded(uint256,uint256,uint256)", "That payment would exceed the session's per-payee cap for today."],
    ["PayeeNotAllowed(address,address)", "This payee is not on the session's allowlist."],
    ["ERC20InsufficientAllowance(address,uint256,uint256)", "The owner has not approved this contract to spend enough tUSD8 for that payment."],
    ["ERC20InsufficientBalance(address,uint256,uint256)", "The paying account does not hold enough tUSD8."],
    ["ZeroAddress()", "A zero address was supplied."]
  ];
  function plainRevert(data) {
    if (typeof data === "string" && data.length >= 10) {
      var sel = data.slice(0, 10).toLowerCase();
      for (var i = 0; i < REVERT_REASONS.length; i++) {
        if (C.selector(REVERT_REASONS[i][0]).toLowerCase() === sel) return REVERT_REASONS[i][1];
      }
    }
    return "The contract rejected this transaction (revert). Check the values and try again.";
  }
  function errorData(e) {
    var d = e && (e.data || (e.error && e.error.data) || (e.cause && e.cause.data));
    if (d && typeof d === "object") d = d.data || d.originalError && d.originalError.data;
    return typeof d === "string" ? d : null;
  }
  function provider() { return (typeof window !== "undefined" && window.ethereum) || null; }
  function prequest(method, params) {
    var p = provider();
    if (!p) return Promise.reject(new Error("no wallet"));
    return p.request({ method: method, params: params });
  }
  function chainIdHex() { return "0x" + CONFIG.chainId.toString(16); }

  function walletEthCall(to, data) {
    return prequest("eth_call", [{ from: state.wallet, to: to, data: data }, "latest"]);
  }
  function waitForReceipt(hash) {
    return rpc("eth_getTransactionReceipt", [hash]).then(function (rc) {
      if (rc) return rc;
      return new Promise(function (res) { setTimeout(res, 2500); }).then(function () { return waitForReceipt(hash); });
    });
  }
  // Pre-flight with eth_call so a revert is explained in plain words BEFORE
  // the wallet asks the user to sign anything; then send and await the receipt.
  function walletSend(to, data, resultEl) {
    resultEl.innerHTML = '<p class="loading">Checking the transaction against the contract…</p>';
    return walletEthCall(to, data).then(function () {
      resultEl.innerHTML = '<p class="loading">Confirm the transaction in your wallet…</p>';
      return prequest("eth_sendTransaction", [{ from: state.wallet, to: to, data: data }]);
    }).then(function (hash) {
      resultEl.innerHTML = '<p class="kv">Sent: ' + txLink(hash) + ' — waiting for it to be mined…</p>';
      return waitForReceipt(hash).then(function (rc) {
        if (rc.status === "0x0") throw new Error("The transaction was mined but reverted.");
        resultEl.innerHTML = '<p class="kv ok">Done — confirmed on-chain: ' + txLink(hash) + "</p>";
        return hash;
      });
    }).catch(function (e) {
      var d = errorData(e);
      if (d) resultEl.innerHTML = '<p class="err">' + esc(plainRevert(d)) + "</p>";
      else if (e && e.code === 4001) resultEl.innerHTML = '<p class="err">You rejected the request in your wallet.</p>';
      else resultEl.innerHTML = '<p class="err">' + esc((e && e.message) || String(e)) + "</p>";
      throw e;
    });
  }

  function renderWallet() {
    var area = $("wallet-area");
    if (!provider()) {
      area.innerHTML = '<p class="kv">No Web3 wallet detected in this browser. Install a wallet such as ' +
        '<a href="https://metamask.io" target="_blank" rel="noopener">MetaMask</a> to write on-chain from this page — ' +
        "all the live reads above keep working without one.</p>";
      return;
    }
    if (!state.wallet) {
      area.innerHTML = '<p class="kv">Connect your wallet to register a payee name, create an invoice, or pay one.</p>' +
        '<button id="connect-btn" type="button">Connect wallet</button>' +
        '<div id="wallet-msg" class="result"></div>';
      $("connect-btn").addEventListener("click", connectWallet);
      return;
    }
    area.innerHTML =
      '<p class="kv">Connected: <span class="mono">' + esc(state.wallet) + "</span> " +
      '<span id="wallet-chain"></span></p>' +
      '<div id="wallet-msg" class="result"></div>' +
      '<h3 class="sub-h">Register your payee name</h3>' +
      '<p class="hint">Registers the name for <b>your connected address</b> in the Confirmation of Payee registry — the same self-registration “' +
      esc(CONFIG.payeeName) + '” used. A registered name can never be taken over by someone else.</p>' +
      '<div class="row"><input id="reg-name" type="text" placeholder="Your payee name, e.g. Sari Bakery" aria-label="Payee name to register">' +
      '<button id="reg-btn" type="button">Register name</button></div>' +
      '<div id="reg-result" class="result"></div>' +
      '<h3 class="sub-h">Create an invoice (merchant)</h3>' +
      '<p class="hint">Any wallet can act as merchant: the invoice names a <b>registered</b> payee and an exact amount. The session agent can then pay it.</p>' +
      '<div class="row"><input id="ci-name" type="text" value="' + esc(CONFIG.payeeName) + '" aria-label="Invoice payee name">' +
      '<input id="ci-amount" type="text" inputmode="decimal" value="0.10" aria-label="Invoice amount in tUSD8" class="short">' +
      '<input id="ci-days" type="text" inputmode="numeric" value="7" aria-label="Expiry in days" class="short">' +
      '<button id="ci-btn" type="button">Create invoice</button></div>' +
      '<div id="ci-result" class="result"></div>' +
      '<h3 class="sub-h">Pay an invoice (agent session)</h3>' +
      '<div id="pay-list"><p class="loading">Checking your session…</p></div>';
    $("reg-btn").addEventListener("click", onRegister);
    $("ci-btn").addEventListener("click", onCreateInvoice);
    prequest("eth_chainId", []).then(function (id) {
      var ok = parseInt(id, 16) === CONFIG.chainId;
      $("wallet-chain").innerHTML = ok
        ? '· on <b>' + esc(CONFIG.chainName) + "</b> (" + CONFIG.chainId + ")"
        : '· <b>wrong network</b> — this dApp needs ' + esc(CONFIG.chainName) + " (" + CONFIG.chainId + ")";
    }).catch(function () { /* status line stays address-only */ });
    checkWalletSession();
  }

  function ensureChain() {
    return prequest("eth_chainId", []).then(function (id) {
      if (parseInt(id, 16) === CONFIG.chainId) return true;
      return prequest("wallet_switchEthereumChain", [{ chainId: chainIdHex() }])
        .then(function () { return true; })
        .catch(function (e) {
          if (e && e.code === 4902) {
            return prequest("wallet_addEthereumChain", [{
              chainId: chainIdHex(), chainName: CONFIG.chainName,
              rpcUrls: [CONFIG.rpc],
              nativeCurrency: { name: "tQDAY", symbol: "tQDAY", decimals: 18 },
              blockExplorerUrls: [CONFIG.explorer]
            }]).then(function () { return true; });
          }
          throw e;
        });
    });
  }

  function connectWallet() {
    var msg = $("wallet-msg");
    prequest("eth_requestAccounts", []).then(function (accounts) {
      if (!accounts || !accounts.length) throw new Error("No account returned by the wallet.");
      state.wallet = accounts[0];
      return ensureChain().then(function () { renderWallet(); });
    }).catch(function (e) {
      if (msg) msg.innerHTML = '<p class="err">' + esc(e && e.code === 4001 ? "You rejected the connection request." : (e.message || String(e))) + "</p>";
    });
  }

  function onRegister() {
    var name = $("reg-name").value.trim();
    var box = $("reg-result");
    if (!name) { box.innerHTML = '<p class="err">Type the payee name to register first.</p>'; return; }
    var data = C.encodeCall("register(string,address)",
      [{ type: "string", value: name }, { type: "address", value: state.wallet }]);
    walletSend(CONFIG.registry, data, box).then(function () {
      return loadPayee(name).then(function () { loadAll(); });
    }).catch(function () { /* reason already rendered */ });
  }

  function onCreateInvoice() {
    var box = $("ci-result");
    var name = $("ci-name").value.trim();
    var amountStr = $("ci-amount").value;
    var daysStr = $("ci-days").value;
    var amount;
    try { amount = C.parseUnits(amountStr, 6); } catch (e) {
      box.innerHTML = '<p class="err">Amount: ' + esc(e.message) + "</p>"; return;
    }
    var days = parseInt(daysStr, 10);
    if (!name || !(days > 0)) { box.innerHTML = '<p class="err">Fill in a payee name and a positive expiry in days.</p>'; return; }
    if (amount <= 0n) { box.innerHTML = '<p class="err">The amount must be above zero.</p>'; return; }
    box.innerHTML = '<p class="loading">Resolving “' + esc(name) + '” in the registry…</p>';
    Promise.all([lookupPayee(name), blockNumber("latest").then(blockTimestamp)]).then(function (r) {
      var look = r[0], nowTs = r[1];
      if (!look.registered) {
        box.innerHTML = '<p class="err">“' + esc(name) + '” is not registered — an invoice can only name a registered payee.</p>';
        return;
      }
      var orderId = C.bytesToHex(C.keccak256(C.utf8Bytes(
        "paysure-demo-" + state.wallet.toLowerCase() + "-" + Date.now())));
      var expiry = BigInt(nowTs) + BigInt(days) * 86400n;
      var data = C.encodeCall("createInvoice(bytes32,string,address,uint256,uint64)", [
        { type: "bytes32", value: orderId }, { type: "string", value: name },
        { type: "address", value: look.address }, { type: "uint256", value: amount },
        { type: "uint64", value: expiry }
      ]);
      return walletSend(CONFIG.invoicePay, data, box).then(function () {
        box.innerHTML += '<p class="kv">Invoice created · order ID <span class="mono">' + esc(orderId) +
          "</span> · " + C.fmtTUSD8(amount) + ' tUSD8 to “' + esc(name) +
          '”. The session agent can now pay it from this page (with the agent wallet) or any client.</p>';
      });
    }).catch(function () { /* reason already rendered */ });
  }

  function checkWalletSession() {
    if (!state.wallet || !$("pay-list")) return;
    sessionOf(state.wallet).then(function (s) {
      state.walletSession = s;
      var nowSec = Math.floor(Date.now() / 1000);
      state.walletCanPay = !!(s && s.granted && !s.revoked && Number(s.expiresAt) > nowSec);
      renderPayPanel();
    }).catch(function () { state.walletCanPay = false; renderPayPanel(); });
  }

  function renderPayPanel() {
    var box = $("pay-list");
    if (!box) return;
    if (!state.wallet) {
      box.innerHTML = '<p class="kv">Connect a wallet above to see whether it can pay.</p>';
      return;
    }
    var unpaid = state.invoices.filter(function (x) { return x.v === "v2" && !x.receipt.paid; });
    var html = "";
    if (!state.walletCanPay) {
      html += '<p class="kv">Your connected wallet holds <b>no active agent session</b> on the v2 contract, so Pay stays disabled. ' +
        "Roles in one line: the <b>payee</b> registers its name · any <b>merchant</b> creates invoices · only the wallet the <b>owner</b> granted a session to (the agent) can pay them, inside its caps.</p>";
    }
    if (!unpaid.length) html += '<p class="kv">No unpaid v2 invoices right now.</p>';
    unpaid.forEach(function (x, i) {
      html += '<p class="kv">Invoice v2 #' + x.n + " · <b>" + C.fmtTUSD8(x.data.amount) + " tUSD8</b> to " +
        esc(x.data.payeeName) + ' <button type="button" data-pay="' + i + '"' +
        (state.walletCanPay ? "" : " disabled") + ">Pay</button></p>";
    });
    html += '<div id="pay-result" class="result"></div>';
    box.innerHTML = html;
    box.querySelectorAll("[data-pay]").forEach(function (btn) {
      btn.addEventListener("click", function () {
        var x = unpaid[Number(btn.getAttribute("data-pay"))];
        var data = C.encodeCall("payInvoice(bytes32,uint256)",
          [{ type: "bytes32", value: x.orderId }, { type: "uint256", value: x.data.amount }]);
        walletSend(CONFIG.invoicePay, data, $("pay-result")).then(function () { loadAll(); })
          .catch(function () { /* reason already rendered */ });
      });
    });
  }

  // ---- Boot ------------------------------------------------------------------
  function loadAll() {
    $("global-error").hidden = true;
    return loadChainStatus()
      .then(function () {
        return Promise.all([
          loadPayee($("payee-input").value || CONFIG.payeeName),
          loadSession().then(function (s) { return loadInvoices(s); }),
          loadBalances(),
          loadReceipts()
        ]);
      })
      .catch(function () { /* per-section errors already rendered */ });
  }

  document.addEventListener("DOMContentLoaded", function () {
    $("registry-link").href = CONFIG.explorer + "/address/" + CONFIG.registry;
    $("registry-link").textContent = "PayeeRegistry " + C.shortAddr(CONFIG.registry);
    $("invoice-link").href = CONFIG.explorer + "/address/" + CONFIG.invoicePay;
    $("invoice-link").textContent = "AgentInvoicePay v2 " + C.shortAddr(CONFIG.invoicePay);
    $("refresh-btn").addEventListener("click", loadAll);
    $("payee-btn").addEventListener("click", function () { loadPayee($("payee-input").value.trim()); });
    $("payee-input").addEventListener("keydown", function (e) {
      if (e.key === "Enter") loadPayee($("payee-input").value.trim());
    });
    renderWallet();
    var p = provider();
    if (p && p.on) {
      p.on("accountsChanged", function (accounts) {
        state.wallet = accounts && accounts.length ? accounts[0] : null;
        state.walletCanPay = false;
        renderWallet();
        loadAll();
      });
      p.on("chainChanged", function () { renderWallet(); loadAll(); });
    }
    loadAll();
  });
})();
