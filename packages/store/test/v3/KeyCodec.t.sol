// SPDX-License-Identifier: MIT
pragma solidity >=0.8.24;

import { Test } from "forge-std/Test.sol";
import { KeyedRecordMethods } from "./codegen/Keyed.sol";

/// @notice Round-trips _encodeKey/_decodeKey across every static key-type family.
contract KeyCodecTest is Test {
  function testKeyRoundTrip() public pure {
    uint256 a = 12345;
    int32 b = -678;
    address c = address(0xC0FFEE);
    bool d = true;
    bytes16 e = bytes16(keccak256("e"));

    bytes32[] memory keyTuple = KeyedRecordMethods._encodeKey(a, b, c, d, e);
    (uint256 a2, int32 b2, address c2, bool d2, bytes16 e2) = KeyedRecordMethods._decodeKey(keyTuple);

    assertEq(a2, a);
    assertEq(b2, b);
    assertEq(c2, c);
    assertEq(d2, d);
    assertEq(e2, e);
  }
}
