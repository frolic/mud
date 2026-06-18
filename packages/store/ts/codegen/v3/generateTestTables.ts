import { fileURLToPath } from "node:url";
import path from "node:path";
import fs from "node:fs/promises";
import { formatSolidity } from "@latticexyz/common/codegen";
import { renderTable } from "./renderTable";
import { renderUserTypeField } from "./renderUserTypeField";
import { toTableCodegen, TableInput } from "./toTableCodegen";

/**
 * Generates the Solidity test fixtures exercised by `test/v3/*.t.sol`.
 * Run: `pnpm tsx ts/codegen/v3/generateTestTables.ts`
 */
const outputDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../test/v3/codegen");
const storeImportPath = "../../../src";

// User types referenced by the fixtures below (the store's own metadata UDVTs + a test one).
const storeUserTypes = {
  ResourceId: { primitive: "bytes32", filePath: "../../../src/ResourceId.sol" },
  FieldLayout: { primitive: "bytes32", filePath: "../../../src/FieldLayout.sol" },
  Schema: { primitive: "bytes32", filePath: "../../../src/Schema.sol" },
} as const;

const tables: TableInput[] = [
  // Every field shape: static int/uint/address/bool + dynamic string/array.
  {
    label: "Mixed",
    key: [{ name: "id", type: "bytes32" }],
    fields: [
      { name: "num", type: "int32" },
      { name: "big", type: "uint256" },
      { name: "owner", type: "address" },
      { name: "flag", type: "bool" },
      { name: "name", type: "string" },
      { name: "nums", type: "uint32[]" },
    ],
    storeImportPath,
  },
  // A user type as both key and value, to exercise wrap/unwrap codegen.
  {
    label: "Owned",
    key: [{ name: "entity", type: "MyId" }],
    fields: [
      { name: "owner", type: "MyId" },
      { name: "score", type: "uint256" },
    ],
    userTypes: { MyId: { primitive: "bytes32", filePath: "../MyId.sol" } },
    storeImportPath,
  },
  // Composite key spanning every static key-type family — exercises _encodeKey/_decodeKey round-trip.
  {
    label: "Keyed",
    key: [
      { name: "a", type: "uint256" },
      { name: "b", type: "int32" },
      { name: "c", type: "address" },
      { name: "d", type: "bool" },
      { name: "e", type: "bytes16" },
    ],
    fields: [{ name: "value", type: "uint256" }],
    storeImportPath,
  },
  // A faithful copy of the store's own `Tables` metadata table — the hot-path benchmark target.
  {
    label: "MetadataBench",
    key: [{ name: "tableId", type: "ResourceId" }],
    fields: [
      { name: "fieldLayout", type: "FieldLayout" },
      { name: "keySchema", type: "Schema" },
      { name: "valueSchema", type: "Schema" },
      { name: "abiEncodedKeyNames", type: "bytes" },
      { name: "abiEncodedFieldNames", type: "bytes" },
    ],
    userTypes: storeUserTypes,
    storeImportPath,
  },
];

await fs.mkdir(outputDir, { recursive: true });

// User-type field wrappers used by the tables above.
const userTypeDefs = [
  { name: "MyId", primitive: "bytes32", filePath: "../MyId.sol" },
  ...Object.entries(storeUserTypes).map(([name, def]) => ({ name, ...def })),
];
for (const userType of userTypeDefs) {
  await fs.writeFile(
    path.join(outputDir, `${userType.name}Field.sol`),
    await formatSolidity(renderUserTypeField(userType, storeImportPath)),
  );
}

for (const input of tables) {
  const source = await formatSolidity(renderTable(toTableCodegen(input)));
  await fs.writeFile(path.join(outputDir, `${input.label}.sol`), source);
  console.log(`generated ${input.label}.sol`);
}
