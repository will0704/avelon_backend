// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/**
 * Minimal stand-in for forge-std. The official package is only distributed via
 * git, and the `forge-std` name on npm is a stale third-party mirror, so the
 * handful of cheatcodes and assertions we actually use are declared here instead.
 * Cheatcodes are the standard revm ones the Hardhat test runner already provides.
 */
interface Vm {
    function warp(uint256 newTimestamp) external;
    function deal(address who, uint256 newBalance) external;
    function prank(address sender) external;
    function expectRevert(bytes4 revertData) external;
    function expectEmit(bool checkTopic1, bool checkTopic2, bool checkTopic3, bool checkData, address emitter) external;
}

contract Harness {
    Vm internal constant vm = Vm(0x7109709ECfa91a80626fF3989D68f67F5b1DD12D);

    error AssertionFailed(string what);
    error AssertionFailedUint(string what, uint256 expected, uint256 actual);

    function assertTrue(bool condition, string memory what) internal pure {
        if (!condition) revert AssertionFailed(what);
    }

    function assertFalse(bool condition, string memory what) internal pure {
        if (condition) revert AssertionFailed(what);
    }

    function assertEq(uint256 actual, uint256 expected, string memory what) internal pure {
        if (actual != expected) revert AssertionFailedUint(what, expected, actual);
    }
}
