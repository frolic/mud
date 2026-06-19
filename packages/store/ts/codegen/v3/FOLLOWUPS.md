# v3 follow-ups (deferred during the store migration)

Things intentionally parked while focusing on migrating the store package to v3.

## Codegen features

- **Enum field types.** DONE — an enum is a flavor of user type (over `uint8`, cast
  conversions, codegen-authored declaration), sharing the user-type field-wrapper
  machinery. See `renderEnum`, `userTypeConvert`, and the `enums` plumbing in
  `tablegen`/`fromConfig`/`toTableCodegen`. Exercised by the store's `KeyEncoding` table.
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

- **Inline the record codec.** DONE — `_encode`/`_decode` inline (one `abi.encodePacked`
  over raw primitives + direct `Bytes.getBytesN` casts) via the shared `staticCast.cast()`.
  Clean win: net **−6,577 gas**, zero regressions (register table −1,056, set record −639,
  get record −238, set/get Vector2 −595/−163). **But it recovered only a fraction** of the
  v3-vs-v2 record overhead — the hypothesis that the codec caused the +3–4k was WRONG.
  After inlining the residual is still get record **+3.3k**, set (internal) **+3.4k**,
  register **+1.8k** over v2. The real cost is the **handle + `RecordMethods` load/save +
  `StoreAccess` dispatch** path (Record struct alloc, the store==0 branch, the generic
  (static,lengths,dynamic) bytes-triple round trip), not the codec. Next lever lives there.
- **Record load/save path overhead — MOSTLY RESOLVED.** The apparent +3.3k/read, +3.4k/write
  was dominated by the store's `getFieldLayout` lookup (a storage read, **cold** on first table
  access in a tx), NOT the handle. Fixed by threading the table's compile-time-constant
  `_fieldLayout` through generated `load`/`save`/`destroy` (new layout-passing `RecordMethods`/
  `StoreAccess` overloads → `StoreCore`'s 3-arg/6-arg get/set/delete). Net −15,486 across the
  suite; per app-table record op ~−2,540; residual over v2 is now just the intrinsic ~900/handle.
  Caveats: (1) writes/deletes only skip the lookup on the **self-store** (`.own()`/StoreCore)
  path — the external `IStore` write interface has no layout-passing overload (a kernel-shape
  decision; revisit with the IStoreWrite shrink). (2) Passing the constant assumes `.at()` targets
  a same-shape table (same contract as v2's `tableIdArgument` and field ops). The remaining
  ~900/handle is intrinsic (lean-handle measured negative — do not chase).
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

- **World package migration** — NOW BUILD-BREAKING (deliberately). Deleting store's v2
  Solidity codegen broke downstream consumers that import store's old core tables:
  `store/src/codegen/tables/ResourceIds.sol` (~14×), `…/index.sol` (3×), `…/tables/Tables.sol`
  (1×) across world, world-modules, world-consumer, world-module-metadata, world-module-erc20
  (e.g. `AccessControl.sol`, `WorldRegistrationSystem.sol`, the erc20/erc721/keys* modules).
  Migrate these to the v3 handle API (`ResourceIds(id).exists().load()`, etc.) — plus the
  world's own tables + system/interface codegen (~79 call sites). Until then, only the store
  package builds/tests green. The v2 **TypeScript** tablegen (`ts/codegen/*.ts`) was kept (it
  is shared build infra); retire it once world stops using it.
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
