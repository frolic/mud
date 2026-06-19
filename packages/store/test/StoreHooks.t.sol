// SPDX-License-Identifier: MIT
pragma solidity >=0.8.24;

import { Test } from "forge-std/Test.sol";
import { GasReporter } from "@latticexyz/gas-report/src/GasReporter.sol";
import { ResourceId } from "../src/ResourceId.sol";
import { StoreHooks } from "../src/codegen/tables/StoreHooks.sol";
import { StoreMock } from "./StoreMock.sol";

contract StoreHooksTest is Test, GasReporter, StoreMock {
  function testTable() public {
    // StoreHooks table is already registered by StoreMock
    ResourceId key = ResourceId.wrap(keccak256("somekey"));

    bytes21[] memory hooks = new bytes21[](1);
    hooks[0] = bytes21("some data");

    startGasReport("StoreHooks: set field (cold)");
    StoreHooks(key).hooks().save(hooks);
    endGasReport();

    startGasReport("StoreHooks: get field (warm)");
    bytes21[] memory returnedHooks = StoreHooks(key).hooks().load();
    endGasReport();

    assertEq(returnedHooks.length, hooks.length);
    assertEq(returnedHooks[0], hooks[0]);

    startGasReport("StoreHooks: push 1 element (cold)");
    StoreHooks(key).hooks().push(hooks[0]);
    endGasReport();

    returnedHooks = StoreHooks(key).hooks().load();

    assertEq(returnedHooks.length, 2);
    assertEq(returnedHooks[1], hooks[0]);

    startGasReport("StoreHooks: pop 1 element (warm)");
    StoreHooks(key).hooks().pop();
    endGasReport();

    returnedHooks = StoreHooks(key).hooks().load();

    assertEq(returnedHooks.length, 1);
    assertEq(returnedHooks[0], hooks[0]);

    startGasReport("StoreHooks: push 1 element (warm)");
    StoreHooks(key).hooks().push(hooks[0]);
    endGasReport();

    returnedHooks = StoreHooks(key).hooks().load();

    assertEq(returnedHooks.length, 2);
    assertEq(returnedHooks[1], hooks[0]);

    bytes21 newHook = bytes21(keccak256("alice"));
    startGasReport("StoreHooks: update 1 element (warm)");
    StoreHooks(key).hooks().save(1, newHook);
    endGasReport();

    returnedHooks = StoreHooks(key).hooks().load();
    assertEq(returnedHooks.length, 2);
    assertEq(returnedHooks[0], hooks[0]);
    assertEq(returnedHooks[1], newHook);

    startGasReport("StoreHooks: delete record (warm)");
    StoreHooks(key).destroy();
    endGasReport();

    returnedHooks = StoreHooks(key).hooks().load();
    assertEq(returnedHooks.length, 0);

    startGasReport("StoreHooks: set field (warm)");
    StoreHooks(key).hooks().save(hooks);
    endGasReport();
  }

  function testOneSlot() public {
    ResourceId key1 = ResourceId.wrap(keccak256("somekey"));
    bytes21[] memory hooks = new bytes21[](1);
    hooks[0] = bytes21("some data");

    startGasReport("StoreHooks: set field with one elements (cold)");
    StoreHooks(key1).hooks().save(hooks);
    endGasReport();
  }

  function testTwoSlots() public {
    ResourceId key2 = ResourceId.wrap(keccak256("somekey"));
    bytes21[] memory hooks = new bytes21[](2);
    hooks[0] = bytes21("some data");
    hooks[1] = bytes21("some other data");

    startGasReport("StoreHooks: set field with two elements (cold)");
    StoreHooks(key2).hooks().save(hooks);
    endGasReport();
  }

  function testThreeSlots() public {
    ResourceId key3 = ResourceId.wrap(keccak256("somekey"));
    bytes21[] memory hooks = new bytes21[](3);
    hooks[0] = bytes21("some data");
    hooks[1] = bytes21("some other data");
    hooks[2] = bytes21("some other other data");

    startGasReport("StoreHooks: set field with three elements (cold)");
    StoreHooks(key3).hooks().save(hooks);
    endGasReport();
  }
}
