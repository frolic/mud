# Store v3 table codegen + runtime

A from-scratch rewrite of the Solidity table layer targeting the v3 API
([DESIGN-V3.md](../../DESIGN-V3.md)). Two goals:

1. **TS that reads like the Solidity it produces** — no callback cross-products,
   no per-type casts smeared across files.
2. **A thin per-table manifest over shared runtime libraries** — behavior lives
   once in the runtime, not regenerated per table.

It compiles and is tested end to end (`test/v3/Mixed.t.sol` round-trips against a
real store; `codegen.test.ts` covers the resolver and renderer).

## Layout

```
config → toTableCodegen → TableCodegen → renderTable → Solidity → format → file
         (resolver)        (types.ts)     (renderer)            (prettier)
```

TypeScript (`ts/codegen/v3/`):

- **`render.ts`** — the one primitive: a `code` tagged template that flattens
  array interpolations (so `fields.map(...)` drops in like JSX children) and
  omits falsy ones. No indentation logic; prettier owns layout.
- **`abiType.ts`** — the single "what does `uint32` look like" lookup.
- **`types.ts`** — `TableCodegen`, the flat fully-precomputed table description.
- **`toTableCodegen.ts`** — the resolver: computes hex constants, byte offsets,
  dynamic indices, key encodings. Self-contained (owns its on-chain encodings).
- **`renderTable.ts`** — reads top-to-bottom in output order. **Start here.**
- **`generateTestTables.ts`** — writes `test/v3/codegen/*.sol` for the Solidity tests.
- **`demo.ts`** / **`example/Position.sol`** — the spec's `Position` table, generated.
- **`codegen.test.ts`** — vitest unit tests (render tag, resolver hex, renderer shape).

Solidity runtime (`src/v3/`):

- **`Record.sol`** — the `Record` handle, `StoreAccess` (the single dispatch point:
  `store == 0` → `StoreSwitch`, else `IStore(store)`), and table-agnostic
  `RecordMethods` (`load`/`save`/`destroy`).
- **`fields/*.sol`** — one shared lib per ABI type (`Int32Field`, `StringField`,
  `Uint32ArrayField`, …): handle ops (`load`/`save`/element ops) + pure
  `encode`/`decode`/`byteLength` used by generated record codecs.

## Status

**Done and tested:** the renderer, resolver, runtime (`Record` + dispatch +
field libs for int/uint/address/bool/string/array), and both test suites.

**Remaining (the cut-over):**

1. **Field libs for the full ABI type set** — the six here cover every _shape_;
   the rest (all uint/int/bytes widths, their arrays, `bytes`) are mechanical and
   should be generated into `src/v3/fields/` rather than hand-written.
2. **`StoreCore` fast path** — `StoreAccess` currently routes pinned stores
   through `IStore` (correct, one extra hop); add the `store == address(this)` →
   `StoreCore` branch for the gas-optimal `own()` path.
3. **Config adapter** — map a resolved `mud.config` table (namespaces, user
   types, codegen options) onto `TableInput`; wire into `tablegen`.
4. **Delete the old codegen.** Gated on migrating `StoreCore`'s consumption of
   its own generated core tables (`Tables`, `ResourceIds`, `StoreHooks`) to the
   v3 API — a separate, safety-critical change. Until then the old codegen stays
   so the package builds.
