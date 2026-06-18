# v3 follow-ups (deferred during the store migration)

Things intentionally parked while focusing on migrating the store package to v3.

## Codegen features

- **Enum field types.** A config `enums` entry / an enum-typed field. Generate the
  `enum` + a field handle wrapping `Uint8Field` (cast uint8↔enum), like a user type
  over uint8. Blocker for configs that use enums (e.g. the store's own `KeyEncoding`
  test table). `convertExample` avoids enums for now.
- **`tableIdArgument` / `storeArgument` config options.** Already covered by the
  `.at(tableId)` / `.own(store)` modifiers — no special codegen needed (verified:
  `Hooks` generates and compiles on v3, consumed via `.at(hookTableId)`). Optional
  nicety: honor `tableIdArgument` by emitting an entry that _takes_ the id
  (`Hooks(tableId, key)`) instead of an unused canonical `_tableId` constant — cosmetic,
  not a blocker.
- **Offchain tables.** Omit read methods (reads silently return zeros) — compile error
  instead of footgun. Decide setter-only manifest shape.
- **Index/barrel file.** Deliberately omitted (deterministic deploys, #2838). Confirm no
  consumer needs it.

## Performance

- **Inline the record codec.** `getRecord` is +3,544 vs v2 (+19.8%) — more than one
  handle (~950) — because `_decode`/`_encode` delegate per field to the field libs where
  v2 inlines the casts into one function. Inlining the per-table codec (keep field libs
  for handle ops) should recover most of the read overhead. Highest-value optimization.
- **Group field libs into per-family files** (~12 files instead of 198). File-count only.
- The handle overhead itself (~950) is intrinsic; lean handle / layer flattening were
  measured negative — do not revisit without a new idea.

## Naming / structure

- **Separate codec library vs `_` prefix** for the low-level surface (`_encodeKey`/
  `_decode`/…). `_` chosen for now; `MixedCodec.*` is the clean-name alternative.

## Composite types

- **Multi-column key codecs** for user types (the DUST `Vec3` case: `uint96` ↔ 3 `int32`
  columns). Deferred; see DESIGN-V3 §6 and open question 8.

## Broader scope (separate efforts)

- **World package migration** — tables + the system/interface codegen (~79 call sites).
- **Kernel reduction** — shrink `IStoreWrite` to the 4 primitives, collapse `Schema` into
  `FieldLayout`, fold `tightcoder`/`Bytes`/`Slice`. See DESIGN-V3 §2 cleanup pass.
- **Hook removal** — DECIDED (DESIGN-V3 §2 item 6): remove store hooks entirely
  (`IStoreHook`, `Hook.sol`, the `StoreHooks` table, before/after machinery), replace
  with owner-woven composable effects (write-side analog of field traits; correctness
  via single-writer ownership) and an owner-opt-in reactive interface as the escape
  hatch. Drops the per-write `_loadStoreHooks` read from every write. Implementation is
  a follow-up; this migration left hooks intact (still byte-identical to v2).

## Decisions confirmed with data (RESOLVED)

- **StoreCore on handles vs low-level primitives.** Measured + resolved via clean
  same-compiler store gas diffs (StoreCore-on-v2 @baseline vs v3).
  - _Straight handle-API conversion_ cost **~800 gas per handle touched**, all in
    metadata access (data path unchanged): per-write hooks read +~800, warm
    `getKeySchema` +1854 / `getValueSchema` +977, table registration +~6150 (cold),
    `registerStoreHook` +2222.
  - _Resolution applied:_ StoreCore's **hot** metadata reads (per-write hooks read ×4,
    schema getters, `exists` checks) now use the low-level composition path
    (`getDynamicField`/`getStaticField` + the generated `_tableId`/`_fieldLayout`/
    `_encodeKey` constants), via the private `_loadStoreHooks`/`_resourceExists` helpers.
    **Cold** registration writes stay on the readable handle API (deploy-time only).
  - _Result:_ every record set/delete now **+22 gas (~0.02%, gas-neutral)**; schema
    getters **−15/−20 (cheaper than v2)**; residual overhead only on cold paths —
    registration +2877/table, `registerStoreHook` +735. The data path is untouched.
  - Optional further trim (low value): `registerStoreHook`'s `StoreHooks.push` and the
    `registerInternalTables`/`registerTable` `Tables.save` are still handle-based; convert
    to low-level only if deploy gas matters.
