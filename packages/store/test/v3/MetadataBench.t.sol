// SPDX-License-Identifier: MIT
pragma solidity >=0.8.24;

import { Test } from "forge-std/Test.sol";
import { StoreMock } from "../StoreMock.sol";
import { StoreCore } from "../../src/StoreCore.sol";
import { ResourceId } from "../../src/ResourceId.sol";
import { FieldLayout } from "../../src/FieldLayout.sol";
import { Schema } from "../../src/Schema.sol";

import { MetadataBench, MetadataBenchData, MetadataBenchRecordMethods } from "./codegen/MetadataBench.sol";

/**
 * @notice Hot-path gas check for the v3 cutover (design concern #2).
 *
 * `StoreCore` reads its core metadata tables (e.g. `getFieldLayout`) on every store
 * op. This measures a v3 handle field read — `MetadataBench(id).own().fieldLayout().load()`,
 * which allocates the handle and routes through `StoreAccess` → `StoreCore` — against
 * the bare `StoreCore.getStaticField` path the v2 `_get` variants compile to. The delta
 * is the per-op overhead the cutover would add to the store's hot path.
 */
contract MetadataBenchTest is Test, StoreMock {
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

  function testHotPathFieldRead() public {
    bytes32[] memory keyTuple = new bytes32[](1);
    keyTuple[0] = ResourceId.unwrap(subject);

    // v3 handle read
    uint256 g0 = gasleft();
    FieldLayout viaHandle = MetadataBench(subject).own().fieldLayout().load();
    uint256 v3Gas = g0 - gasleft();

    // bare StoreCore read (what the v2 `_getFieldLayout` variant compiles to)
    uint256 g1 = gasleft();
    FieldLayout viaCore = FieldLayout.wrap(
      StoreCore.getStaticField(
        MetadataBenchRecordMethods._tableId,
        keyTuple,
        0,
        MetadataBenchRecordMethods._fieldLayout
      )
    );
    uint256 coreGas = g1 - gasleft();

    assertEq(FieldLayout.unwrap(viaHandle), FieldLayout.unwrap(viaCore));
    emit log_named_uint("v3 handle read gas", v3Gas);
    emit log_named_uint("bare StoreCore read gas", coreGas);
    emit log_named_int("overhead", int256(v3Gas) - int256(coreGas));
  }
}
