// SPDX-License-Identifier: MIT
pragma solidity >=0.8.24;

import { Test } from "forge-std/Test.sol";
import { StoreMock } from "../StoreMock.sol";
import { StoreCore } from "../../src/StoreCore.sol";
import { StoreSwitch } from "../../src/StoreSwitch.sol";
import { ResourceId } from "../../src/ResourceId.sol";
import { FieldLayout } from "../../src/FieldLayout.sol";

import { Mixed, MixedData, MixedRecordMethods } from "./codegen/Mixed.sol";

/// @dev A flattened, single-key handle: carries `bytes32 key` (not a dynamic `bytes32[]`)
///      and inlines its own fields (no nested `Record`). Tests whether the dynamic array +
///      struct nesting is what via-IR charges for.
struct LeanField {
  ResourceId tableId;
  bytes32 key;
  address store;
  FieldLayout fieldLayout;
  uint8 index;
}

/// @notice Realistic-case gas under the via-IR baseline (run: forge test --isolate --via-ir).
/// The headline ~1,490 overhead was the worst case — a user-type field, single isolated read.
/// These measure what app code actually does: plain fields, default dispatch, whole records.
contract GasReductionTest is Test, StoreMock {
  bytes32 constant id = keccak256("k");

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
    uint32[] memory nums = new uint32[](2);
    nums[0] = 1;
    nums[1] = 2;
    Mixed(id).save(MixedData({ num: -7, big: 99, owner: address(0xBEEF), flag: true, name: "hi", nums: nums }));
  }

  // All three use the SAME dispatch (StoreSwitch default), so the store-address SLOAD cancels.
  function readPlainV2() external view returns (int32) {
    bytes32[] memory kt = new bytes32[](1);
    kt[0] = id;
    return
      int32(
        uint32(bytes4(StoreSwitch.getStaticField(MixedRecordMethods._tableId, kt, 0, MixedRecordMethods._fieldLayout)))
      );
  }

  function readPlainV3() external view returns (int32) {
    return Mixed(id).num().load();
  }

  function readLean() external view returns (int32) {
    LeanField memory f = LeanField(MixedRecordMethods._tableId, id, address(0), MixedRecordMethods._fieldLayout, 0);
    bytes32[] memory kt = new bytes32[](1);
    kt[0] = f.key;
    return int32(uint32(bytes4(StoreSwitch.getStaticField(f.tableId, kt, f.index, f.fieldLayout))));
  }

  function readWholeRecordV3() external view returns (MixedData memory) {
    return Mixed(id).load();
  }

  function testRealisticGas() public {
    this.readPlainV2();
    this.readPlainV3();
    this.readLean();
    this.readWholeRecordV3(); // warm

    this.readPlainV2();
    uint256 plainV2 = vm.lastCallGas().gasTotalUsed;
    this.readPlainV3();
    uint256 plainV3 = vm.lastCallGas().gasTotalUsed;
    this.readLean();
    uint256 lean = vm.lastCallGas().gasTotalUsed;
    this.readWholeRecordV3();
    uint256 wholeRecord = vm.lastCallGas().gasTotalUsed;

    emit log_named_uint("v2 getX (StoreSwitch)", plainV2);
    emit log_named_uint("v3 handle (StoreSwitch)", plainV3);
    emit log_named_uint("lean single-key handle", lean);
    emit log_named_int("v3 overhead vs v2", int256(plainV3) - int256(plainV2));
    emit log_named_int("lean overhead vs v2", int256(lean) - int256(plainV2));
    emit log_named_uint("whole-record load v3 (6 fields, 1 handle)", wholeRecord);
  }
}
