import path from "node:path";
import fs from "node:fs/promises";
import { formatSolidity } from "@latticexyz/common/codegen";
import type { Table, UserTypes } from "../config/v2/output";
import { fromConfigTable } from "./fromConfig";
import { renderTable } from "./renderTable";
import { renderUserTypeField } from "./renderUserTypeField";
import { abiTypeInfo } from "./abiType";

/**
 * Generates v3 table libraries for a whole config into one output directory.
 *
 * Handles the real-config plumbing the fixtures skipped: resolving import paths
 * (package imports pass through; `.`-relative paths are made relative to the output
 * dir) and emitting one field-handle wrapper per referenced user type. No barrel
 * file — tables are imported directly (deterministic deploys).
 */
export async function tablegen(options: {
  readonly rootDir: string;
  readonly outputDir: string;
  readonly tables: readonly Table[];
  readonly userTypes: UserTypes;
  /** `codegen.storeImportPath`, e.g. `@latticexyz/store/src` or `./src`. */
  readonly storeImportPath: string;
}): Promise<string[]> {
  const { rootDir, outputDir } = options;
  const relImport = (target: string) => relativeImport(outputDir, target, rootDir);

  // Import paths, resolved relative to the output dir.
  const storeImportPath = relImport(options.storeImportPath);
  const userTypes: UserTypes = Object.fromEntries(
    Object.entries(options.userTypes).map(([name, userType]) => [
      name,
      { type: userType.type, filePath: relImport(userType.filePath) },
    ]),
  );

  await fs.mkdir(outputDir, { recursive: true });
  const written: string[] = [];

  // One wrapper per user type actually referenced by these tables.
  const referenced = new Set(
    options.tables.flatMap((table) =>
      Object.values(table.schema)
        .map((field) => field.internalType)
        .filter((internalType) => internalType in userTypes),
    ),
  );
  for (const name of referenced) {
    const userType = { name, primitive: userTypes[name].type, filePath: userTypes[name].filePath };
    await write(path.join(outputDir, `${name}Field.sol`), renderUserTypeField(userType, storeImportPath), written);
  }

  for (const table of options.tables) {
    await write(
      path.join(outputDir, `${table.label}.sol`),
      renderTable(fromConfigTable(table, userTypes, storeImportPath)),
      written,
    );
  }

  return written;
}

async function write(file: string, source: string, written: string[]): Promise<void> {
  await fs.writeFile(file, await formatSolidity(source));
  written.push(file);
}

/** A package import passes through; a `.`-relative path is made relative to `fromDir`. */
function relativeImport(fromDir: string, target: string, rootDir: string): string {
  if (!target.startsWith(".")) return target;
  const relative = path.relative(fromDir, path.resolve(rootDir, target)).split(path.sep).join("/");
  return relative.startsWith(".") ? relative : `./${relative}`;
}

// `abiTypeInfo` is re-exported so the world codegen (a future consumer) can share the lookup.
export { abiTypeInfo };
