import { formatSolidity } from "@latticexyz/common/codegen";
import { renderTable } from "./renderTable";
import { TableCodegen } from "./types";
import { abiTypeInfo } from "./abiType";

/**
 * Hand-built example of the renderer's input, matching the spec's `Position`
 * table:
 *
 *   Position: {
 *     schema: { player: "address", x: "int32", y: "int32", name: "string", waypoints: "uint32[]" },
 *     key: ["player"],
 *   }
 *
 * This stands in for config resolution (`toTableCodegen`, not yet written) so we
 * can see real generated output. The hex constants are placeholders — config
 * resolution computes the real FieldLayout/Schema/tableId.
 *
 * Run: `pnpm tsx ts/codegen/v3/demo.ts`
 */
const position: TableCodegen = {
  label: "Position",
  dataStruct: "PositionData",
  tableId: "0x74620000000000000000000000000000506f736974696f6e0000000000000000",
  fieldLayout: "0x0008020004040000000000000000000000000000000000000000000000000000",
  keySchema: "0x0014010061000000000000000000000000000000000000000000000000000000",
  valueSchema: "0x00080202232fc5c500000000000000000000000000000000000000000000000000",
  storeImportPath: "@latticexyz/store/src",
  imports: [],
  keyFields: [{ name: "player", typeName: "address", toBytes32: "bytes32(uint256(uint160(player)))" }],
  fields: [
    { kind: "static", name: "x", typeName: "int32", type: abiTypeInfo("int32"), schemaIndex: 0, byteOffset: 0 },
    { kind: "static", name: "y", typeName: "int32", type: abiTypeInfo("int32"), schemaIndex: 1, byteOffset: 4 },
    { kind: "dynamic", name: "name", typeName: "string", type: abiTypeInfo("string"), dynamicIndex: 0 },
    { kind: "dynamic", name: "waypoints", typeName: "uint32[]", type: abiTypeInfo("uint32[]"), dynamicIndex: 1 },
  ],
};

console.log(await formatSolidity(renderTable(position)));
