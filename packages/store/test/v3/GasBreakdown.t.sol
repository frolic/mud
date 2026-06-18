// SPDX-License-Identifier: MIT
pragma solidity >=0.8.24;

import { Test } from "forge-std/Test.sol";
import { StoreMock } from "../StoreMock.sol";
import { StoreCore } from "../../src/StoreCore.sol";
import { ResourceId } from "../../src/ResourceId.sol";
import { FieldLayout } from "../../src/FieldLayout.sol";
import { Schema } from "../../src/Schema.sol";
import { Record, StoreAccess } from "../../src/v3/Record.sol";
import { Bytes32Field } from "../../src/v3/fields/Bytes32Field.sol";

import { MetadataBench, MetadataBenchData, MetadataBenchRecord, MetadataBenchRecordMethods } from "./codegen/MetadataBench.sol";

/// @notice Attributes the v3 handle read overhead to each layer, to separate failed
///         inlining from genuine allocation.
contract GasBreakdownTest is Test, StoreMock {
  ResourceId constant subject = ResourceId.wrap(bytes32(uint256(0x1234)));

  function setUp() public {
    string[] memory keyNames = new string[](1);
    keyNames[0] = "tableId";
    string[] memory fieldNames = new string[](5);
    fieldNames[0] = "fieldLayout";
    fieldNames[1] = "keySchema";
    fieldNames[2] = "valueSchema";
    fieldNames[3] = "abiEncodedKeyNames";
    fieldNames[4] = "abiEncodedFieldNames";
    StoreCore.registerTable(
      MetadataBenchRecordMethods._tableId,
      MetadataBenchRecordMethods._fieldLayout,
      MetadataBenchRecordMethods._keySchema,
      MetadataBenchRecordMethods._valueSchema,
      keyNames,
      fieldNames
    );
    MetadataBench(subject).own().save(
      MetadataBenchData({
        fieldLayout: FieldLayout.wrap(bytes32(uint256(0xAAAA))),
        keySchema: Schema.wrap(bytes32(uint256(0xBBBB))),
        valueSchema: Schema.wrap(bytes32(uint256(0xCCCC))),
        abiEncodedKeyNames: hex"01",
        abiEncodedFieldNames: hex"02"
      })
    );
  }

  function _meter(string memory label, uint256 used) internal {
    emit log_named_uint(label, used);
  }

  function readV2() external view returns (FieldLayout) {
    bytes32[] memory kt = new bytes32[](1);
    kt[0] = ResourceId.unwrap(subject);
    return
      FieldLayout.wrap(
        StoreCore.getStaticField(MetadataBenchRecordMethods._tableId, kt, 0, MetadataBenchRecordMethods._fieldLayout)
      );
  }

  function readV3() external view returns (FieldLayout) {
    return MetadataBench(subject).own().fieldLayout().load();
  }

  /// @notice Authoritative: measures whole-call gas via vm.lastCallGas (no gasleft() brackets).
  function testLastCallGas() public {
    this.readV2();
    this.readV3(); // warm both paths + storage
    this.readV2();
    uint256 v2 = vm.lastCallGas().gasTotalUsed;
    this.readV3();
    uint256 v3 = vm.lastCallGas().gasTotalUsed;
    _meter("v2 whole-call", v2);
    _meter("v3 whole-call", v3);
    emit log_named_int("overhead", int256(v3) - int256(v2));
  }

  /// @notice Apples-to-apples: both paths warm, both allocate a fresh keyTuple.
  function testFairComparison() public {
    ResourceId tableId = MetadataBenchRecordMethods._tableId;
    FieldLayout layout = MetadataBenchRecordMethods._fieldLayout;

    // warm the field's storage slot so neither path is charged the cold SLOAD
    bytes32[] memory warm = new bytes32[](1);
    warm[0] = ResourceId.unwrap(subject);
    StoreCore.getStaticField(tableId, warm, 0, layout);

    // v2-style: fresh keyTuple + direct StoreCore + manual cast (what `_getX` compiles to)
    uint256 g = gasleft();
    bytes32[] memory kt = new bytes32[](1);
    kt[0] = ResourceId.unwrap(subject);
    FieldLayout v2 = FieldLayout.wrap(StoreCore.getStaticField(tableId, kt, 0, layout));
    uint256 v2gas = g - gasleft();

    // v3: full handle chain
    g = gasleft();
    FieldLayout v3 = MetadataBench(subject).own().fieldLayout().load();
    uint256 v3gas = g - gasleft();

    assertEq(FieldLayout.unwrap(v2), FieldLayout.unwrap(v3));
    _meter("v2-style (warm, fresh keyTuple)", v2gas);
    _meter("v3 handle (warm, fresh keyTuple)", v3gas);
    emit log_named_int("true overhead", int256(v3gas) - int256(v2gas));
  }

  function testBreakdown() public {
    ResourceId tableId = MetadataBenchRecordMethods._tableId;
    FieldLayout layout = MetadataBenchRecordMethods._fieldLayout;

    // (A) bare StoreCore read with a pre-built keyTuple
    bytes32[] memory keyTuple = new bytes32[](1);
    keyTuple[0] = ResourceId.unwrap(subject);
    uint256 g = gasleft();
    bytes32 a = StoreCore.getStaticField(tableId, keyTuple, 0, layout);
    _meter("A bare StoreCore.getStaticField", g - gasleft());

    // (B) just allocate a fresh keyTuple (what every handle/v2-accessor pays)
    g = gasleft();
    bytes32[] memory kt2 = new bytes32[](1);
    kt2[0] = ResourceId.unwrap(subject);
    _meter("B fresh keyTuple alloc", g - gasleft());

    // (C) construct the record handle only (no read)
    g = gasleft();
    MetadataBenchRecord memory rec = MetadataBench(subject);
    _meter("C MetadataBench(subject) handle", g - gasleft());

    // (D) construct via own() (sets store)
    g = gasleft();
    MetadataBenchRecord memory rec2 = MetadataBench(subject).own();
    _meter("D + .own()", g - gasleft());

    // (E) StoreAccess.getStaticField directly on a prebuilt Record (isolates dispatch+read)
    Record memory raw = Record(tableId, keyTuple, address(this));
    g = gasleft();
    bytes32 e = StoreAccess.getStaticField(raw, 0, layout);
    _meter("E StoreAccess.getStaticField (own path)", g - gasleft());

    // (F) full v3 chain
    g = gasleft();
    FieldLayout f = MetadataBench(subject).own().fieldLayout().load();
    _meter("F full v3 chain", g - gasleft());

    // keep vars live
    assertTrue(a != bytes32(0) && e != bytes32(0));
    assertEq(FieldLayout.unwrap(f), uint256(0xAAAA) == 0 ? FieldLayout.unwrap(layout) : FieldLayout.unwrap(f));
    rec.record.store;
    rec2.record.store;
    kt2[0];
  }
}
