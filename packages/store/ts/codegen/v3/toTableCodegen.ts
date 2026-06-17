import { abiTypeInfo, isDynamic } from "./abiType";
import { Field, Hex, KeyField, TableCodegen } from "./types";

/**
 * The resolver: a plain table description in, a fully-precomputed {@link TableCodegen}
 * out. This is where every derived value is computed exactly once — hex constants,
 * static byte offsets, dynamic indices, key encodings — so the renderer can stay a
 * dumb, readable string template.
 *
 * Self-contained by design: it owns its on-chain encodings (no dependency on other
 * MUD packages), which keeps it trivially testable and the boundary crisp.
 *
 * The input is intentionally minimal and decoupled from the full mud.config shape;
 * a thin wrapper maps a resolved config table onto this (built-in ABI types only for
 * now — user types are a follow-up).
 */
export type TableInput = {
  readonly label: string;
  readonly namespace?: string;
  readonly type?: "table" | "offchainTable";
  /** Key fields; their types must be static. */
  readonly key: readonly NamedType[];
  /** Value fields, in any order — sorted static-first here (a Store invariant). */
  readonly fields: readonly NamedType[];
  /** Import path to the store runtime root, relative to the generated file. */
  readonly storeImportPath: string;
};

type NamedType = { readonly name: string; readonly type: string };

export function toTableCodegen(input: TableInput): TableCodegen {
  const namespace = input.namespace ?? "";

  // Store requires static fields before dynamic; this order drives the struct,
  // schema, field layout, and codec alike, so we sort once here.
  const sorted = [...input.fields].sort(byStaticFirst);

  let byteOffset = 0;
  let dynamicIndex = 0;
  const fields: Field[] = sorted.map((field, schemaIndex): Field => {
    const type = abiTypeInfo(field.type);
    const base = { name: field.name, type, typeName: field.type };
    if (isDynamic(type)) {
      return { ...base, kind: "dynamic", dynamicIndex: dynamicIndex++ };
    }
    const offset = byteOffset;
    byteOffset += type.staticByteLength!;
    return { ...base, kind: "static", schemaIndex, byteOffset: offset };
  });

  const keyFields: KeyField[] = input.key.map((key) => ({
    name: key.name,
    typeName: key.type,
    toBytes32: keyToBytes32(key.name, key.type),
  }));

  return {
    label: input.label,
    dataStruct: `${input.label}Data`,
    tableId: resourceToHex(input.type === "offchainTable" ? "ot" : "tb", namespace, input.label),
    fieldLayout: encodeFieldLayout(sorted.map((field) => field.type)),
    keySchema: encodeSchema(input.key.map((key) => key.type)),
    valueSchema: encodeSchema(sorted.map((field) => field.type)),
    keyFields,
    fields,
    imports: [],
    storeImportPath: input.storeImportPath,
  };
}

function byStaticFirst(a: NamedType, b: NamedType): number {
  return Number(isDynamic(abiTypeInfo(a.type))) - Number(isDynamic(abiTypeInfo(b.type)));
}

// ─────────────────────────────────────────────────────────────────────────────
// on-chain encodings — owned by the codegen, mirroring the Solidity layouts
// ─────────────────────────────────────────────────────────────────────────────

/** ResourceId: [2-byte type tag][14-byte namespace][16-byte name], all ASCII, right-padded. */
function resourceToHex(typeTag: string, namespace: string, name: string): Hex {
  return `0x${ascii(typeTag, 2)}${ascii(namespace, 14)}${ascii(name, 16)}`;
}

/** FieldLayout: [2-byte total static length][1-byte #static][1-byte #dynamic][1 byte per static length]. */
function encodeFieldLayout(abiTypes: readonly string[]): Hex {
  const staticLengths = abiTypes
    .map(abiTypeInfo)
    .filter((info) => !isDynamic(info))
    .map((info) => info.staticByteLength!);
  const numDynamic = abiTypes.length - staticLengths.length;
  return pad(header(staticLengths, numDynamic) + staticLengths.map((length) => byte(length)).join(""));
}

/** Schema: same header as FieldLayout, then one SchemaType enum byte per field (static first). */
function encodeSchema(abiTypes: readonly string[]): Hex {
  const sorted = [...abiTypes].sort((a, b) => Number(isDynamic(abiTypeInfo(a))) - Number(isDynamic(abiTypeInfo(b))));
  const staticLengths = sorted
    .map(abiTypeInfo)
    .filter((info) => !isDynamic(info))
    .map((info) => info.staticByteLength!);
  return pad(
    header(staticLengths, sorted.length - staticLengths.length) +
      sorted.map((type) => byte(schemaTypeId(type))).join(""),
  );
}

/** The shared 4-byte header of FieldLayout and Schema. */
function header(staticLengths: readonly number[], numDynamic: number): string {
  const totalStatic = staticLengths.reduce((sum, length) => sum + length, 0);
  return byte(totalStatic, 2) + byte(staticLengths.length) + byte(numDynamic);
}

/**
 * The SchemaType enum value of an ABI type, computed arithmetically from
 * `SchemaType.sol`'s ordering (uints, ints, bytesN, bool, address, then the same
 * as arrays, then bytes, string). No table needed.
 */
function schemaTypeId(abiType: string): number {
  if (abiType === "bool") return 96;
  if (abiType === "address") return 97;
  if (abiType === "bytes") return 196;
  if (abiType === "string") return 197;

  const array = abiType.endsWith("[]");
  const element = array ? abiType.slice(0, -2) : abiType;
  const arrayOffset = array ? 98 : 0;

  if (element === "bool") return arrayOffset + 96;
  if (element === "address") return arrayOffset + 97;

  const uintBits = element.match(/^uint(\d+)$/)?.[1];
  if (uintBits) return arrayOffset + Number(uintBits) / 8 - 1;
  const intBits = element.match(/^int(\d+)$/)?.[1];
  if (intBits) return arrayOffset + 32 + Number(intBits) / 8 - 1;
  const bytesN = element.match(/^bytes(\d+)$/)?.[1];
  if (bytesN) return arrayOffset + 64 + Number(bytesN) - 1;

  throw new Error(`Unknown schema ABI type: ${abiType}`);
}

/** The expression that converts a key field of `abiType` to `bytes32`. */
function keyToBytes32(name: string, abiType: string): string {
  if (abiType === "bytes32") return name;
  if (/^bytes\d{1,2}$/.test(abiType)) return `bytes32(${name})`;
  if (/^uint\d{1,3}$/.test(abiType)) return `bytes32(uint256(${name}))`;
  if (/^int\d{1,3}$/.test(abiType)) return `bytes32(uint256(int256(${name})))`;
  if (abiType === "address") return `bytes32(uint256(uint160(${name})))`;
  if (abiType === "bool") return `bytes32(uint256(${name} ? 1 : 0))`;
  throw new Error(`Cannot encode key of type ${abiType}`);
}

const ascii = (text: string, bytes: number): string =>
  [...text]
    .map((char) => char.charCodeAt(0).toString(16).padStart(2, "0"))
    .join("")
    .padEnd(bytes * 2, "0");

const byte = (value: number, bytes = 1): string => value.toString(16).padStart(bytes * 2, "0");
const pad = (hex: string): Hex => `0x${hex.padEnd(64, "0")}`;
