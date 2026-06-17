import { AbiTypeInfo } from "./abiType";

/**
 * The complete, resolved description of one table that the renderer consumes.
 *
 * This is the entire contract between config-resolution and rendering: build
 * one of these and `renderTable` produces the Solidity. It is intentionally
 * flat and pre-computed — the renderer does no lookups, no branching on config
 * shape, no path math. All of that happens once when this object is built (see
 * `toTableCodegen`), so the templates stay readable.
 */
export type TableCodegen = {
  /** Table label, e.g. `Position`. Used for the entry function and library names. */
  readonly label: string;
  /** Generated record struct name, e.g. `PositionData`. */
  readonly dataStruct: string;

  /** Precomputed hex constants (the renderer never computes these). */
  readonly tableId: `0x${string}`;
  readonly fieldLayout: `0x${string}`;
  readonly keySchema: `0x${string}`;
  readonly valueSchema: `0x${string}`;

  readonly keyFields: readonly KeyField[];
  readonly fields: readonly Field[];

  /** Symbols to import beyond the always-imported store runtime. */
  readonly imports: readonly Import[];
  /** Import path to the store runtime root, already made relative to the output file. */
  readonly storeImportPath: string;
};

/** A value field — either static or dynamic; `kind` discriminates. */
export type Field = StaticField | DynamicField;

export type StaticField = FieldBase & {
  readonly kind: "static";
  /** Index in the full schema (static fields come first); used by the field handle. */
  readonly schemaIndex: number;
  /** Byte offset of this field within the packed static data; used by the record codec. */
  readonly byteOffset: number;
};

export type DynamicField = FieldBase & {
  readonly kind: "dynamic";
  /** Index among dynamic fields only (what StoreCore's dynamic ops address). */
  readonly dynamicIndex: number;
};

type FieldBase = {
  readonly name: string;
  readonly type: AbiTypeInfo;
  /** The type as the user named it (a user type like `EntityId`, else same as `type.solidityType`). */
  readonly typeName: string;
};

export type KeyField = {
  readonly name: string;
  readonly typeName: string;
  /** Expression that converts the key field to `bytes32`, given the field name. */
  readonly toBytes32: string;
};

export type Import = {
  readonly symbol: string;
  readonly path: string;
};
