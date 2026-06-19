import type { Table } from "../config/v2/output";
import { TableCodegen, UserType } from "./types";
import { toTableCodegen } from "./toTableCodegen";

/**
 * Adapts a resolved `mud.config` table to a {@link TableCodegen}.
 *
 * The resolved table already carries the authoritative `tableId` and a `schema` whose
 * `internalType` is the user-typed name (or the primitive). This maps those onto the
 * minimal `TableInput` the resolver consumes; everything else (offsets, dynamic
 * indices, fieldLayout/schema hex, key encoding) is computed by `toTableCodegen`.
 *
 * `userTypes` is the unified map (UDVTs + enums) built by `tablegen`, keyed by the name
 * the schema's `internalType` references.
 */
export function fromConfigTable(
  table: Table,
  userTypes: Record<string, UserType>,
  storeImportPath: string,
): TableCodegen {
  const named = (name: string) => ({ name, type: table.schema[name].internalType });

  const codegen = toTableCodegen({
    label: table.label,
    namespace: table.namespaceLabel,
    type: table.type === "offchainTable" ? "offchainTable" : "table",
    key: table.key.map(named),
    fields: Object.keys(table.schema)
      .filter((name) => !table.key.includes(name))
      .map(named),
    userTypes,
    storeImportPath,
  });

  // Prefer the config's authoritative tableId (it accounts for namespace/name truncation
  // precisely, rather than re-deriving it).
  return { ...codegen, tableId: table.tableId };
}
