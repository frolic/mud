import { formatSolidity } from "@latticexyz/common/codegen";
import { renderTable } from "./renderTable";
import { toTableCodegen } from "./toTableCodegen";

/**
 * Prints the generated output for the spec's `Position` table, end to end through
 * the real resolver. Run: `pnpm tsx ts/codegen/v3/demo.ts`.
 *
 * The committed `example/Position.sol` is this output.
 */
const position = toTableCodegen({
  label: "Position",
  key: [{ name: "player", type: "address" }],
  fields: [
    { name: "x", type: "int32" },
    { name: "y", type: "int32" },
    { name: "name", type: "string" },
    { name: "waypoints", type: "uint32[]" },
  ],
  storeImportPath: "@latticexyz/store/src",
});

console.log(await formatSolidity(renderTable(position)));
