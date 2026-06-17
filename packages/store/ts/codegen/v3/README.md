# Store v3 table codegen (work in progress)

A rewrite of the Solidity table-library codegen targeting the v3 API
([DESIGN-V3.md](../../DESIGN-V3.md)). The goal of this rewrite is **TS that reads
like the Solidity it produces** — no callback cross-products, no per-type casts
smeared across files.

## How it's structured

The pipeline is data-in, string-out:

```
config → toTableCodegen → TableCodegen → renderTable → Solidity string → format → file
                          (types.ts)     (renderTable.ts)               (prettier)
```

- **`render.ts`** — the one rendering primitive: a `code` tagged template that
  flattens interpolated arrays (so `fields.map(renderField)` drops in like JSX
  children) and omits `undefined`/`false`/`""`. It does **not** indent —
  prettier formats the final output, so templates are written for reading.
- **`abiType.ts`** — the single source of truth for "what does `uint32` look
  like": its Solidity type, its shared field-handle type, byte lengths. Adding a
  type is a one-line edit here.
- **`types.ts`** — `TableCodegen`, the complete flat description of one table.
  The renderer does no lookups or config-shape branching; everything is
  precomputed when this object is built.
- **`renderTable.ts`** — reads top to bottom in the same order as the generated
  file (header → imports → struct → entry functions → methods library). Each
  section is a small pure function. **Start here.**
- **`demo.ts`** — builds a `TableCodegen` by hand for the spec's `Position`
  table and prints real output. Run: `pnpm tsx ts/codegen/v3/demo.ts`.
- **`example/Position.sol`** — the committed output of `demo.ts`, so the
  generated shape is reviewable without running anything.

## What this PR does and does not include

**Included:** the renderer and its input model, producing the full v3 table API
(record handle with `load`/`save`/`destroy`, field handles, `at()`/`own()`
dispatch modifiers, the entry function, the record codec).

**Not yet included (follow-up workstreams):**

1. **The runtime Solidity the output imports** — `v3/Record.sol`
   (`Record` struct + `RecordMethods`), the shared per-ABI-type field libs
   (`v3/fields/Int32Field.sol`, `Uint32ArrayField.sol`, …) with their
   `load`/`save`/`encode`/`decode`/`byteLength`/`decode` surface, and the
   `StoreAccess` dispatch that reads `record.store`. The example output does not
   compile until these land.
2. **`toTableCodegen`** — config-resolution adapter from the resolved
   `mud.config` table to `TableCodegen` (reusing the existing schema/FieldLayout
   hex encoders). `demo.ts` stands in for this with a hand-built value and
   placeholder hex constants.
3. **Wiring** — replacing the `tablegen()` entry point and regenerating
   store/world tables.

The runtime field libs are the per-ABI-type "written once" libraries described
in the design; the renderer references them by the naming convention in
`abiType.ts` (`<Type>Field` / `<Type>FieldLib`).
