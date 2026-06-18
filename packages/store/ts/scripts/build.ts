import { loadConfig, resolveConfigPath } from "@latticexyz/config/node";
import { tablegen } from "../codegen/v3/tablegen";
import { Store as StoreConfig } from "../config/v2/output";
import path from "node:path";

const configPath = await resolveConfigPath(undefined);
const config = (await loadConfig(configPath)) as StoreConfig;
const rootDir = path.dirname(configPath);

// Generate the store's own core tables on v3 into src/codegen/v3 (consumed by StoreCore/Hook).
const written = await tablegen({
  rootDir,
  outputDir: path.join(rootDir, "src/codegen/v3"),
  tables: Object.values(config.tables),
  userTypes: config.userTypes,
  enums: config.enums,
  storeImportPath: config.codegen.storeImportPath,
});

console.log(`generated ${written.length} files`);
