// SPDX-License-Identifier: MIT
pragma solidity >=0.8.24;

import { Test } from "forge-std/Test.sol";
import { StoreMock } from "../StoreMock.sol";
import { StoreCore } from "../../src/StoreCore.sol";

import { MyId } from "./MyId.sol";
import { Owned, OwnedData, OwnedRecordMethods } from "./codegen/Owned.sol";

/// @notice Exercises user-type fields (a UDVT as both key and value) in v3 codegen.
contract OwnedV3Test is Test, StoreMock {
  MyId constant entity = MyId.wrap(bytes32(uint256(1)));
  MyId constant owner = MyId.wrap(bytes32(uint256(0xABCD)));

  function setUp() public {
    string[] memory keyNames = new string[](1);
    keyNames[0] = "entity";
    string[] memory fieldNames = new string[](2);
    fieldNames[0] = "owner";
    fieldNames[1] = "score";
    StoreCore.registerTable(
      OwnedRecordMethods._tableId,
      OwnedRecordMethods._fieldLayout,
      OwnedRecordMethods._keySchema,
      OwnedRecordMethods._valueSchema,
      keyNames,
      fieldNames
    );
  }

  function testRecordRoundTripWithUserType() public {
    Owned(entity).save(OwnedData({ owner: owner, score: 42 }));
    OwnedData memory data = Owned(entity).load();
    assertEq(MyId.unwrap(data.owner), MyId.unwrap(owner));
    assertEq(data.score, 42);
  }

  function testUserTypeFieldAccessor() public {
    Owned(entity).save(OwnedData({ owner: owner, score: 42 }));

    MyId loaded = Owned(entity).owner().load();
    assertEq(MyId.unwrap(loaded), MyId.unwrap(owner));

    MyId next = MyId.wrap(bytes32(uint256(0x1234)));
    Owned(entity).owner().save(next);
    assertEq(MyId.unwrap(Owned(entity).owner().load()), MyId.unwrap(next));
    assertEq(Owned(entity).score().load(), 42); // sibling untouched
  }
}
