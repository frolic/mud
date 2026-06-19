import { fileURLToPath } from "node:url";
import path from "node:path";
import { defineStore } from "../../config/v2/store";
import { tablegen } from "./tablegen";

/**
 * End-to-end conversion of a real `defineStore` config to v3 libraries, proving the
 * full pipeline (resolver → relativized imports → user-type wrappers) on a multi-table
 * config with a relative-path user type. Output compiles (see `forge build test/v3/example-codegen`).
 *
 * Run: `pnpm tsx ts/codegen/v3/convertExample.ts`
 */
const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

const config = defineStore({
  // `./src` (not the default package import) because we generate inside the store package itself.
  codegen: { storeImportPath: "./src" },
  userTypes: {
    MyId: { type: "bytes32", filePath: "./test/v3/MyId.sol" },
  },
  tables: {
    Position: {
      schema: { player: "address", x: "int32", y: "int32" },
      key: ["player"],
    },
    Inventory: {
      schema: { owner: "MyId", items: "uint32[]", label: "string" },
      key: ["owner"],
    },
  },
});

const written = await tablegen({
  rootDir,
  outputDir: path.join(rootDir, "test/v3/example-codegen"),
  tables: Object.values(config.tables),
  userTypes: config.userTypes,
  storeImportPath: config.codegen.storeImportPath,
});

console.log(`generated ${written.length} files:\n${written.map((f) => "  " + path.relative(rootDir, f)).join("\n")}`);
