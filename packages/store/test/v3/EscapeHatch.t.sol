// SPDX-License-Identifier: MIT
pragma solidity >=0.8.24;

import { Test } from "forge-std/Test.sol";
import { StoreMock } from "../StoreMock.sol";
import { StoreCore } from "../../src/StoreCore.sol";
import { EncodedLengths } from "../../src/EncodedLengths.sol";

import { Mixed, MixedData, MixedRecordMethods } from "./codegen/Mixed.sol";

/**
 * @notice The low-level composition escape hatch: compose a direct StoreCore call from
 *         the table lib's primitives (`_encodeKey`, `_decode`, `_encode`, `_tableId`,
 *         `_fieldLayout`) instead of building a handle — verbose, but skips the ~950
 *         gas/handle when a hot path needs it. No parallel accessor API; users lift
 *         these into their own helper. Each test asserts equivalence with the handle API.
 */
contract EscapeHatchTest is Test, StoreMock {
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
    uint32[] memory nums = new uint32[](1);
    nums[0] = 9;
    Mixed(id).save(MixedData({ num: -7, big: 99, owner: address(0xBEEF), flag: true, name: "hi", nums: nums }));
  }

  function testCompositionReadMatchesHandle() public view {
    // T._decode(StoreCore.getRecord(T._tableId, T._encodeKey(key)))
    (bytes memory s, EncodedLengths el, bytes memory d) = StoreCore.getRecord(
      MixedRecordMethods._tableId,
      MixedRecordMethods._encodeKey(id)
    );
    MixedData memory viaComposition = MixedRecordMethods._decode(s, el, d);
    MixedData memory viaHandle = Mixed(id).load();
    assertEq(viaComposition.big, viaHandle.big);
    assertEq(viaComposition.num, viaHandle.num);
    assertEq(viaComposition.name, viaHandle.name);
  }

  function testCompositionWriteMatchesHandle() public {
    MixedData memory next = MixedData({
      num: 5,
      big: 1234,
      owner: address(0xCAFE),
      flag: false,
      name: "world",
      nums: new uint32[](0)
    });
    (bytes memory s, EncodedLengths el, bytes memory d) = MixedRecordMethods._encode(next);
    StoreCore.setRecord(MixedRecordMethods._tableId, MixedRecordMethods._encodeKey(id), s, el, d);

    MixedData memory loaded = Mixed(id).load();
    assertEq(loaded.big, 1234);
    assertEq(loaded.name, "world");
  }

  function testCompositionStaticFieldMatchesHandle() public view {
    // single static field, no record/handle: getStaticField + the field's own cast
    bytes32 blob = StoreCore.getStaticField(
      MixedRecordMethods._tableId,
      MixedRecordMethods._encodeKey(id),
      0, // num
      MixedRecordMethods._fieldLayout
    );
    int32 num = int32(uint32(bytes4(blob)));
    assertEq(num, Mixed(id).num().load());
  }
}
