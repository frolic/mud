import { describe, it, expect } from "vitest";
import { code } from "./render";
import { abiTypeInfo, isDynamic } from "./abiType";
import { toTableCodegen } from "./toTableCodegen";
import { renderTable } from "./renderTable";
import { renderUserTypeField } from "./renderUserTypeField";
import { renderEnum } from "./renderEnum";
import { StaticField, DynamicField } from "./types";

describe("code", () => {
  it("flattens array interpolations and omits falsy ones", () => {
    expect(code`a${[1, 2]}b${undefined}${false}${""}c`).toBe("a1\n2bc");
  });
});

describe("abiTypeInfo", () => {
  it("describes a static value type", () => {
    expect(abiTypeInfo("int32")).toEqual({
      solidityType: "int32",
      fieldHandle: "Int32Field",
      staticByteLength: 4,
      elementByteLength: undefined,
    });
    expect(abiTypeInfo("address").staticByteLength).toBe(20);
  });

  it("describes an array", () => {
    const info = abiTypeInfo("uint32[]");
    expect(info.fieldHandle).toBe("Uint32ArrayField");
    expect(isDynamic(info)).toBe(true);
    expect(info.elementByteLength).toBe(4);
  });

  it("describes string/bytes", () => {
    expect(abiTypeInfo("string").fieldHandle).toBe("StringField");
    expect(abiTypeInfo("string").elementByteLength).toBe(1);
    expect(isDynamic(abiTypeInfo("bytes"))).toBe(true);
  });
});

// Fields declared dynamic-first on purpose, to prove the resolver sorts static-first.
const mixed = toTableCodegen({
  label: "Mixed",
  key: [{ name: "id", type: "bytes32" }],
  fields: [
    { name: "name", type: "string" },
    { name: "num", type: "int32" },
    { name: "big", type: "uint256" },
    { name: "owner", type: "address" },
    { name: "flag", type: "bool" },
    { name: "nums", type: "uint32[]" },
  ],
  storeImportPath: "../../../src",
});

describe("toTableCodegen", () => {
  it("orders static fields first with cumulative byte offsets", () => {
    const statics = mixed.fields.filter((field): field is StaticField => field.kind === "static");
    expect(statics.map((field) => field.name)).toEqual(["num", "big", "owner", "flag"]);
    expect(statics.map((field) => field.byteOffset)).toEqual([0, 4, 36, 56]);
  });

  it("orders dynamic fields after, with their own index", () => {
    const dynamic = mixed.fields.filter((field): field is DynamicField => field.kind === "dynamic");
    expect(dynamic.map((field) => field.name)).toEqual(["name", "nums"]);
    expect(dynamic.map((field) => field.dynamicIndex)).toEqual([0, 1]);
  });

  it("computes the on-chain hex constants (verified registrable in Mixed.t.sol)", () => {
    expect(mixed.tableId).toBe("0x746200000000000000000000000000004d697865640000000000000000000000");
    expect(mixed.fieldLayout).toBe("0x0039040204201401000000000000000000000000000000000000000000000000");
    expect(mixed.keySchema).toBe("0x002001005f000000000000000000000000000000000000000000000000000000");
    expect(mixed.valueSchema).toBe("0x00390402231f6160c56500000000000000000000000000000000000000000000");
  });

  it("encodes and decodes each key field", () => {
    expect(mixed.keyFields).toHaveLength(1);
    expect(mixed.keyFields[0]).toMatchObject({
      name: "id",
      typeName: "bytes32",
      toBytes32: "id",
      fromKeyTuple: "keyTuple[0]",
    });
  });
});

describe("renderTable", () => {
  const output = renderTable(mixed);

  it("emits the entry function and record handle", () => {
    expect(output).toContain("function Mixed(bytes32 id) pure returns (MixedRecord memory)");
    expect(output).toContain("struct MixedRecord {");
    expect(output).toContain("using MixedRecordMethods for MixedRecord global;");
  });

  it("emits record methods and dispatch modifiers", () => {
    for (const signature of [
      "function load(",
      "function save(",
      "function destroy(",
      "function at(",
      "function own(",
    ]) {
      expect(output).toContain(signature);
    }
  });

  it("emits one accessor per field, returning its typed handle", () => {
    expect(output).toContain("function num(MixedRecord memory self) internal pure returns (Int32Field memory)");
    expect(output).toContain("function nums(MixedRecord memory self) internal pure returns (Uint32ArrayField memory)");
  });
});

describe("user types", () => {
  const owned = toTableCodegen({
    label: "Owned",
    key: [{ name: "entity", type: "MyId" }],
    fields: [
      { name: "owner", type: "MyId" },
      { name: "score", type: "uint256" },
    ],
    userTypes: { MyId: { primitive: "bytes32", filePath: "../MyId.sol" } },
    storeImportPath: "../../../src",
  });

  it("resolves a user-typed field to its wrapper handle over the primitive", () => {
    const owner = owned.fields.find((field) => field.name === "owner") as StaticField;
    expect(owner.typeName).toBe("MyId");
    expect(owner.type.fieldHandle).toBe("MyIdField");
    expect(owner.type.staticByteLength).toBe(32); // the primitive's length
    expect(owner.userType).toEqual({ name: "MyId", primitive: "bytes32", filePath: "../MyId.sol" });
  });

  it("encodes schema and key from the underlying primitive", () => {
    expect(owned.keyFields[0].toBytes32).toBe("MyId.unwrap(entity)");
    expect(owned.keySchema).toBe("0x002001005f000000000000000000000000000000000000000000000000000000");
    expect(owned.valueSchema).toBe("0x004002005f1f0000000000000000000000000000000000000000000000000000");
  });

  it("renders the wrapped accessor, entry param, and UDVT import", () => {
    const output = renderTable(owned);
    expect(output).toContain('import { MyId } from "../MyId.sol"');
    expect(output).toContain("function Owned(MyId entity) pure returns (OwnedRecord memory)");
    expect(output).toContain("function owner(OwnedRecord memory self) internal pure returns (MyIdField memory)");
    expect(output).toContain("return MyIdField(Bytes32Field(self.record, _fieldLayout, 0));");
  });

  it("renders the user-type field wrapper that wraps/unwraps the UDVT", () => {
    const wrapper = renderUserTypeField(
      { name: "MyId", primitive: "bytes32", filePath: "../MyId.sol" },
      "../../../src",
    );
    expect(wrapper).toContain("struct MyIdField {");
    expect(wrapper).toContain("return MyId.wrap(self.inner.load());");
    expect(wrapper).toContain("self.inner.save(MyId.unwrap(value));");
  });
});

describe("enums", () => {
  // An enum is a user type over uint8: cast conversions (not wrap/unwrap), codegen-authored declaration.
  const enumType = {
    name: "Direction",
    primitive: "uint8",
    filePath: "./Direction.sol",
    enumVariants: ["None", "North", "East"],
  } as const;

  const keyed = toTableCodegen({
    label: "Stance",
    key: [{ name: "facing", type: "Direction" }],
    fields: [{ name: "facing", type: "Direction" }],
    userTypes: { Direction: enumType },
    storeImportPath: "../../../src",
  });

  it("treats the enum as a uint8-backed field handle", () => {
    const value = keyed.fields[0] as StaticField;
    expect(value.typeName).toBe("Direction");
    expect(value.type.fieldHandle).toBe("DirectionField");
    expect(value.type.staticByteLength).toBe(1); // the uint8 it presents over
    // Schema/layout match a plain uint8 field (the enum is uint8 on-chain).
    const asUint8 = toTableCodegen(bare("uint8"));
    expect(keyed.valueSchema).toBe(asUint8.valueSchema);
    expect(keyed.fieldLayout).toBe(asUint8.fieldLayout);
  });

  it("encodes/decodes an enum key via a uint8 cast (not wrap/unwrap)", () => {
    expect(keyed.keyFields[0].toBytes32).toBe("bytes32(uint256(uint8(facing)))");
    expect(keyed.keyFields[0].fromKeyTuple).toBe("Direction(uint8(uint256(keyTuple[0])))");
  });

  it("renders the field wrapper with enum casts over Uint8Field", () => {
    const wrapper = renderUserTypeField(enumType, "../../../src");
    expect(wrapper).toContain("import { Uint8Field, Uint8FieldLib }");
    expect(wrapper).toContain('import { Direction } from "./Direction.sol";');
    expect(wrapper).toContain("return Direction(self.inner.load());");
    expect(wrapper).toContain("self.inner.save(uint8(value));");
    expect(wrapper).toContain("return Direction(Uint8FieldLib.decode(staticData, offset));");
  });

  it("authors the enum declaration from the config variants", () => {
    const declaration = renderEnum("Direction", ["None", "North", "East"]);
    expect(declaration).toContain("enum Direction {");
    expect(declaration).toContain("None,");
    expect(declaration).toContain("East");
    expect(declaration).not.toContain("East,"); // no trailing comma on the last variant
  });
});

// A one-field table whose only value is `type`, for schema comparisons.
function bare(type: string) {
  return {
    label: "Bare",
    key: [{ name: "id", type: "bytes32" }],
    fields: [{ name: "v", type }],
    storeImportPath: "../../../src",
  };
}
