import { describe, it, expect } from "vitest";
import type { Table } from "../../config/v2/output";
import { fromConfigTable } from "./fromConfig";
import { renderTable } from "./renderTable";

// A resolved `mud.config` table, hand-built to match what `defineStore` produces for the
// v2 `Mixed` test table. Its v2-generated constants (from test/codegen/tables/Mixed.sol)
// are the compatibility oracle. (Built by hand rather than via `defineStore` because the
// config resolver's transitive deps don't load under vitest; the real-config path is
// exercised by the generation script.)
const mixed = {
  label: "Mixed",
  namespaceLabel: "",
  namespace: "",
  name: "Mixed",
  type: "table",
  tableId: "0x746200000000000000000000000000004d697865640000000000000000000000",
  key: ["key"],
  schema: {
    key: { type: "bytes32", internalType: "bytes32" },
    u32: { type: "uint32", internalType: "uint32" },
    u128: { type: "uint128", internalType: "uint128" },
    a32: { type: "uint32[]", internalType: "uint32[]" },
    s: { type: "string", internalType: "string" },
  },
} as const satisfies Table;

describe("fromConfigTable", () => {
  const codegen = fromConfigTable(mixed, {}, "@latticexyz/store/src");

  it("reproduces v2's on-chain constants for the same table", () => {
    expect(codegen.tableId).toBe(mixed.tableId);
    expect(codegen.fieldLayout).toBe("0x0014020204100000000000000000000000000000000000000000000000000000");
    expect(codegen.keySchema).toBe("0x002001005f000000000000000000000000000000000000000000000000000000");
    expect(codegen.valueSchema).toBe("0x00140202030f65c5000000000000000000000000000000000000000000000000");
  });

  it("maps schema + key into fields and renders", () => {
    expect(codegen.fields.map((field) => field.name)).toEqual(["u32", "u128", "a32", "s"]);
    expect(codegen.keyFields.map((key) => key.name)).toEqual(["key"]);
    expect(renderTable(codegen)).toContain("function Mixed(bytes32 key) pure returns (MixedRecord memory)");
  });
});
