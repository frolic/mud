// SPDX-License-Identifier: MIT
pragma solidity >=0.8.24;

import { Test } from "forge-std/Test.sol";
import { StoreMock } from "../StoreMock.sol";
import { StoreCore } from "../../src/StoreCore.sol";

// v2-generated table (the existing codegen)
import { Mixed, MixedData } from "../codegen/index.sol";
// v3-generated table with the identical schema
import { MixedV2, MixedV2Data, MixedV2RecordMethods } from "./codegen/MixedV2.sol";

/**
 * @notice Straight v2-vs-v3 gas diff on identical tables/operations (no v3 optimization).
 * Run: forge test --isolate --match-test testGasDiff -vv
 * Both use StoreSwitch dispatch (the default), so the comparison is apples-to-apples.
 */
contract GasV2VsV3Test is Test, StoreMock {
  bytes32 constant key = keccak256("k");

  function setUp() public {
    Mixed.register();
    string[] memory keyNames = new string[](1);
    keyNames[0] = "key";
    string[] memory fieldNames = new string[](4);
    fieldNames[0] = "u32";
    fieldNames[1] = "u128";
    fieldNames[2] = "a32";
    fieldNames[3] = "s";
    StoreCore.registerTable(
      MixedV2RecordMethods._tableId,
      MixedV2RecordMethods._fieldLayout,
      MixedV2RecordMethods._keySchema,
      MixedV2RecordMethods._valueSchema,
      keyNames,
      fieldNames
    );
  }

  function _sample() internal pure returns (uint32, uint128, uint32[] memory, string memory) {
    uint32[] memory a32 = new uint32[](2);
    a32[0] = 1;
    a32[1] = 2;
    return (7, 8, a32, "hello");
  }

  // --- v2 ops ---
  function v2SetRecord() external {
    (uint32 u32, uint128 u128, uint32[] memory a32, string memory s) = _sample();
    Mixed.set(key, u32, u128, a32, s);
  }
  function v2GetRecord() external view returns (MixedData memory) {
    return Mixed.get(key);
  }
  function v2SetField() external {
    Mixed.setU32(key, 42);
  }
  function v2GetField() external view returns (uint32) {
    return Mixed.getU32(key);
  }
  function v2Push() external {
    Mixed.pushA32(key, 9);
  }

  // --- v3 ops (identical schema/data) ---
  function v3SetRecord() external {
    (uint32 u32, uint128 u128, uint32[] memory a32, string memory s) = _sample();
    MixedV2(key).save(MixedV2Data({ u32: u32, u128: u128, a32: a32, s: s }));
  }
  function v3GetRecord() external view returns (MixedV2Data memory) {
    return MixedV2(key).load();
  }
  function v3SetField() external {
    MixedV2(key).u32().save(42);
  }
  function v3GetField() external view returns (uint32) {
    return MixedV2(key).u32().load();
  }
  function v3Push() external {
    MixedV2(key).a32().push(9);
  }

  function _emit(string memory label, uint256 g2, uint256 g3) internal {
    emit log_named_string("--- op", label);
    emit log_named_uint("v2", g2);
    emit log_named_uint("v3", g3);
    emit log_named_int("diff", int256(g3) - int256(g2));
  }

  function testGasDiff() public {
    // seed both tables and warm code paths
    this.v2SetRecord();
    this.v3SetRecord();

    this.v2SetRecord();
    uint256 a2 = vm.lastCallGas().gasTotalUsed;
    this.v3SetRecord();
    _emit("setRecord", a2, vm.lastCallGas().gasTotalUsed);

    this.v2GetRecord();
    a2 = vm.lastCallGas().gasTotalUsed;
    this.v3GetRecord();
    _emit("getRecord", a2, vm.lastCallGas().gasTotalUsed);

    this.v2SetField();
    a2 = vm.lastCallGas().gasTotalUsed;
    this.v3SetField();
    _emit("setField", a2, vm.lastCallGas().gasTotalUsed);

    this.v2GetField();
    a2 = vm.lastCallGas().gasTotalUsed;
    this.v3GetField();
    _emit("getField", a2, vm.lastCallGas().gasTotalUsed);

    this.v2Push();
    a2 = vm.lastCallGas().gasTotalUsed;
    this.v3Push();
    _emit("push", a2, vm.lastCallGas().gasTotalUsed);
  }
}
