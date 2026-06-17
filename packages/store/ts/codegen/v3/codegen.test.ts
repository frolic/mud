import { describe, it, expect } from "vitest";
import { code } from "./render";
import { abiTypeInfo, isDynamic } from "./abiType";
import { toTableCodegen } from "./toTableCodegen";
import { renderTable } from "./renderTable";
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

  it("encodes each key field to bytes32", () => {
    expect(mixed.keyFields).toEqual([{ name: "id", typeName: "bytes32", toBytes32: "id" }]);
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
