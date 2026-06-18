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
- **Hook decision** — remove store hooks vs keep dynamic. See DESIGN-V3 §2.

## Decisions to confirm with data (this migration produces it)

- **StoreCore on handles vs low-level primitives.** The gas finding says handles add
  ~950/op to StoreCore's hot path. The migration uses the **low-level composition
  primitives** (`_encodeKey`/`_decode`/direct `StoreCore`) for StoreCore's internal
  metadata access to stay ~v2 gas, reserving handles for app code. Confirm via the store
  gas-report diff.
