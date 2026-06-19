/**
 * Everything codegen needs to know about a single ABI type, in one place.
 *
 * This is the one spot where "what does `uint32` look like in Solidity" lives.
 * In v2 this knowledge was smeared across renderField/renderValueTypeToBytes32/
 * the tightcoder templates; here it's a single lookup that every section reads
 * from, so adding or changing a type is a one-line edit.
 */

export type AbiTypeInfo = {
  /** How the type is written in Solidity, e.g. `uint32`, `uint32[]`, `string`. */
  readonly solidityType: string;
  /** The shared field-handle type for this ABI type, e.g. `Uint32Field`, `Uint32ArrayField`. */
  readonly fieldHandle: string;
  /** Static byte length (e.g. 4 for uint32); `undefined` for dynamic types. */
  readonly staticByteLength: number | undefined;
  /** For arrays/bytes/strings: bytes per element (4 for uint32[], 1 for bytes/string). */
  readonly elementByteLength: number | undefined;
};

export function isDynamic(info: AbiTypeInfo): boolean {
  return info.staticByteLength === undefined;
}

/** Parse an ABI type string (`uint32`, `int8[]`, `string`) into everything codegen needs. */
export function abiTypeInfo(abiType: string): AbiTypeInfo {
  if (abiType === "string" || abiType === "bytes") {
    return {
      solidityType: abiType,
      fieldHandle: pascalCase(abiType) + "Field",
      staticByteLength: undefined,
      elementByteLength: 1,
    };
  }

  if (abiType.endsWith("[]")) {
    const element = abiType.slice(0, -2);
    return {
      solidityType: abiType,
      fieldHandle: pascalCase(element) + "ArrayField",
      staticByteLength: undefined,
      elementByteLength: staticByteLength(element),
    };
  }

  return {
    solidityType: abiType,
    fieldHandle: pascalCase(abiType) + "Field",
    staticByteLength: staticByteLength(abiType),
    elementByteLength: undefined,
  };
}

/** `uint32` -> `Uint32`, `bytes32` -> `Bytes32`, `address` -> `Address`, `bool` -> `Bool`. */
function pascalCase(abiType: string): string {
  return abiType.charAt(0).toUpperCase() + abiType.slice(1);
}

/** Byte length of a static ABI type. Mirrors SchemaType's static lengths. */
function staticByteLength(abiType: string): number {
  if (abiType === "address") return 20;
  if (abiType === "bool") return 1;

  const bits = abiType.match(/^(?:u?int)(\d+)$/)?.[1];
  if (bits) return Number(bits) / 8;

  const bytes = abiType.match(/^bytes(\d+)$/)?.[1];
  if (bytes) return Number(bytes);

  throw new Error(`Not a static ABI type: ${abiType}`);
}
