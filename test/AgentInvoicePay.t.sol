// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {AgentInvoicePay} from "../src/AgentInvoicePay.sol";
import {PayeeRegistry} from "../src/PayeeRegistry.sol";
import {MockTUSD8} from "../src/mocks/MockTUSD8.sol";
import {Signing} from "./Signing.sol";

contract AgentInvoicePayTest is Test {
    MockTUSD8 token;
    PayeeRegistry registry; // owner: this test contract
    AgentInvoicePay pay; // owner: payer

    address payer;
    uint256 payerKey;
    address merchant = makeAddr("merchant");
    address agent = makeAddr("agent");
    address payee = makeAddr("payee");
    address payee2 = makeAddr("payee2");
    address stranger = makeAddr("stranger");

    uint256 constant PER_TX_CAP = 200e6; // 200 tUSD8
    uint256 constant DAILY_CAP = 300e6; // 300 tUSD8

    function setUp() public {
        (payer, payerKey) = makeAddrAndKey("payer");
        token = new MockTUSD8();
        registry = new PayeeRegistry();
        vm.prank(payer);
        pay = new AgentInvoicePay(IERC20(address(token)), registry);

        token.mint(payer, 1000e6);
        vm.prank(payer);
        token.approve(address(pay), 1000e6);

        vm.prank(payee);
        registry.register("Alice Payee", payee);
        vm.prank(payee2);
        registry.register("Bob Payee", payee2);

        vm.startPrank(payer);
        pay.grantSession(agent, PER_TX_CAP, DAILY_CAP, uint64(block.timestamp + 7 days));
        pay.setPayeeAllowed(agent, payee, true);
        vm.stopPrank();
    }

    function _create(bytes32 id, uint256 amount) internal {
        _create(id, "Alice Payee", payee, amount, uint64(block.timestamp + 30 days));
    }

    function _create(bytes32 id, string memory name, address p, uint256 amount, uint64 expiry) internal {
        vm.prank(merchant);
        pay.createInvoice(id, name, p, amount, expiry);
    }

    // ------------------------------------------------------------ happy path

    function test_payInvoice_happyPath() public {
        bytes32 id = keccak256("inv-1");
        _create(id, 50e6);
        vm.expectEmit(true, true, true, true, address(pay));
        emit AgentInvoicePay.Paid(id, payer, agent, payee, 50e6);
        vm.prank(agent);
        pay.payInvoice(id, 50e6);

        assertEq(token.balanceOf(payee), 50e6);
        assertEq(token.balanceOf(payer), 950e6);
        assertEq(token.balanceOf(address(pay)), 0);
        assertTrue(pay.isPaid(id));
        AgentInvoicePay.Receipt memory r = pay.receiptOf(id);
        assertEq(r.payer, payer);
        assertEq(r.agent, agent);
        assertEq(r.payee, payee);
        assertEq(r.amount, 50e6);
        assertEq(r.paidAt, block.timestamp);
        assertEq(pay.sessionOf(agent).spentInDay, 50e6);
    }

    // ------------------------------------------------------------ exact amount (the kit flaw, fixed)

    function test_payInvoice_underAmount_reverts() public {
        bytes32 id = keccak256("inv-under");
        _create(id, 50e6);
        vm.prank(agent);
        vm.expectRevert(abi.encodeWithSelector(AgentInvoicePay.AmountMismatch.selector, 50e6, 50e6 - 1));
        pay.payInvoice(id, 50e6 - 1);
        assertFalse(pay.isPaid(id));
    }

    function test_payInvoice_overAmount_reverts() public {
        bytes32 id = keccak256("inv-over");
        _create(id, 50e6);
        vm.prank(agent);
        vm.expectRevert(abi.encodeWithSelector(AgentInvoicePay.AmountMismatch.selector, 50e6, 50e6 + 1));
        pay.payInvoice(id, 50e6 + 1);
        assertFalse(pay.isPaid(id));
    }

    function test_payInvoice_dustPaymentDoesNotMarkPaid() public {
        // The starter-kit flaw: pay(orderId, 1) must NOT settle an invoice here.
        bytes32 id = keccak256("inv-dust");
        _create(id, 50e6);
        vm.prank(agent);
        vm.expectRevert(abi.encodeWithSelector(AgentInvoicePay.AmountMismatch.selector, 50e6, uint256(1)));
        pay.payInvoice(id, 1);
        assertFalse(pay.isPaid(id));
        assertEq(token.balanceOf(payee), 0);
    }

    // ------------------------------------------------------------ invoice state

    function test_payInvoice_doublePay_reverts() public {
        bytes32 id = keccak256("inv-double");
        _create(id, 50e6);
        vm.prank(agent);
        pay.payInvoice(id, 50e6);
        vm.prank(agent);
        vm.expectRevert(abi.encodeWithSelector(AgentInvoicePay.InvoiceAlreadyPaid.selector, id));
        pay.payInvoice(id, 50e6);
    }

    function test_payInvoice_expiredInvoice_reverts() public {
        bytes32 id = keccak256("inv-expired");
        _create(id, "Alice Payee", payee, 50e6, uint64(block.timestamp + 1 hours));
        vm.warp(block.timestamp + 2 hours);
        vm.prank(agent);
        vm.expectRevert(abi.encodeWithSelector(AgentInvoicePay.InvoiceExpired.selector, id));
        pay.payInvoice(id, 50e6);
    }

    function test_payInvoice_unknownInvoice_reverts() public {
        vm.prank(agent);
        vm.expectRevert(abi.encodeWithSelector(AgentInvoicePay.InvoiceNotFound.selector, keccak256("nope")));
        pay.payInvoice(keccak256("nope"), 1e6);
    }

    // ------------------------------------------------------------ session caps & lifecycle

    function test_payInvoice_perTxCap_reverts() public {
        bytes32 id = keccak256("inv-big");
        _create(id, 250e6); // > 200 per-tx cap, < 300 daily cap
        vm.prank(agent);
        vm.expectRevert(abi.encodeWithSelector(AgentInvoicePay.PerTxCapExceeded.selector, 250e6, PER_TX_CAP));
        pay.payInvoice(id, 250e6);
    }

    function test_payInvoice_dailyCapAcrossTwoPayments_revertsThenRollsOver() public {
        bytes32 id1 = keccak256("inv-day-1");
        bytes32 id2 = keccak256("inv-day-2");
        _create(id1, 200e6);
        _create(id2, 150e6);
        vm.prank(agent);
        pay.payInvoice(id1, 200e6);
        vm.prank(agent);
        vm.expectRevert(
            abi.encodeWithSelector(AgentInvoicePay.DailyCapExceeded.selector, 150e6, 200e6, DAILY_CAP)
        );
        pay.payInvoice(id2, 150e6);
        assertFalse(pay.isPaid(id2));

        // Next day the window rolls and the same payment succeeds.
        vm.warp(block.timestamp + 1 days + 1);
        vm.prank(agent);
        pay.payInvoice(id2, 150e6);
        assertTrue(pay.isPaid(id2));
        assertEq(pay.sessionOf(agent).spentInDay, 150e6);
    }

    function test_payInvoice_revokedSession_reverts() public {
        bytes32 id = keccak256("inv-revoked");
        _create(id, 50e6);
        vm.prank(payer);
        pay.revokeSession(agent);
        vm.prank(agent);
        vm.expectRevert(abi.encodeWithSelector(AgentInvoicePay.SessionRevokedErr.selector, agent));
        pay.payInvoice(id, 50e6);
    }

    function test_payInvoice_expiredSession_reverts() public {
        bytes32 id = keccak256("inv-session-expired");
        _create(id, 50e6); // invoice lives 30 days; session only 7
        vm.warp(block.timestamp + 8 days);
        vm.prank(agent);
        vm.expectRevert(abi.encodeWithSelector(AgentInvoicePay.SessionExpired.selector, agent));
        pay.payInvoice(id, 50e6);
    }

    function test_payInvoice_noSession_reverts() public {
        bytes32 id = keccak256("inv-nosession");
        _create(id, 50e6);
        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(AgentInvoicePay.NoSession.selector, stranger));
        pay.payInvoice(id, 50e6);
    }

    // ------------------------------------------------------------ payee checks

    function test_payInvoice_nonAllowlistedPayee_reverts() public {
        bytes32 id = keccak256("inv-bob");
        _create(id, "Bob Payee", payee2, 50e6, uint64(block.timestamp + 30 days));
        vm.prank(agent);
        vm.expectRevert(abi.encodeWithSelector(AgentInvoicePay.PayeeNotAllowed.selector, agent, payee2));
        pay.payInvoice(id, 50e6);
    }

    function test_payInvoice_registryChangedAfterCreation_reverts() public {
        bytes32 id = keccak256("inv-mismatch");
        _create(id, 50e6);
        // Registry owner re-points the name after the invoice was created:
        // the payment must stop instead of paying the invoice's stale address blindly.
        registry.update("Alice Payee", stranger);
        vm.prank(agent);
        vm.expectRevert(
            abi.encodeWithSelector(AgentInvoicePay.PayeeMismatch.selector, "Alice Payee", payee, stranger)
        );
        pay.payInvoice(id, 50e6);
        assertEq(token.balanceOf(stranger), 0);
    }

    function test_createInvoice_payeeMismatch_reverts() public {
        vm.prank(merchant);
        vm.expectRevert(
            abi.encodeWithSelector(AgentInvoicePay.PayeeMismatch.selector, "Alice Payee", stranger, payee)
        );
        pay.createInvoice(keccak256("inv-bad"), "Alice Payee", stranger, 50e6, uint64(block.timestamp + 1 days));
    }

    function test_createInvoice_unregisteredName_reverts() public {
        vm.prank(merchant);
        vm.expectRevert(abi.encodeWithSelector(AgentInvoicePay.PayeeNotRegistered.selector, "Ghost Payee"));
        pay.createInvoice(keccak256("inv-ghost"), "Ghost Payee", stranger, 50e6, uint64(block.timestamp + 1 days));
    }

    // ------------------------------------------------------------ gasless (EIP-3009)

    function _signFor(bytes32 orderId, uint256 value, uint256 validBefore)
        internal
        view
        returns (uint8 v, bytes32 r, bytes32 s)
    {
        Signing.Auth memory a = Signing.Auth({
            from: payer,
            to: address(pay),
            value: value,
            validAfter: 0,
            validBefore: validBefore,
            nonce: pay.authorizationNonce(orderId)
        });
        return Signing.signReceive(vm, payerKey, token.DOMAIN_SEPARATOR(), a);
    }

    function test_payWithAuthorization_happyPath() public {
        bytes32 id = keccak256("inv-gasless");
        _create(id, 50e6);
        uint256 deadline = block.timestamp + 1 hours;
        (uint8 v, bytes32 r, bytes32 s) = _signFor(id, 50e6, deadline);

        vm.prank(agent); // agent relays; the owner/payer never sends a transaction
        pay.payInvoiceWithAuthorization(id, 50e6, 0, deadline, v, r, s);

        assertEq(token.balanceOf(payee), 50e6);
        assertEq(token.balanceOf(payer), 950e6);
        assertEq(token.balanceOf(address(pay)), 0);
        assertTrue(pay.isPaid(id));
        assertEq(pay.receiptOf(id).agent, agent);
    }

    function test_payWithAuthorization_signatureBoundToOrder() public {
        bytes32 id = keccak256("inv-gasless-a");
        bytes32 other = keccak256("inv-gasless-b");
        _create(id, 50e6);
        _create(other, 50e6);
        uint256 deadline = block.timestamp + 1 hours;
        (uint8 v, bytes32 r, bytes32 s) = _signFor(id, 50e6, deadline);

        vm.prank(agent);
        vm.expectRevert(MockTUSD8.InvalidSignature.selector);
        pay.payInvoiceWithAuthorization(other, 50e6, 0, deadline, v, r, s);
    }

    function test_payWithAuthorization_amountMismatch_reverts() public {
        bytes32 id = keccak256("inv-gasless-mismatch");
        _create(id, 50e6);
        uint256 deadline = block.timestamp + 1 hours;
        (uint8 v, bytes32 r, bytes32 s) = _signFor(id, 50e6, deadline);

        vm.prank(agent);
        vm.expectRevert(abi.encodeWithSelector(AgentInvoicePay.AmountMismatch.selector, 50e6, 49e6));
        pay.payInvoiceWithAuthorization(id, 49e6, 0, deadline, v, r, s);
    }

    // ------------------------------------------------------------ refunds

    function test_recordRefund_byMerchant() public {
        bytes32 id = keccak256("inv-refund");
        _create(id, 50e6);
        vm.prank(agent);
        pay.payInvoice(id, 50e6);

        bytes32 ref = keccak256("refund-tx-abc123");
        vm.prank(merchant);
        pay.recordRefund(id, 50e6, ref);
        AgentInvoicePay.Refund memory rf = pay.refundOf(id);
        assertTrue(rf.exists);
        assertEq(rf.amount, 50e6);
        assertEq(rf.ref, ref);
        assertEq(rf.recordedAt, block.timestamp);
    }

    function test_recordRefund_byStranger_reverts() public {
        bytes32 id = keccak256("inv-refund-stranger");
        _create(id, 50e6);
        vm.prank(agent);
        pay.payInvoice(id, 50e6);
        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(AgentInvoicePay.NotInvoiceMerchant.selector, id));
        pay.recordRefund(id, 50e6, keccak256("refund-tx-1"));
    }

    function test_recordRefund_unpaidInvoice_reverts() public {
        bytes32 id = keccak256("inv-refund-unpaid");
        _create(id, 50e6);
        vm.prank(merchant);
        vm.expectRevert(abi.encodeWithSelector(AgentInvoicePay.InvoiceNotYetPaid.selector, id));
        pay.recordRefund(id, 50e6, keccak256("refund-tx-1"));
    }
}
