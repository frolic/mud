import { abiTypeInfo, AbiTypeInfo, isDynamic } from "./abiType";
import { Field, Hex, KeyField, TableCodegen, UserType } from "./types";

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
  /** User types referenced by `key`/`fields`, by name (the "import" case: a UDVT over a primitive). */
  readonly userTypes?: Readonly<Record<string, { primitive: string; filePath: string }>>;
  /** Import path to the store runtime root, relative to the generated file. */
  readonly storeImportPath: string;
};

type NamedType = { readonly name: string; readonly type: string };

export function toTableCodegen(input: TableInput): TableCodegen {
  const namespace = input.namespace ?? "";
  const userTypes = input.userTypes ?? {};

  // Resolve a declared type to its primitive ABI type (a user type → what it wraps).
  const primitive = (type: string): string => userTypes[type]?.primitive ?? type;
  const userTypeOf = (type: string): UserType | undefined =>
    userTypes[type] && { name: type, primitive: userTypes[type].primitive, filePath: userTypes[type].filePath };

  // Store requires static fields before dynamic; this order drives the struct,
  // schema, field layout, and codec alike, so we sort once here.
  const sorted = [...input.fields].sort(
    (a, b) => Number(isDynamic(abiTypeInfo(primitive(a.type)))) - Number(isDynamic(abiTypeInfo(primitive(b.type)))),
  );

  let byteOffset = 0;
  let dynamicIndex = 0;
  const fields: Field[] = sorted.map((field, schemaIndex): Field => {
    const userType = userTypeOf(field.type);
    const type = fieldType(field.type, userType);
    const base = { name: field.name, type, typeName: field.type, userType };
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
    toBytes32: keyToBytes32(key.name, key.type, userTypeOf(key.type)),
    userType: userTypeOf(key.type),
  }));

  return {
    label: input.label,
    dataStruct: `${input.label}Data`,
    tableId: resourceToHex(input.type === "offchainTable" ? "ot" : "tb", namespace, input.label),
    fieldLayout: encodeFieldLayout(sorted.map((field) => primitive(field.type))),
    keySchema: encodeSchema(input.key.map((key) => primitive(key.type))),
    valueSchema: encodeSchema(sorted.map((field) => primitive(field.type))),
    keyFields,
    fields,
    imports: [],
    storeImportPath: input.storeImportPath,
  };
}

/** A user-typed field keeps the primitive's byte length but presents the UDVT's handle/type. */
function fieldType(declaredType: string, userType: UserType | undefined): AbiTypeInfo {
  if (!userType) return abiTypeInfo(declaredType);
  const primitive = abiTypeInfo(userType.primitive);
  return { ...primitive, solidityType: userType.name, fieldHandle: `${userType.name}Field` };
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

/** The expression that converts a key field to `bytes32` (unwrapping a user type first). */
function keyToBytes32(name: string, declaredType: string, userType: UserType | undefined): string {
  const value = userType ? `${userType.name}.unwrap(${name})` : name;
  const primitive = userType?.primitive ?? declaredType;
  if (primitive === "bytes32") return value;
  if (/^bytes\d{1,2}$/.test(primitive)) return `bytes32(${value})`;
  if (/^uint\d{1,3}$/.test(primitive)) return `bytes32(uint256(${value}))`;
  if (/^int\d{1,3}$/.test(primitive)) return `bytes32(uint256(int256(${value})))`;
  if (primitive === "address") return `bytes32(uint256(uint160(${value})))`;
  if (primitive === "bool") return `bytes32(uint256(${value} ? 1 : 0))`;
  throw new Error(`Cannot encode key of type ${declaredType}`);
}

const ascii = (text: string, bytes: number): string =>
  [...text]
    .map((char) => char.charCodeAt(0).toString(16).padStart(2, "0"))
    .join("")
    .padEnd(bytes * 2, "0");

const byte = (value: number, bytes = 1): string => value.toString(16).padStart(bytes * 2, "0");
const pad = (hex: string): Hex => `0x${hex.padEnd(64, "0")}`;
