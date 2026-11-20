// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {PayeeRegistry} from "./PayeeRegistry.sol";

/// @notice EIP-3009 (USDC-style) signed transfers. tUSD8 on Aevum implements this.
///         Interface pattern reused from the Aevum Starter Kit's Checkout (MIT, PQA Labs).
interface IERC3009 {
    function receiveWithAuthorization(
        address from,
        address to,
        uint256 value,
        uint256 validAfter,
        uint256 validBefore,
        bytes32 nonce,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) external;
}

/// @title AgentInvoicePay — session-capped agent invoice payments in tUSD8.
/// @notice One flow: a merchant creates an invoice for a registered payee name; the account
///         owner grants an AI agent a *session* (per-tx cap, daily cap, expiry, payee
///         allowlist, instantly revocable); the agent pays invoices out of the owner's
///         balance — by approve+transferFrom, or gaslessly by relaying the owner's
///         EIP-3009 signature. The contract enforces everything; the UI cannot widen it.
/// @dev Deliberate fix vs the starter kit's Checkout: Checkout never checks the amount, so
///      `pay(orderId, 1)` marks an order paid for 0.000001 tUSD8 (the kit docs warn about
///      this). Here the paid amount MUST equal the invoice's exact amount, on both paths.
contract AgentInvoicePay is Ownable {
    using SafeERC20 for IERC20;

    struct Invoice {
        address merchant;
        address payee;
        string payeeName;
        uint256 amount;
        uint64 expiry;
        bool exists;
    }

    struct Receipt {
        address payer; // funds source (the session owner)
        address agent; // session holder that executed the payment
        address payee;
        uint256 amount;
        uint64 paidAt;
        bool paid;
    }

    struct Session {
        uint256 perTxCap;
        uint256 dailyCap;
        uint64 expiresAt;
        bool granted;
        bool revoked;
        uint256 dayIndex; // block.timestamp / 1 days at last spend
        uint256 spentInDay;
    }

    struct Refund {
        bytes32 ref; // off-chain/on-chain reference of the refund transfer (e.g. its tx hash)
        uint256 amount;
        uint64 recordedAt;
        bool exists;
    }

    IERC20 public immutable token;
    PayeeRegistry public immutable registry;

    mapping(bytes32 orderId => Invoice) private _invoices;
    mapping(bytes32 orderId => Receipt) private _receipts;
    mapping(bytes32 orderId => Refund) private _refunds;
    mapping(address agent => Session) private _sessions;
    mapping(address agent => mapping(address payee => bool)) private _payeeAllowed;

    event InvoiceCreated(
        bytes32 indexed orderId, address indexed merchant, address indexed payee, string payeeName, uint256 amount, uint64 expiry
    );
    event Paid(bytes32 indexed orderId, address indexed payer, address indexed agent, address payee, uint256 amount);
    event SessionGranted(address indexed agent, uint256 perTxCap, uint256 dailyCap, uint64 expiresAt);
    event SessionRevoked(address indexed agent);
    event PayeeAllowanceSet(address indexed agent, address indexed payee, bool allowed);
    event RefundRecorded(bytes32 indexed orderId, address indexed merchant, uint256 amount, bytes32 ref);

    error ZeroAddress();
    error InvoiceExists(bytes32 orderId);
    error InvoiceNotFound(bytes32 orderId);
    error InvoiceAlreadyPaid(bytes32 orderId);
    error InvoiceExpired(bytes32 orderId);
    error InvoiceNotYetPaid(bytes32 orderId);
    error InvalidAmount();
    error InvalidExpiry();
    error AmountMismatch(uint256 expected, uint256 got);
    error PayeeNotRegistered(string payeeName);
    error PayeeMismatch(string payeeName, address expected, address registered);
    error NoSession(address agent);
    error SessionRevokedErr(address agent);
    error SessionExpired(address agent);
    error PerTxCapExceeded(uint256 amount, uint256 cap);
    error DailyCapExceeded(uint256 amount, uint256 spentToday, uint256 cap);
    error PayeeNotAllowed(address agent, address payee);
    error NotInvoiceMerchant(bytes32 orderId);

    constructor(IERC20 token_, PayeeRegistry registry_) Ownable(msg.sender) {
        if (address(token_) == address(0) || address(registry_) == address(0)) revert ZeroAddress();
        token = token_;
        registry = registry_;
    }

    // ---------------------------------------------------------------- invoices

    /// @notice Create an invoice payable to the address `payeeName` resolves to *now*.
    ///         The payee is re-resolved at payment time, so a registry change in between
    ///         blocks the payment instead of silently paying the wrong address.
    function createInvoice(bytes32 orderId, string calldata payeeName, address payee, uint256 amount, uint64 expiry)
        external
        returns (bytes32)
    {
        if (amount == 0) revert InvalidAmount();
        if (expiry <= block.timestamp) revert InvalidExpiry();
        if (_invoices[orderId].exists) revert InvoiceExists(orderId);
        _requireRegistryMatch(payeeName, payee);
        _invoices[orderId] =
            Invoice({merchant: msg.sender, payee: payee, payeeName: payeeName, amount: amount, expiry: expiry, exists: true});
        emit InvoiceCreated(orderId, msg.sender, payee, payeeName, amount, expiry);
        return orderId;
    }

    // ---------------------------------------------------------------- sessions

    /// @notice Grant (or re-grant) an agent session. Only the account owner.
    function grantSession(address agent, uint256 perTxCap, uint256 dailyCap, uint64 expiresAt) external onlyOwner {
        if (agent == address(0)) revert ZeroAddress();
        if (perTxCap == 0 || dailyCap < perTxCap) revert InvalidAmount();
        if (expiresAt <= block.timestamp) revert InvalidExpiry();
        _sessions[agent] = Session({
            perTxCap: perTxCap,
            dailyCap: dailyCap,
            expiresAt: expiresAt,
            granted: true,
            revoked: false,
            dayIndex: block.timestamp / 1 days,
            spentInDay: 0
        });
        emit SessionGranted(agent, perTxCap, dailyCap, expiresAt);
    }

    /// @notice Revoke a session instantly. The agent cannot pay from the next block on.
    function revokeSession(address agent) external onlyOwner {
        if (!_sessions[agent].granted) revert NoSession(agent);
        _sessions[agent].revoked = true;
        emit SessionRevoked(agent);
    }

    /// @notice Allow or disallow one payee for one agent's session. Only the owner.
    function setPayeeAllowed(address agent, address payee, bool allowed) external onlyOwner {
        if (!_sessions[agent].granted) revert NoSession(agent);
        _payeeAllowed[agent][payee] = allowed;
        emit PayeeAllowanceSet(agent, payee, allowed);
    }

    // ---------------------------------------------------------------- payment

    /// @notice Agent pays an invoice from the owner's balance (approve path).
    ///         `amount` must equal the invoice amount exactly — under/over both revert.
    function payInvoice(bytes32 orderId, uint256 amount) external {
        Invoice storage inv = _validatePayment(orderId, amount, msg.sender);
        _recordPayment(orderId, inv, msg.sender);
        token.safeTransferFrom(owner(), inv.payee, amount);
    }

    /// @notice Gasless path: the agent relays the owner's EIP-3009 `ReceiveWithAuthorization`
    ///         signature (nonce bound to this order, as in the starter kit's Checkout), so the
    ///         owner never sends a transaction. The session rules apply to the relayer-agent.
    function payInvoiceWithAuthorization(
        bytes32 orderId,
        uint256 amount,
        uint256 validAfter,
        uint256 validBefore,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) external {
        Invoice storage inv = _validatePayment(orderId, amount, msg.sender);
        _recordPayment(orderId, inv, msg.sender);
        IERC3009(address(token)).receiveWithAuthorization(
            owner(), address(this), amount, validAfter, validBefore, authorizationNonce(orderId), v, r, s
        );
        token.safeTransfer(inv.payee, amount);
    }

    /// @notice The EIP-3009 nonce the owner must sign to pay `orderId` gaslessly.
    function authorizationNonce(bytes32 orderId) public view returns (bytes32) {
        return keccak256(abi.encode(address(this), orderId));
    }

    // ---------------------------------------------------------------- refunds

    /// @notice The invoice's merchant records that a refund transfer happened, with its
    ///         reference (e.g. the refund tx hash). Bookkeeping only — the refund transfer
    ///         itself is a normal token transfer by the merchant.
    function recordRefund(bytes32 orderId, uint256 amount, bytes32 ref) external {
        Invoice storage inv = _invoices[orderId];
        if (!inv.exists) revert InvoiceNotFound(orderId);
        if (msg.sender != inv.merchant) revert NotInvoiceMerchant(orderId);
        if (!_receipts[orderId].paid) revert InvoiceNotYetPaid(orderId);
        if (amount == 0 || ref == bytes32(0)) revert InvalidAmount();
        _refunds[orderId] = Refund({ref: ref, amount: amount, recordedAt: uint64(block.timestamp), exists: true});
        emit RefundRecorded(orderId, msg.sender, amount, ref);
    }

    // ---------------------------------------------------------------- views

    function invoiceOf(bytes32 orderId) external view returns (Invoice memory) {
        return _invoices[orderId];
    }

    function receiptOf(bytes32 orderId) external view returns (Receipt memory) {
        return _receipts[orderId];
    }

    function refundOf(bytes32 orderId) external view returns (Refund memory) {
        return _refunds[orderId];
    }

    function isPaid(bytes32 orderId) external view returns (bool) {
        return _receipts[orderId].paid;
    }

    function sessionOf(address agent) external view returns (Session memory s) {
        s = _sessions[agent];
        if (block.timestamp / 1 days != s.dayIndex) s.spentInDay = 0; // window already rolled
        return s;
    }

    function payeeAllowed(address agent, address payee) external view returns (bool) {
        return _payeeAllowed[agent][payee];
    }

    // ---------------------------------------------------------------- internals

    function _requireRegistryMatch(string memory payeeName, address payee) internal view {
        (address registered, bool exists) = registry.lookup(payeeName);
        if (!exists) revert PayeeNotRegistered(payeeName);
        if (registered != payee) revert PayeeMismatch(payeeName, payee, registered);
    }

    function _validatePayment(bytes32 orderId, uint256 amount, address agent)
        internal
        view
        returns (Invoice storage inv)
    {
        inv = _invoices[orderId];
        if (!inv.exists) revert InvoiceNotFound(orderId);
        if (_receipts[orderId].paid) revert InvoiceAlreadyPaid(orderId);
        if (block.timestamp > inv.expiry) revert InvoiceExpired(orderId);
        if (amount != inv.amount) revert AmountMismatch(inv.amount, amount);
        // Confirmation of Payee, re-checked at payment time.
        _requireRegistryMatch(inv.payeeName, inv.payee);

        Session storage s = _sessions[agent];
        if (!s.granted) revert NoSession(agent);
        if (s.revoked) revert SessionRevokedErr(agent);
        if (block.timestamp > s.expiresAt) revert SessionExpired(agent);
        if (!_payeeAllowed[agent][inv.payee]) revert PayeeNotAllowed(agent, inv.payee);
        if (amount > s.perTxCap) revert PerTxCapExceeded(amount, s.perTxCap);
        uint256 spentToday = (block.timestamp / 1 days == s.dayIndex) ? s.spentInDay : 0;
        if (spentToday + amount > s.dailyCap) revert DailyCapExceeded(amount, spentToday, s.dailyCap);
    }

    function _recordPayment(bytes32 orderId, Invoice storage inv, address agent) internal {
        Session storage s = _sessions[agent];
        uint256 today = block.timestamp / 1 days;
        if (today != s.dayIndex) {
            s.dayIndex = today;
            s.spentInDay = 0;
        }
        s.spentInDay += inv.amount;
        _receipts[orderId] = Receipt({
            payer: owner(),
            agent: agent,
            payee: inv.payee,
            amount: inv.amount,
            paidAt: uint64(block.timestamp),
            paid: true
        });
        emit Paid(orderId, owner(), agent, inv.payee, inv.amount);
    }
}
