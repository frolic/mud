import { fileURLToPath } from "node:url";
import path from "node:path";
import { defineStore } from "../../config/v2/store";
import { tablegen } from "./tablegen";

/**
 * Generates the store's own core tables on v3 (the first half of the store migration).
 * `Hooks` is skipped — it uses `tableIdArgument`, a noted follow-up.
 *
 * Run: `pnpm tsx ts/codegen/v3/convertStore.ts`
 */
const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

const config = defineStore({
  namespace: "store",
  codegen: { storeImportPath: "./src" },
  userTypes: {
    ResourceId: { filePath: "./src/ResourceId.sol", type: "bytes32" },
    FieldLayout: { filePath: "./src/FieldLayout.sol", type: "bytes32" },
    Schema: { filePath: "./src/Schema.sol", type: "bytes32" },
  },
  tables: {
    StoreHooks: { schema: { tableId: "ResourceId", hooks: "bytes21[]" }, key: ["tableId"] },
    Tables: {
      schema: {
        tableId: "ResourceId",
        fieldLayout: "FieldLayout",
        keySchema: "Schema",
        valueSchema: "Schema",
        abiEncodedKeyNames: "bytes",
        abiEncodedFieldNames: "bytes",
      },
      key: ["tableId"],
    },
    ResourceIds: { schema: { resourceId: "ResourceId", exists: "bool" }, key: ["resourceId"] },
  },
});

const written = await tablegen({
  rootDir,
  outputDir: path.join(rootDir, "test/v3/store-codegen"),
  tables: Object.values(config.tables),
  userTypes: config.userTypes,
  storeImportPath: config.codegen.storeImportPath,
});
console.log(`generated ${written.length} files`);
