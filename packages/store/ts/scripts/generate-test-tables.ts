import { fileURLToPath } from "node:url";
import path from "node:path";
import { defineStore } from "../config/v2/store";
import { tablegen } from "../codegen/v3/tablegen";

/**
 * Generates the store package's test-fixture tables on v3, into `test/codegen/tables`.
 *
 * Same config (and therefore same on-chain constants) as before; the generated Solidity is
 * now the v3 handle API. Run: `pnpm tsx ts/scripts/generate-test-tables.ts`.
 */
const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

const config = defineStore({
  sourceDirectory: "test",
  codegen: {
    storeImportPath: "./src",
  },
  enums: {
    ExampleEnum: ["None", "First", "Second", "Third"],
  },
  tables: {
    Callbacks: {
      schema: { key: "bytes32", value: "bytes24[]" },
      key: ["key"],
    },
    Mixed: {
      schema: {
        key: "bytes32",
        u32: "uint32",
        u128: "uint128",
        a32: "uint32[]",
        s: "string",
      },
      key: ["key"],
    },
    Vector2: {
      schema: {
        key: "bytes32",
        x: "uint32",
        y: "uint32",
      },
      key: ["key"],
    },
    KeyEncoding: {
      schema: {
        k1: "uint256",
        k2: "int32",
        k3: "bytes16",
        k4: "address",
        k5: "bool",
        k6: "ExampleEnum",
        value: "bool",
      },
      key: ["k1", "k2", "k3", "k4", "k5", "k6"],
    },
  },
});

const written = await tablegen({
  rootDir,
  outputDir: path.join(rootDir, "test/codegen/tables"),
  tables: Object.values(config.tables),
  userTypes: config.userTypes,
  enums: config.enums,
  storeImportPath: config.codegen.storeImportPath,
});

console.log(`generated ${written.length} files`);
