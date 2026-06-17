// SPDX-License-Identifier: MIT
pragma solidity >=0.8.24;

import { Test } from "forge-std/Test.sol";
import { StoreMock } from "../StoreMock.sol";
import { StoreCore } from "../../src/StoreCore.sol";

import { Mixed, MixedData, MixedRecord, MixedRecordMethods } from "./codegen/Mixed.sol";

/// @notice Round-trips the v3 generated `Mixed` table against a real store.
contract MixedV3Test is Test, StoreMock {
  bytes32 constant id = keccak256("key");

  function setUp() public {
    string[] memory keyNames = new string[](1);
    keyNames[0] = "id";
    string[] memory fieldNames = new string[](6);
    fieldNames[0] = "num";
    fieldNames[1] = "big";
    fieldNames[2] = "owner";
    fieldNames[3] = "flag";
    fieldNames[4] = "name";
    fieldNames[5] = "nums";
    StoreCore.registerTable(
      MixedRecordMethods._tableId,
      MixedRecordMethods._fieldLayout,
      MixedRecordMethods._keySchema,
      MixedRecordMethods._valueSchema,
      keyNames,
      fieldNames
    );
  }

  function _sample() internal pure returns (MixedData memory data) {
    data.num = -42;
    data.big = 123456789;
    data.owner = address(0xBEEF);
    data.flag = true;
    data.name = "hello world";
    data.nums = new uint32[](3);
    data.nums[0] = 1;
    data.nums[1] = 2;
    data.nums[2] = 3;
  }

  function _assertEq(MixedData memory a, MixedData memory b) internal pure {
    assertEq(a.num, b.num);
    assertEq(a.big, b.big);
    assertEq(a.owner, b.owner);
    assertEq(a.flag, b.flag);
    assertEq(a.name, b.name);
    assertEq(a.nums.length, b.nums.length);
    for (uint256 i; i < a.nums.length; i++) assertEq(a.nums[i], b.nums[i]);
  }

  function testRecordRoundTrip() public {
    MixedData memory data = _sample();
    Mixed(id).save(data);
    _assertEq(Mixed(id).load(), data);
  }

  function testMutateInPlaceThenSave() public {
    Mixed(id).save(_sample());
    MixedData memory data = Mixed(id).load();
    data.num += 1;
    data.name = "changed";
    Mixed(id).save(data);

    MixedData memory reloaded = Mixed(id).load();
    assertEq(reloaded.num, -41);
    assertEq(reloaded.name, "changed");
    assertEq(reloaded.big, data.big); // untouched
  }

  function testStaticFieldAccessor() public {
    Mixed(id).save(_sample());
    Mixed(id).num().save(7);
    assertEq(Mixed(id).num().load(), 7);
    assertEq(Mixed(id).big().load(), 123456789); // sibling untouched
    assertEq(Mixed(id).owner().load(), address(0xBEEF));
    assertEq(Mixed(id).flag().load(), true);
  }

  function testDynamicArrayElementOps() public {
    Mixed(id).save(_sample());
    assertEq(Mixed(id).nums().length(), 3);
    assertEq(Mixed(id).nums().load(1), 2);

    Mixed(id).nums().save(1, 99);
    assertEq(Mixed(id).nums().load(1), 99);

    Mixed(id).nums().push(4);
    assertEq(Mixed(id).nums().length(), 4);
    assertEq(Mixed(id).nums().load(3), 4);

    Mixed(id).nums().pop();
    assertEq(Mixed(id).nums().length(), 3);
  }

  function testStringFieldAccessor() public {
    Mixed(id).save(_sample());
    Mixed(id).name().save("renamed");
    assertEq(Mixed(id).name().load(), "renamed");
    assertEq(Mixed(id).name().length(), 7);
  }

  function testDestroy() public {
    Mixed(id).save(_sample());
    Mixed(id).destroy();
    MixedData memory empty = Mixed(id).load();
    assertEq(empty.num, 0);
    assertEq(empty.big, 0);
    assertEq(empty.name, "");
    assertEq(empty.nums.length, 0);
  }

  function testOwnExplicitStore() public {
    // Routing through an explicit store (this contract, an IStore) must match the default path.
    MixedData memory data = _sample();
    Mixed(id).own(address(this)).save(data);
    _assertEq(Mixed(id).own(address(this)).load(), data);
    _assertEq(Mixed(id).load(), data); // same data visible via the default path
  }
}
