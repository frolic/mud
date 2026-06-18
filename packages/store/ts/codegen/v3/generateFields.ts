import { fileURLToPath } from "node:url";
import path from "node:path";
import fs from "node:fs/promises";
import { formatSolidity } from "@latticexyz/common/codegen";
import { code } from "./render";
import { abiTypeInfo } from "./abiType";
import { cast } from "./staticCast";

/**
 * Generates the shared field libraries — one per ABI type — into `src/v3/fields/`.
 * These are the "written once" codecs the design centralizes: every `uint32` field
 * of every table shares `Uint32FieldLib`. Hand-writing ~200 of them would be absurd,
 * so they're generated; the per-family cast logic lives in `cast()` below.
 *
 * Run: `pnpm tsx ts/codegen/v3/generateFields.ts`
 */

// ─────────────────────────────────────────────────────────────────────────────
// the type universe
// ─────────────────────────────────────────────────────────────────────────────

/** Static value types: uint8..256, int8..256, bytes1..32, bool, address. */
const staticValueTypes: string[] = [
  ...range(1, 32).map((n) => `uint${n * 8}`),
  ...range(1, 32).map((n) => `int${n * 8}`),
  ...range(1, 32).map((n) => `bytes${n}`),
  "bool",
  "address",
];

// ─────────────────────────────────────────────────────────────────────────────
// per-family casting lives in `staticCast.ts` (shared with the inlined record codec)
// ─────────────────────────────────────────────────────────────────────────────

const byteLength = (abiType: string) => abiTypeInfo(abiType).staticByteLength!;
const handleName = (abiType: string) => abiTypeInfo(abiType).fieldHandle;

// ─────────────────────────────────────────────────────────────────────────────
// templates
// ─────────────────────────────────────────────────────────────────────────────

/** A fixed-size value field: load/save (store) + pure encode/decode (record codec). */
function staticField(abiType: string): string {
  const Field = handleName(abiType);
  const N = byteLength(abiType);
  return code`
    ${header()}
    import { Record, StoreAccess } from "../Record.sol";
    import { FieldLayout } from "../../FieldLayout.sol";
    import { Bytes } from "../../Bytes.sol";

    /// @notice A handle to one \`${abiType}\` field of a record.
    struct ${Field} {
      Record record;
      FieldLayout fieldLayout;
      uint8 index;
    }

    using ${Field}Lib for ${Field} global;

    /// @notice The \`${abiType}\` field codec, shared by every \`${abiType}\` field of every table.
    library ${Field}Lib {
      function load(${Field} memory self) internal view returns (${abiType}) {
        return ${cast(abiType, `bytes${N}(StoreAccess.getStaticField(self.record, self.index, self.fieldLayout))`)};
      }

      function save(${Field} memory self, ${abiType} value) internal {
        StoreAccess.setStaticField(self.record, self.index, encode(value), self.fieldLayout);
      }

      function encode(${abiType} value) internal pure returns (bytes memory) {
        return abi.encodePacked(value);
      }

      function decode(bytes memory staticData, uint256 offset) internal pure returns (${abiType}) {
        return ${cast(abiType, `Bytes.getBytes${N}(staticData, offset)`)};
      }
    }
  `;
}

/** A `T[]` field: whole-value + element ops (a mini-record) + pure codec. */
function arrayField(elementType: string): string {
  const abiType = `${elementType}[]`;
  const Field = handleName(abiType);
  const size = byteLength(elementType);
  return code`
    ${header()}
    import { Record, StoreAccess } from "../Record.sol";
    import { EncodedLengths } from "../../EncodedLengths.sol";
    import { SliceLib } from "../../Slice.sol";
    import { EncodeArray } from "../../tightcoder/EncodeArray.sol";
    import { DynamicRange } from "./_dynamic.sol";

    /// @notice A handle to one \`${abiType}\` field of a record.
    struct ${Field} {
      Record record;
      uint8 dynamicIndex;
    }

    using ${Field}Lib for ${Field} global;

    /// @notice The \`${abiType}\` field codec, shared by every \`${abiType}\` field of every table.
    library ${Field}Lib {
      uint256 constant _ELEMENT_SIZE = ${size};

      function load(${Field} memory self) internal view returns (${abiType} memory) {
        bytes memory blob = StoreAccess.getDynamicField(self.record, self.dynamicIndex);
        return SliceLib.getSubslice(blob, 0, blob.length).decodeArray_${elementType}();
      }

      function save(${Field} memory self, ${abiType} memory value) internal {
        StoreAccess.setDynamicField(self.record, self.dynamicIndex, EncodeArray.encode(value));
      }

      /// @notice Number of elements.
      function length(${Field} memory self) internal view returns (uint256) {
        return StoreAccess.getDynamicFieldLength(self.record, self.dynamicIndex) / _ELEMENT_SIZE;
      }

      /// @notice Load one element by index.
      function load(${Field} memory self, uint256 index) internal view returns (${elementType}) {
        bytes memory blob = StoreAccess.getDynamicFieldSlice(
          self.record,
          self.dynamicIndex,
          index * _ELEMENT_SIZE,
          (index + 1) * _ELEMENT_SIZE
        );
        return ${cast(elementType, `bytes${size}(blob)`)};
      }

      /// @notice Overwrite one element by index.
      function save(${Field} memory self, uint256 index, ${elementType} element) internal {
        StoreAccess.spliceDynamicData(
          self.record,
          self.dynamicIndex,
          uint40(index * _ELEMENT_SIZE),
          uint40(_ELEMENT_SIZE),
          abi.encodePacked(element)
        );
      }

      function push(${Field} memory self, ${elementType} element) internal {
        StoreAccess.pushToDynamicField(self.record, self.dynamicIndex, abi.encodePacked(element));
      }

      function pop(${Field} memory self) internal {
        StoreAccess.popFromDynamicField(self.record, self.dynamicIndex, _ELEMENT_SIZE);
      }

      function encode(${abiType} memory value) internal pure returns (bytes memory) {
        return EncodeArray.encode(value);
      }

      function byteLength(${abiType} memory value) internal pure returns (uint256) {
        return value.length * _ELEMENT_SIZE;
      }

      function decode(
        bytes memory dynamicData,
        EncodedLengths encodedLengths,
        uint8 dynamicIndex
      ) internal pure returns (${abiType} memory) {
        (uint256 start, uint256 end) = DynamicRange.range(encodedLengths, dynamicIndex);
        return SliceLib.getSubslice(dynamicData, start, end).decodeArray_${elementType}();
      }
    }
  `;
}

/** A `bytes`/`string` field (raw byte sequence). */
function bytesField(abiType: "bytes" | "string"): string {
  const Field = handleName(abiType);
  const wrap = (expr: string) => (abiType === "string" ? `string(${expr})` : expr);
  return code`
    ${header()}
    import { Record, StoreAccess } from "../Record.sol";
    import { EncodedLengths } from "../../EncodedLengths.sol";
    import { SliceLib } from "../../Slice.sol";
    import { DynamicRange } from "./_dynamic.sol";

    /// @notice A handle to one \`${abiType}\` field of a record.
    struct ${Field} {
      Record record;
      uint8 dynamicIndex;
    }

    using ${Field}Lib for ${Field} global;

    /// @notice The \`${abiType}\` field codec, shared by every \`${abiType}\` field of every table.
    library ${Field}Lib {
      function load(${Field} memory self) internal view returns (${abiType} memory) {
        return ${wrap("StoreAccess.getDynamicField(self.record, self.dynamicIndex)")};
      }

      function save(${Field} memory self, ${abiType} memory value) internal {
        StoreAccess.setDynamicField(self.record, self.dynamicIndex, bytes(value));
      }

      /// @notice Byte length.
      function length(${Field} memory self) internal view returns (uint256) {
        return StoreAccess.getDynamicFieldLength(self.record, self.dynamicIndex);
      }

      function encode(${abiType} memory value) internal pure returns (bytes memory) {
        return bytes(value);
      }

      function byteLength(${abiType} memory value) internal pure returns (uint256) {
        return bytes(value).length;
      }

      function decode(
        bytes memory dynamicData,
        EncodedLengths encodedLengths,
        uint8 dynamicIndex
      ) internal pure returns (${abiType} memory) {
        (uint256 start, uint256 end) = DynamicRange.range(encodedLengths, dynamicIndex);
        return ${wrap("SliceLib.getSubslice(dynamicData, start, end).toBytes()")};
      }
    }
  `;
}

function header(): string {
  return code`
    // SPDX-License-Identifier: MIT
    pragma solidity >=0.8.24;

    /* Autogenerated file. Do not edit manually. */
  `;
}

function range(from: number, to: number): number[] {
  return Array.from({ length: to - from + 1 }, (_, i) => from + i);
}

// ─────────────────────────────────────────────────────────────────────────────
// emit
// ─────────────────────────────────────────────────────────────────────────────

const outputDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../src/v3/fields");

const files: { name: string; source: string }[] = [
  ...staticValueTypes.map((abiType) => ({ name: handleName(abiType), source: staticField(abiType) })),
  ...staticValueTypes.map((elementType) => ({ name: handleName(`${elementType}[]`), source: arrayField(elementType) })),
  { name: "BytesField", source: bytesField("bytes") },
  { name: "StringField", source: bytesField("string") },
];

await fs.mkdir(outputDir, { recursive: true });
for (const { name, source } of files) {
  await fs.writeFile(path.join(outputDir, `${name}.sol`), await formatSolidity(source));
}
console.log(`generated ${files.length} field libraries into src/v3/fields/`);
