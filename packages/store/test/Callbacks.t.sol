// SPDX-License-Identifier: MIT
pragma solidity >=0.8.24;

import { Test } from "forge-std/Test.sol";
import { GasReporter } from "@latticexyz/gas-report/src/GasReporter.sol";
import { Callbacks, CallbacksRecordMethods } from "./codegen/tables/Callbacks.sol";
import { StoreMock } from "./StoreMock.sol";
import { Schema, SchemaLib, SchemaType } from "../src/Schema.sol";

contract CallbacksTest is Test, GasReporter, StoreMock {
  function testSetAndGet() public {
    CallbacksRecordMethods.register();
    bytes32 key = keccak256("somekey");

    bytes24[] memory callbacks = new bytes24[](1);
    callbacks[0] = bytes24(abi.encode(this.testSetAndGet));

    startGasReport("Callbacks: set field");
    Callbacks(key).value().save(callbacks);
    endGasReport();

    startGasReport("Callbacks: get field (warm)");
    bytes24[] memory returnedCallbacks = Callbacks(key).value().load();
    endGasReport();

    assertEq(returnedCallbacks.length, callbacks.length);
    assertEq(returnedCallbacks[0], callbacks[0]);

    startGasReport("Callbacks: push 1 element");
    Callbacks(key).value().push(callbacks[0]);
    endGasReport();

    returnedCallbacks = Callbacks(key).value().load();

    assertEq(returnedCallbacks.length, 2);
    assertEq(returnedCallbacks[1], callbacks[0]);
  }

  function testKeySchemaEncoding() public {
    SchemaType[] memory _keySchema = new SchemaType[](1);
    _keySchema[0] = SchemaType.BYTES32;

    assertEq(Schema.unwrap(SchemaLib.encode(_keySchema)), Schema.unwrap(CallbacksRecordMethods._keySchema));
  }

  function testValueSchemaEncoding() public {
    SchemaType[] memory _valueSchema = new SchemaType[](1);
    _valueSchema[0] = SchemaType.BYTES24_ARRAY;

    assertEq(Schema.unwrap(SchemaLib.encode(_valueSchema)), Schema.unwrap(CallbacksRecordMethods._valueSchema));
  }
}
