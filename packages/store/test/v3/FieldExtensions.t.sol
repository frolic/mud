// SPDX-License-Identifier: MIT
pragma solidity >=0.8.24;

import { Test } from "forge-std/Test.sol";
import { StoreMock } from "../StoreMock.sol";

import { Uint256Field } from "../../src/fields/Uint256Field.sol";
import { Uint32ArrayField } from "../../src/fields/Uint32ArrayField.sol";

import { Mixed, MixedData, MixedRecordMethods } from "./codegen/Mixed.sol";
import { Owned, OwnedData, OwnedRecordMethods } from "./codegen/Owned.sol";
import { MyId } from "./MyId.sol";

/**
 * @notice Worked examples of the v3 perks, centered on the headline one: field handles
 *         are shared, first-class value types. There is ONE `Uint256Field` type for every
 *         `uint256` field of every table, so you can attach your own behavior to it with a
 *         plain `using ... for` — in your own file, no codegen edits, no per-table
 *         boilerplate — and it applies everywhere that field type appears.
 *
 *         In v2 the equivalent meant editing generated table libraries (or wrapping each
 *         table's bespoke getter/setter); there was no shared field type to extend.
 */

// A user-authored extension on the NATIVE uint256 field handle. Written once here; it now
// works on Mixed.big, Owned.score, and every other uint256 field in the project.
library Counter {
  function increment(Uint256Field memory self) internal returns (uint256 next) {
    next = self.load() + 1;
    self.save(next);
  }

  function add(Uint256Field memory self, uint256 amount) internal returns (uint256 next) {
    next = self.load() + amount;
    self.save(next);
  }
}

// Extensions work on dynamic-array field handles just as well.
library Uint32ArrayStats {
  function sum(Uint32ArrayField memory self) internal view returns (uint256 total) {
    uint32[] memory values = self.load();
    for (uint256 i; i < values.length; i++) total += values[i];
  }
}

// File-scoped `using` — the consumer opts in from their own code; the field type and the
// generated tables are untouched. (`global` at the type's definition would make it ambient.)
using Counter for Uint256Field;
using Uint32ArrayStats for Uint32ArrayField;

contract FieldExtensionsTest is Test, StoreMock {
  bytes32 constant id = keccak256("player");
  MyId constant entity = MyId.wrap(bytes32(uint256(0xE1)));

  function setUp() public {
    MixedRecordMethods.register();
    OwnedRecordMethods.register();
  }

  function _seedMixed(uint256 big, uint32[] memory nums) internal {
    Mixed(id).save(MixedData({ num: 0, big: big, owner: address(0), flag: false, name: "", nums: nums }));
  }

  /// @notice Attach a method to the native uint256 field handle and call it inline on a table field.
  function testExtendNativeFieldType() public {
    _seedMixed(10, new uint32[](0));

    // `.big()` returns a shared `Uint256Field`; `using Counter` gives it `.increment()`/`.add()`.
    assertEq(Mixed(id).big().increment(), 11);
    assertEq(Mixed(id).big().add(89), 100);
    assertEq(Mixed(id).big().load(), 100); // persisted to storage, not just the in-memory handle
  }

  /// @notice The SAME extension applies to a different table's uint256 field — write once, reuse everywhere.
  function testExtensionReusedAcrossTables() public {
    _seedMixed(5, new uint32[](0));
    Owned(entity).save(OwnedData({ owner: entity, score: 5 }));

    Mixed(id).big().add(10); // Mixed.big
    Owned(entity).score().add(10); // Owned.score — one `Counter` library, two unrelated tables

    assertEq(Mixed(id).big().load(), 15);
    assertEq(Owned(entity).score().load(), 15);
  }

  /// @notice Field handles are first-class values: pass one to a function and it still reads/writes storage.
  function testFieldHandleIsAValue() public {
    _seedMixed(0, new uint32[](0));
    _bumpTwice(Mixed(id).big());
    assertEq(Mixed(id).big().load(), 2);
  }

  function _bumpTwice(Uint256Field memory field) internal {
    field.increment();
    field.increment();
  }

  /// @notice Extending a dynamic-array field handle works the same way.
  function testExtendArrayFieldType() public {
    uint32[] memory nums = new uint32[](3);
    nums[0] = 1;
    nums[1] = 2;
    nums[2] = 3;
    _seedMixed(0, nums);

    assertEq(Mixed(id).nums().sum(), 6);
  }
}
