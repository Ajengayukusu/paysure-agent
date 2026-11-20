/* PaySure Agent demo — all values are read LIVE from the Aevum testnet
 * via plain JSON-RPC (eth_call / eth_getLogs / eth_getBalance). No libraries.
 */
(function () {
  "use strict";
  var C = window.PaySureCore;

  // ---- Live config (addresses + order ids only; every value is read live) --
  var CONFIG = {
    rpc: "https://rpc-test.qday.info",
    explorer: "https://explorer-test.qday.info",
    chainId: 44005,
    tusd8: "0x456569838f1d43009A91ebA4263147Afd7233483",
    registry: "0x4A31fD9169E2DFaBB0763c1E8B38B24eC516780A",
    invoicePay: "0x2D0ff19258d19d38F6352E8F565dF0BC3F7054ed",
    deployBlock: 3648858,
    owner: "0xB9bD942878724029740A491a1e238449748f8eAe",
    agent: "0x7D89Dc892b34Ec4b1e9d73E5D09A3601d0b8C382",
    payee: "0xA1A90bb88c3F0C12aEC9c1664DA3fAE2fAB88746",
    payeeName: "Sari Bakery",
    paidTopic: "0x060bb954af967ecb7aa08a0072a7f8fe308ceee2f5d15f4a9d4a5275a5fe79e9",
    invoices: [
      { n: 1, orderId: "0x07671c88b5d222242921494fa102beecf542efc654c9152f83b39b05e2064dc9", note: "Paid by the agent (approve path)" },
      { n: 2, orderId: "0xdd36fb6695f3f3b84380ed10701fc40a8f190a4c180cdacde783d3321f4cef8d", note: "Created as the over-cap proof" },
      { n: 3, orderId: "0x107d685b386d19c3a39e05315cc271a698d90c0c8af1d202af1a95185a656603", note: "Paid gasless (EIP-3009 signature, relayed by the agent)" }
    ]
  };

  var state = { latest: 0, finalized: 0, session: null };

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
  function invoiceOf(orderId) {
    var data = C.encodeCall("invoiceOf(bytes32)", [{ type: "bytes32", value: orderId }]);
    return ethCall(CONFIG.invoicePay, data).then(function (res) {
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
  function receiptOf(orderId) {
    var data = C.encodeCall("receiptOf(bytes32)", [{ type: "bytes32", value: orderId }]);
    return ethCall(CONFIG.invoicePay, data).then(function (res) {
      var w = C.words(res);
      return {
        payer: C.wordToAddress(w[0]), agent: C.wordToAddress(w[1]), payee: C.wordToAddress(w[2]),
        amount: C.wordToBigInt(w[3]), paidAt: C.wordToBigInt(w[4]), paid: C.wordToBool(w[5])
      };
    });
  }
  function sessionOf(agent) {
    var data = C.encodeCall("sessionOf(address)", [{ type: "address", value: agent }]);
    return ethCall(CONFIG.invoicePay, data).then(function (res) {
      var w = C.words(res);
      return {
        perTxCap: C.wordToBigInt(w[0]), dailyCap: C.wordToBigInt(w[1]), expiresAt: C.wordToBigInt(w[2]),
        granted: C.wordToBool(w[3]), revoked: C.wordToBool(w[4]),
        dayIndex: C.wordToBigInt(w[5]), spentInDay: C.wordToBigInt(w[6])
      };
    });
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
    var html = '<div class="invoice"><h3>Invoice #' + inv.n + " " + status + "</h3>" +
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
    }
    html += '<p class="kv hint">' + esc(inv.note) + "</p></div>";
    return html;
  }

  function loadInvoices(session) {
    var jobs = CONFIG.invoices.map(function (inv) {
      return Promise.all([invoiceOf(inv.orderId), receiptOf(inv.orderId)]).then(function (r) {
        return { n: inv.n, orderId: inv.orderId, note: inv.note, data: r[0], receipt: r[1] };
      });
    });
    return Promise.all(jobs).then(function (list) {
      $("invoices").innerHTML = list.map(function (x) { return invoiceCard(x, x.receipt, session); }).join("");
    }).catch(function (e) {
      $("invoices").innerHTML = '<p class="err">Could not load invoices: ' + esc(e.message) + "</p>";
    });
  }

  function loadSession() {
    return Promise.all([sessionOf(CONFIG.agent), payeeAllowed(CONFIG.agent, CONFIG.payee)]).then(function (r) {
      var s = r[0]; state.session = s;
      var status = !s.granted ? "Not granted" : s.revoked ? "Revoked" : "Active";
      $("session").innerHTML =
        "<table>" +
        "<tr><th>Agent</th><td>" + addrLink(CONFIG.agent) + "</td></tr>" +
        "<tr><th>Status</th><td>" + status + "</td></tr>" +
        "<tr><th>Per-transaction cap</th><td>" + C.fmtTUSD8(s.perTxCap) + " tUSD8</td></tr>" +
        "<tr><th>Daily cap</th><td>" + C.fmtTUSD8(s.dailyCap) + " tUSD8</td></tr>" +
        "<tr><th>Spent in current day</th><td>" + C.fmtTUSD8(s.spentInDay) + " tUSD8</td></tr>" +
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

  // ---- Watcher: Paid events, chunked ≤1000 blocks, dedupe, Seen/Finalized ---
  function scanPayments() {
    var chunks = [], from = CONFIG.deployBlock;
    while (from <= state.latest) {
      var to = Math.min(from + 999, state.latest);
      chunks.push([from, to]); from = to + 1;
    }
    var seen = {}, payments = [];
    var chain = Promise.resolve();
    chunks.forEach(function (pair) {
      chain = chain.then(function () {
        return rpc("eth_getLogs", [{
          address: CONFIG.invoicePay, topics: [CONFIG.paidTopic],
          fromBlock: "0x" + pair[0].toString(16), toBlock: "0x" + pair[1].toString(16)
        }]).then(function (logs) {
          logs.forEach(function (log) {
            var key = log.transactionHash + ":" + C.hexToNum(log.logIndex);
            if (seen[key]) return; seen[key] = true;
            var dw = C.words(log.data);
            var amount = C.wordToBigInt(dw[1]);
            if (amount === 0n) return; // zero-value events are not payments
            payments.push({
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
          '<p class="kv"><b>' + C.fmtTUSD8(p.amount) + " tUSD8</b> · order <span class=\"mono\">" +
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
    $("invoice-link").textContent = "AgentInvoicePay " + C.shortAddr(CONFIG.invoicePay);
    $("refresh-btn").addEventListener("click", loadAll);
    $("payee-btn").addEventListener("click", function () { loadPayee($("payee-input").value.trim()); });
    $("payee-input").addEventListener("keydown", function (e) {
      if (e.key === "Enter") loadPayee($("payee-input").value.trim());
    });
    loadAll();
  });
})();
