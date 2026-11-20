// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {PayeeRegistry} from "../../src/PayeeRegistry.sol";
import {AgentInvoicePay} from "../../src/AgentInvoicePay.sol";

/// @notice Runs PayeeRegistry + AgentInvoicePay against the REAL tUSD8 on a local fork of
///         Aevum testnet (chain 44005). No real funds needed: `deal` writes a balance into
///         the fork only — the technique used by the Aevum Starter Kit's fork test
///         (Aevum Starter Kit, MIT, PQA Labs — see NOTICE.md).
///         Run with: forge test --match-path 'test/fork/*' --fork-url aevum --evm-version shanghai
contract AevumForkTest is Test {
    IERC20 constant TUSD8 = IERC20(0x456569838f1d43009A91ebA4263147Afd7233483);

    PayeeRegistry internal registry;
    AgentInvoicePay internal pay;

    address internal payee = makeAddr("payee");
    address internal agent = makeAddr("agent");

    string internal constant PAYEE_NAME = "Fork Bakery";
    bytes32 internal constant ORDER_ID = keccak256("fork-invoice-1");
    uint256 internal constant AMOUNT = 1.25e6; // 1.25 tUSD8

    function setUp() public {
        assertEq(block.chainid, 44005, "run with --fork-url aevum");
        registry = new PayeeRegistry();
        pay = new AgentInvoicePay(TUSD8, registry);
        // The test contract is `pay.owner()`: the funds source for agent payments.
        deal(address(TUSD8), address(this), 5e6);
    }

    function test_fork_registerPayee() public {
        vm.prank(payee);
        registry.register(PAYEE_NAME, payee);

        (address resolved, bool registered) = registry.lookup(PAYEE_NAME);
        assertTrue(registered);
        assertEq(resolved, payee);
        // Confirmation of Payee is case-insensitive.
        (address resolvedLower,) = registry.lookup("fork bakery");
        assertEq(resolvedLower, payee);
    }

    function test_fork_fullFlow_realTusd8() public {
        // 1. Payee self-registers its name.
        vm.prank(payee);
        registry.register(PAYEE_NAME, payee);

        // 2. Merchant (the owner / test contract) creates an exact-amount invoice.
        uint64 expiry = uint64(block.timestamp + 7 days);
        pay.createInvoice(ORDER_ID, PAYEE_NAME, payee, AMOUNT, expiry);

        AgentInvoicePay.Invoice memory inv = pay.invoiceOf(ORDER_ID);
        assertTrue(inv.exists);
        assertEq(inv.payee, payee);
        assertEq(inv.amount, AMOUNT);
        assertFalse(pay.isPaid(ORDER_ID));

        // 3. Owner grants the agent a capped session and allowlists the payee.
        pay.grantSession(agent, 2e6, 3e6, uint64(block.timestamp + 7 days));
        pay.setPayeeAllowed(agent, payee, true);
        assertTrue(pay.payeeAllowed(agent, payee));

        // 4. Owner approves the contract; the AGENT executes the payment.
        TUSD8.approve(address(pay), AMOUNT);
        uint256 ownerBefore = TUSD8.balanceOf(address(this));
        uint256 payeeBefore = TUSD8.balanceOf(payee);

        vm.prank(agent);
        pay.payInvoice(ORDER_ID, AMOUNT);

        // 5. Real tUSD8 moved exactly 1.25, owner -> payee; receipt is on-chain.
        assertEq(TUSD8.balanceOf(payee), payeeBefore + AMOUNT);
        assertEq(TUSD8.balanceOf(address(this)), ownerBefore - AMOUNT);
        assertTrue(pay.isPaid(ORDER_ID));

        AgentInvoicePay.Receipt memory rc = pay.receiptOf(ORDER_ID);
        assertTrue(rc.paid);
        assertEq(rc.payer, address(this));
        assertEq(rc.agent, agent);
        assertEq(rc.payee, payee);
        assertEq(rc.amount, AMOUNT);
        assertEq(rc.paidAt, uint64(block.timestamp));
    }

    function test_fork_overCapPaymentReverts_realTusd8() public {
        vm.prank(payee);
        registry.register(PAYEE_NAME, payee);

        bytes32 bigOrder = keccak256("fork-invoice-big");
        pay.createInvoice(bigOrder, PAYEE_NAME, payee, 2.5e6, uint64(block.timestamp + 7 days));
        pay.grantSession(agent, 2e6, 3e6, uint64(block.timestamp + 7 days));
        pay.setPayeeAllowed(agent, payee, true);
        TUSD8.approve(address(pay), 2.5e6);

        // 2.5 tUSD8 invoice vs 2 tUSD8 per-tx cap: the contract must refuse on the real token too.
        vm.prank(agent);
        vm.expectRevert(abi.encodeWithSelector(AgentInvoicePay.PerTxCapExceeded.selector, 2.5e6, 2e6));
        pay.payInvoice(bigOrder, 2.5e6);
        assertFalse(pay.isPaid(bigOrder));
    }
}
