// SPDX-License-Identifier: MIT
pragma solidity >=0.8.24;

import { IStore } from "../IStore.sol";
import { StoreSwitch } from "../StoreSwitch.sol";
import { StoreCore } from "../StoreCore.sol";
import { ResourceId } from "../ResourceId.sol";
import { FieldLayout } from "../FieldLayout.sol";
import { EncodedLengths } from "../EncodedLengths.sol";

/**
 * @notice A located record: a table id, the key it lives at, and which store owns it.
 * @dev This is the runtime-variable identity that every generated table handle wraps.
 *      `store` selects where reads/writes go (see {StoreAccess}); it is the only
 *      dispatch state. `FieldLayout` is intentionally NOT here — it is derived from
 *      the table and supplied as a constant by generated code.
 */
struct Record {
  ResourceId tableId;
  bytes32[] keyTuple;
  address store;
}

/**
 * @notice The single point of store dispatch.
 * @dev Every read/write in the v3 runtime goes through here, and this is the only
 *      place that names {StoreSwitch}, {StoreCore}, or {IStore}. The rule is uniform:
 *
 *        store == address(0)     ->  StoreSwitch (infer the store from execution context)
 *        store == address(this)  ->  StoreCore   (this contract IS the store; call internally)
 *        otherwise               ->  IStore(store) (an explicit external store)
 *
 *      `own()` on a handle pins `store` to `address(this)`, taking the gas-optimal
 *      internal path; the unpinned default stays correct in every context. Because
 *      these functions are `internal` (inlined into the caller), `address(this)` is
 *      the calling contract.
 */
library StoreAccess {
  function getRecord(Record memory self) internal view returns (bytes memory, EncodedLengths, bytes memory) {
    if (self.store == address(0)) return StoreSwitch.getRecord(self.tableId, self.keyTuple);
    if (self.store == address(this)) return StoreCore.getRecord(self.tableId, self.keyTuple);
    return IStore(self.store).getRecord(self.tableId, self.keyTuple);
  }

  /// @dev Layout-passing variant: skips the store's `getFieldLayout` lookup (a storage read,
  ///      cold on first table access) by supplying the table's compile-time-constant layout.
  function getRecord(
    Record memory self,
    FieldLayout fieldLayout
  ) internal view returns (bytes memory, EncodedLengths, bytes memory) {
    if (self.store == address(0)) return StoreSwitch.getRecord(self.tableId, self.keyTuple, fieldLayout);
    if (self.store == address(this)) return StoreCore.getRecord(self.tableId, self.keyTuple, fieldLayout);
    return IStore(self.store).getRecord(self.tableId, self.keyTuple, fieldLayout);
  }

  function setRecord(
    Record memory self,
    bytes memory staticData,
    EncodedLengths encodedLengths,
    bytes memory dynamicData
  ) internal {
    if (self.store == address(0)) {
      StoreSwitch.setRecord(self.tableId, self.keyTuple, staticData, encodedLengths, dynamicData);
    } else if (self.store == address(this)) {
      StoreCore.setRecord(self.tableId, self.keyTuple, staticData, encodedLengths, dynamicData);
    } else {
      IStore(self.store).setRecord(self.tableId, self.keyTuple, staticData, encodedLengths, dynamicData);
    }
  }

  /// @dev Layout-passing variant. Only the self-store (StoreCore) path skips the layout lookup —
  ///      the external `IStore`/`StoreSwitch` write interface has no layout-passing overload, so
  ///      those branches fall back to the lookup. (Reads expose it on all three; writes don't.)
  function setRecord(
    Record memory self,
    bytes memory staticData,
    EncodedLengths encodedLengths,
    bytes memory dynamicData,
    FieldLayout fieldLayout
  ) internal {
    if (self.store == address(0)) {
      StoreSwitch.setRecord(self.tableId, self.keyTuple, staticData, encodedLengths, dynamicData);
    } else if (self.store == address(this)) {
      StoreCore.setRecord(self.tableId, self.keyTuple, staticData, encodedLengths, dynamicData, fieldLayout);
    } else {
      IStore(self.store).setRecord(self.tableId, self.keyTuple, staticData, encodedLengths, dynamicData);
    }
  }

  function deleteRecord(Record memory self) internal {
    if (self.store == address(0)) StoreSwitch.deleteRecord(self.tableId, self.keyTuple);
    else if (self.store == address(this)) StoreCore.deleteRecord(self.tableId, self.keyTuple);
    else IStore(self.store).deleteRecord(self.tableId, self.keyTuple);
  }

  /// @dev Layout-passing variant (see {setRecord}); self-store path only.
  function deleteRecord(Record memory self, FieldLayout fieldLayout) internal {
    if (self.store == address(0)) StoreSwitch.deleteRecord(self.tableId, self.keyTuple);
    else if (self.store == address(this)) StoreCore.deleteRecord(self.tableId, self.keyTuple, fieldLayout);
    else IStore(self.store).deleteRecord(self.tableId, self.keyTuple);
  }

  function getStaticField(
    Record memory self,
    uint8 fieldIndex,
    FieldLayout fieldLayout
  ) internal view returns (bytes32) {
    if (self.store == address(0))
      return StoreSwitch.getStaticField(self.tableId, self.keyTuple, fieldIndex, fieldLayout);
    if (self.store == address(this))
      return StoreCore.getStaticField(self.tableId, self.keyTuple, fieldIndex, fieldLayout);
    return IStore(self.store).getStaticField(self.tableId, self.keyTuple, fieldIndex, fieldLayout);
  }

  function setStaticField(Record memory self, uint8 fieldIndex, bytes memory data, FieldLayout fieldLayout) internal {
    if (self.store == address(0))
      StoreSwitch.setStaticField(self.tableId, self.keyTuple, fieldIndex, data, fieldLayout);
    else if (self.store == address(this))
      StoreCore.setStaticField(self.tableId, self.keyTuple, fieldIndex, data, fieldLayout);
    else IStore(self.store).setStaticField(self.tableId, self.keyTuple, fieldIndex, data, fieldLayout);
  }

  function getDynamicField(Record memory self, uint8 dynamicFieldIndex) internal view returns (bytes memory) {
    if (self.store == address(0)) return StoreSwitch.getDynamicField(self.tableId, self.keyTuple, dynamicFieldIndex);
    if (self.store == address(this)) return StoreCore.getDynamicField(self.tableId, self.keyTuple, dynamicFieldIndex);
    return IStore(self.store).getDynamicField(self.tableId, self.keyTuple, dynamicFieldIndex);
  }

  function setDynamicField(Record memory self, uint8 dynamicFieldIndex, bytes memory data) internal {
    if (self.store == address(0)) StoreSwitch.setDynamicField(self.tableId, self.keyTuple, dynamicFieldIndex, data);
    else if (self.store == address(this))
      StoreCore.setDynamicField(self.tableId, self.keyTuple, dynamicFieldIndex, data);
    else IStore(self.store).setDynamicField(self.tableId, self.keyTuple, dynamicFieldIndex, data);
  }

  function getDynamicFieldLength(Record memory self, uint8 dynamicFieldIndex) internal view returns (uint256) {
    if (self.store == address(0))
      return StoreSwitch.getDynamicFieldLength(self.tableId, self.keyTuple, dynamicFieldIndex);
    if (self.store == address(this))
      return StoreCore.getDynamicFieldLength(self.tableId, self.keyTuple, dynamicFieldIndex);
    return IStore(self.store).getDynamicFieldLength(self.tableId, self.keyTuple, dynamicFieldIndex);
  }

  function getDynamicFieldSlice(
    Record memory self,
    uint8 dynamicFieldIndex,
    uint256 start,
    uint256 end
  ) internal view returns (bytes memory) {
    if (self.store == address(0))
      return StoreSwitch.getDynamicFieldSlice(self.tableId, self.keyTuple, dynamicFieldIndex, start, end);
    if (self.store == address(this))
      return StoreCore.getDynamicFieldSlice(self.tableId, self.keyTuple, dynamicFieldIndex, start, end);
    return IStore(self.store).getDynamicFieldSlice(self.tableId, self.keyTuple, dynamicFieldIndex, start, end);
  }

  function pushToDynamicField(Record memory self, uint8 dynamicFieldIndex, bytes memory data) internal {
    if (self.store == address(0)) StoreSwitch.pushToDynamicField(self.tableId, self.keyTuple, dynamicFieldIndex, data);
    else if (self.store == address(this))
      StoreCore.pushToDynamicField(self.tableId, self.keyTuple, dynamicFieldIndex, data);
    else IStore(self.store).pushToDynamicField(self.tableId, self.keyTuple, dynamicFieldIndex, data);
  }

  function popFromDynamicField(Record memory self, uint8 dynamicFieldIndex, uint256 byteLengthToPop) internal {
    if (self.store == address(0))
      StoreSwitch.popFromDynamicField(self.tableId, self.keyTuple, dynamicFieldIndex, byteLengthToPop);
    else if (self.store == address(this))
      StoreCore.popFromDynamicField(self.tableId, self.keyTuple, dynamicFieldIndex, byteLengthToPop);
    else IStore(self.store).popFromDynamicField(self.tableId, self.keyTuple, dynamicFieldIndex, byteLengthToPop);
  }

  function spliceDynamicData(
    Record memory self,
    uint8 dynamicFieldIndex,
    uint40 startWithinField,
    uint40 deleteCount,
    bytes memory data
  ) internal {
    if (self.store == address(0)) {
      StoreSwitch.spliceDynamicData(
        self.tableId,
        self.keyTuple,
        dynamicFieldIndex,
        startWithinField,
        deleteCount,
        data
      );
    } else if (self.store == address(this)) {
      StoreCore.spliceDynamicData(self.tableId, self.keyTuple, dynamicFieldIndex, startWithinField, deleteCount, data);
    } else {
      IStore(self.store).spliceDynamicData(
        self.tableId,
        self.keyTuple,
        dynamicFieldIndex,
        startWithinField,
        deleteCount,
        data
      );
    }
  }
}

/**
 * @notice Table-agnostic whole-record operations, shared by every generated table.
 * @dev Generated `load`/`save`/`destroy` are thin wrappers over these; the generated
 *      side only adds encode/decode of the specific record struct.
 */
library RecordMethods {
  function load(Record memory self) internal view returns (bytes memory, EncodedLengths, bytes memory) {
    return StoreAccess.getRecord(self);
  }

  /// @dev Layout-passing variant: generated `load` calls this with the table's constant layout,
  ///      skipping the store's `getFieldLayout` lookup. Plain `load` is for generic/infra callers.
  function load(
    Record memory self,
    FieldLayout fieldLayout
  ) internal view returns (bytes memory, EncodedLengths, bytes memory) {
    return StoreAccess.getRecord(self, fieldLayout);
  }

  function save(
    Record memory self,
    bytes memory staticData,
    EncodedLengths encodedLengths,
    bytes memory dynamicData
  ) internal {
    StoreAccess.setRecord(self, staticData, encodedLengths, dynamicData);
  }

  /// @dev Layout-passing variant (see {load}).
  function save(
    Record memory self,
    bytes memory staticData,
    EncodedLengths encodedLengths,
    bytes memory dynamicData,
    FieldLayout fieldLayout
  ) internal {
    StoreAccess.setRecord(self, staticData, encodedLengths, dynamicData, fieldLayout);
  }

  function destroy(Record memory self) internal {
    StoreAccess.deleteRecord(self);
  }

  /// @dev Layout-passing variant (see {load}).
  function destroy(Record memory self, FieldLayout fieldLayout) internal {
    StoreAccess.deleteRecord(self, fieldLayout);
  }
}
