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
];

await fs.mkdir(outputDir, { recursive: true });

// User-type field wrappers used by the tables above.
await fs.writeFile(
  path.join(outputDir, "MyIdField.sol"),
  await formatSolidity(
    renderUserTypeField({ name: "MyId", primitive: "bytes32", filePath: "../MyId.sol" }, storeImportPath),
  ),
);

for (const input of tables) {
  const source = await formatSolidity(renderTable(toTableCodegen(input)));
  await fs.writeFile(path.join(outputDir, `${input.label}.sol`), source);
  console.log(`generated ${input.label}.sol`);
}
