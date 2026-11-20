// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {PayeeRegistry} from "../src/PayeeRegistry.sol";

contract PayeeRegistryTest is Test {
    PayeeRegistry registry; // test contract is the registry owner
    address alice = makeAddr("alice");
    address bob = makeAddr("bob");
    address carol = makeAddr("carol");

    function setUp() public {
        registry = new PayeeRegistry();
    }

    function test_registerAndLookup() public {
        vm.prank(alice);
        registry.register("Alice Payee", alice);
        (address payee, bool registered) = registry.lookup("Alice Payee");
        assertEq(payee, alice);
        assertTrue(registered);
    }

    function test_lookupIsCaseInsensitive() public {
        vm.prank(alice);
        registry.register("Alice Payee", alice);
        (address payee, bool registered) = registry.lookup("ALICE PAYEE");
        assertEq(payee, alice);
        assertTrue(registered);
        assertEq(registry.nameKeyOf("Alice Payee"), registry.nameKeyOf("aLiCe PaYeE"));
    }

    function test_lookupUnregistered() public view {
        (address payee, bool registered) = registry.lookup("Nobody");
        assertEq(payee, address(0));
        assertFalse(registered);
    }

    function test_register_cannotOverwriteOthersName() public {
        vm.prank(alice);
        registry.register("Alice Payee", alice);
        bytes32 key = registry.nameKeyOf("Alice Payee");
        vm.prank(bob);
        vm.expectRevert(abi.encodeWithSelector(PayeeRegistry.NameTaken.selector, key));
        registry.register("Alice Payee", bob);
    }

    function test_register_caseVariantIsSameName() public {
        vm.prank(alice);
        registry.register("Alice Payee", alice);
        vm.prank(bob);
        vm.expectRevert();
        registry.register("ALICE PAYEE", bob);
    }

    function test_selfRegisterForAnotherAddress_reverts() public {
        vm.prank(bob);
        vm.expectRevert(PayeeRegistry.SelfRegisterOnlyOwnAddress.selector);
        registry.register("Bob Payee", alice);
    }

    function test_ownerCanRegisterForAnother() public {
        registry.register("Carol Payee", carol); // owner-managed registration
        (address payee, bool registered) = registry.lookup("Carol Payee");
        assertEq(payee, carol);
        assertTrue(registered);
    }

    function test_update_byRegistrantRotatesWallet() public {
        address aliceNew = makeAddr("aliceNew");
        vm.prank(alice);
        registry.register("Alice Payee", alice);
        vm.prank(alice);
        registry.update("Alice Payee", aliceNew);
        (address payee,) = registry.lookup("Alice Payee");
        assertEq(payee, aliceNew);
    }

    function test_update_byOwner() public {
        vm.prank(alice);
        registry.register("Alice Payee", alice);
        registry.update("Alice Payee", carol);
        (address payee,) = registry.lookup("Alice Payee");
        assertEq(payee, carol);
    }

    function test_update_byStranger_reverts() public {
        vm.prank(alice);
        registry.register("Alice Payee", alice);
        bytes32 key = registry.nameKeyOf("Alice Payee");
        vm.prank(bob);
        vm.expectRevert(abi.encodeWithSelector(PayeeRegistry.NotRegistrant.selector, key));
        registry.update("Alice Payee", bob);
    }

    function test_remove_byRegistrant_thenNameReusable() public {
        vm.prank(alice);
        registry.register("Alice Payee", alice);
        vm.prank(alice);
        registry.remove("Alice Payee");
        (, bool registered) = registry.lookup("Alice Payee");
        assertFalse(registered);
        // After removal the name is free again.
        vm.prank(bob);
        registry.register("Alice Payee", bob);
        (address payee,) = registry.lookup("Alice Payee");
        assertEq(payee, bob);
    }

    function test_remove_byStranger_reverts() public {
        vm.prank(alice);
        registry.register("Alice Payee", alice);
        vm.prank(bob);
        vm.expectRevert();
        registry.remove("Alice Payee");
    }

    function test_register_emptyNameAndZeroAddress_revert() public {
        vm.expectRevert(PayeeRegistry.EmptyName.selector);
        registry.register("", alice);
        vm.expectRevert(PayeeRegistry.ZeroAddress.selector);
        registry.register("Zero Payee", address(0));
    }
}
