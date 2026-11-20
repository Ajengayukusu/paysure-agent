// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

/// @title PayeeRegistry — Confirmation of Payee for Aevum / tUSD8 payments.
/// @notice Maps a human payee name (case-insensitive) to the address that name pays.
///         QDay's ERC-8004 registry is not open for this challenge, so the name -> address
///         mapping lives in this contract, as the starter kit docs instruct.
/// @dev Rules that stop name squatting / poisoning:
///      - A name, once registered, can never be overwritten by a different registrant.
///      - Self-registration can only point a name at the caller's own address.
///      - The registry owner (admin) may register/update/remove on behalf of others
///        (e.g. after off-chain verification) — every change emits an event.
///      - The registrant may update (to their own address) or remove their own name.
contract PayeeRegistry is Ownable {
    struct Entry {
        address payee;
        address registrant;
        bool exists;
    }

    mapping(bytes32 nameKey => Entry) private _entries;

    event PayeeRegistered(bytes32 indexed nameKey, string name, address indexed payee, address indexed registrant);
    event PayeeUpdated(bytes32 indexed nameKey, string name, address indexed payee, address indexed registrant);
    event PayeeRemoved(bytes32 indexed nameKey, string name, address indexed registrant);

    error EmptyName();
    error ZeroAddress();
    error NameTaken(bytes32 nameKey);
    error NameNotRegistered(bytes32 nameKey);
    error NotRegistrant(bytes32 nameKey);
    error SelfRegisterOnlyOwnAddress();

    constructor() Ownable(msg.sender) {}

    /// @notice The canonical key for a payee name: keccak256 of the lowercased name.
    function nameKeyOf(string memory name) public pure returns (bytes32) {
        bytes memory b = bytes(name);
        if (b.length == 0) revert EmptyName();
        for (uint256 i = 0; i < b.length; i++) {
            uint8 c = uint8(b[i]);
            if (c >= 0x41 && c <= 0x5A) b[i] = bytes1(c + 0x20); // A-Z -> a-z
        }
        return keccak256(b);
    }

    /// @notice Register `name` for `payee`. Self-service callers may only register their
    ///         own address; the owner may register any address.
    function register(string calldata name, address payee) external {
        if (payee == address(0)) revert ZeroAddress();
        if (msg.sender != owner() && payee != msg.sender) revert SelfRegisterOnlyOwnAddress();
        bytes32 key = nameKeyOf(name);
        if (_entries[key].exists) revert NameTaken(key);
        _entries[key] = Entry({payee: payee, registrant: msg.sender, exists: true});
        emit PayeeRegistered(key, name, payee, msg.sender);
    }

    /// @notice Change the address a registered name pays. Only the registrant (the name's
    ///         controller — e.g. rotating to a new wallet) or the owner may do this.
    function update(string calldata name, address newPayee) external {
        if (newPayee == address(0)) revert ZeroAddress();
        bytes32 key = nameKeyOf(name);
        Entry storage e = _entries[key];
        if (!e.exists) revert NameNotRegistered(key);
        if (msg.sender != owner() && msg.sender != e.registrant) revert NotRegistrant(key);
        e.payee = newPayee;
        emit PayeeUpdated(key, name, newPayee, e.registrant);
    }

    /// @notice Remove a registered name. Only the registrant or the owner.
    function remove(string calldata name) external {
        bytes32 key = nameKeyOf(name);
        Entry storage e = _entries[key];
        if (!e.exists) revert NameNotRegistered(key);
        if (msg.sender != owner() && msg.sender != e.registrant) revert NotRegistrant(key);
        address registrant = e.registrant;
        delete _entries[key];
        emit PayeeRemoved(key, name, registrant);
    }

    /// @notice Confirmation-of-Payee lookup: who does `name` pay, and is the name registered?
    function lookup(string calldata name) external view returns (address payee, bool registered) {
        Entry storage e = _entries[nameKeyOf(name)];
        return (e.payee, e.exists);
    }

    /// @notice Same lookup by precomputed name key (cheaper for on-chain callers).
    function lookupByKey(bytes32 nameKey) external view returns (address payee, bool registered) {
        Entry storage e = _entries[nameKey];
        return (e.payee, e.exists);
    }

    function entryOf(string calldata name) external view returns (Entry memory) {
        return _entries[nameKeyOf(name)];
    }
}
