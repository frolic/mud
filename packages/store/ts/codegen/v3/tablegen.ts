import path from "node:path";
import fs from "node:fs/promises";
import { formatSolidity } from "@latticexyz/common/codegen";
import type { Table, UserTypes } from "../config/v2/output";
import { UserType } from "./types";
import { fromConfigTable } from "./fromConfig";
import { renderTable } from "./renderTable";
import { renderUserTypeField } from "./renderUserTypeField";
import { renderEnum } from "./renderEnum";
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
  /** Config-declared enums, by name → ordered variants. Codegen authors the declaration. */
  readonly enums?: Readonly<Record<string, readonly string[]>>;
  /** `codegen.storeImportPath`, e.g. `@latticexyz/store/src` or `./src`. */
  readonly storeImportPath: string;
}): Promise<string[]> {
  const { rootDir, outputDir } = options;
  const relImport = (target: string) => relativeImport(outputDir, target, rootDir);

  // Import paths, resolved relative to the output dir.
  const storeImportPath = relImport(options.storeImportPath);

  // Unified user-type map (UDVTs + enums) in the v3 `UserType` shape. UDVT files are the user's
  // (relativized); enum files are generated into this dir, so they import as `./Name.sol`.
  const userTypes: Record<string, UserType> = {
    ...Object.fromEntries(
      Object.entries(options.userTypes).map(([name, userType]) => [
        name,
        { name, primitive: userType.type, filePath: relImport(userType.filePath) },
      ]),
    ),
    ...Object.fromEntries(
      Object.entries(options.enums ?? {}).map(([name, variants]) => [
        name,
        { name, primitive: "uint8", filePath: `./${name}.sol`, enumVariants: variants },
      ]),
    ),
  };

  await fs.mkdir(outputDir, { recursive: true });
  const written: string[] = [];

  // One handle per user type actually referenced by these tables — plus, for enums, the declaration.
  const referenced = new Set(
    options.tables.flatMap((table) =>
      Object.values(table.schema)
        .map((field) => field.internalType)
        .filter((internalType) => internalType in userTypes),
    ),
  );
  for (const name of referenced) {
    const userType = userTypes[name];
    if (userType.enumVariants) {
      await write(path.join(outputDir, `${name}.sol`), renderEnum(name, userType.enumVariants), written);
    }
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
