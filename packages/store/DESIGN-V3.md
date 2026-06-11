# Store v3: table handles + shared field libraries

**Status:** draft design spec
**Scope:** `packages/store` Solidity runtime + table codegen (`packages/store/ts/codegen`). The World layer is unaffected except where noted.

## Context

Today's table codegen monomorphizes everything per table: for each field it emits getters/setters whose only table-specific content is a table id, a field index, and a one-line type cast — multiplied by 3 store variants (`StoreSwitch` / `_`-prefixed `StoreCore` / optional `IStore` param), by suffixed+suffixless names, and (for dynamic fields) by 5+ extra methods. The actual encode/decode logic per ABI type is re-inlined into every table that uses that type.

This shape has measurable costs, confirmed by analyzing DUST (a large production MUD app):

- **The `_` variant split is viral.** 96% of direct table calls in DUST's root-system package use `_` variants; their own abstraction libs (e.g. `EntityIdLib`) hand-duplicate 11 method bodies as `x`/`_x` pairs because anything built on tables inherits the dispatch dimension.
- **Extending tables means editing codegen.** Adding `setItem`/`slice`/`splice` for dynamic fields ([#2019](https://github.com/latticexyz/mud/issues/2019)) requires template changes and regenerating every project.
- **User types are too limited.** DUST bypassed generated tables entirely for `Vec3` (a `uint96` packing 3×int32) — ~360 hand-written lines (`Vec3Storage.sol`) that shadow generated libs, because user types can only be a 1:1 wrap of one primitive and key encoding is fixed.
- **Usage profile** (292 direct table calls in DUST app code): 56% record get/set, 30% field get/set, 9% deleteRecord, 8% dynamic-field ops. Record-level access dominates; generated metadata helpers (`encode*`, schema getters) are used 0 times.

The core move of v3: **keep the generic-over-bytes Store core unchanged, move the type boundary from "once per table-field" to "once per ABI type," and expose tables/records/fields as first-class values.** Per-table codegen shrinks to a manifest (shapes + constants + thin constructors); all behavior lives in shared, openly extensible Solidity libraries.

### Goals

- Per-table generated code is a thin manifest; behavioral logic exists once.
- One uniform accessor API — no `_` variants, no suffixed/suffixless duplication, no `IStore`-param variants.
- Tables, records, and fields are values: generic Solidity can be written against them.
- Users extend field/record behavior (and bring their own types) with plain Solidity — no codegen involvement.
- The intuitive default spelling is correct in every execution context; the gas-optimal spelling is one explicit token.

### Non-goals

- No storage-layout, event-format, or `StoreCore` protocol changes. Generated v3 libs are wire-compatible with v2 data.
- No auto-persisting records (impossible without storage-pointer semantics) and no partial struct literals (no Solidity syntax for it).
- No change to `StoreSwitch`'s resolution mechanism (see Rejected alternatives).

## 1. What usage looks like

```solidity
import { Position, PositionData } from "./codegen/tables/Position.sol";

// ── records (the most common ops) ──────────────────────────────────
PositionData memory pos = Position(player).load();
pos.x += 1;                                  // plain memory mutation
pos.name = "spawn";
Position(player).save(pos);
Position(player).destroy();
someGenericFn(Position(player).record);      // the generic Record: keyTuple, tableId, raw ops

// ── fields: every accessor returns a typed field handle ────────────
int32 x = Position(player).x().load();
Position(player).x().save(10);
Position(player).waypoints().push(42);
uint256 n = Position(player).waypoints().length();
uint32 wp = Position(player).waypoints().load(2);
Position(player).waypoints().save(2, 7);    // new in v3 (#2019)

// ── user-typed fields carry their own methods (see §6) ─────────────
Account(user).status().transition(Status.Active, Status.Frozen);
Chunk(coord).vec().save(10, -3);             // packed codec: one storage write

// ── store dispatch (explicit paths) ────────────────────────────────
Position(player).load();                     // default: StoreSwitch inference — correct everywhere
Position(player).own().save(pos);            // "this contract's storage IS the store" (≈ v2 `_set`)
Position(player).own(worldAddr).load();      // declare an explicit store (scripts, periphery, cross-world)

// ── table id override (non-canonical table) ────────────────────────
Position(player).at(tableId).load();

// ── table level: the no-arg entry is the table handle ──────────────
Position().register();                       // canonical id, inferred store
Position().at(tableId).register();           // module: install under its caller's namespace
Position().own(store).register();            // explicit store
```

Notes on the shape:

- `Position(...)` is a **free function** (not a type), so `Position(player)` is a call, not a conversion. It takes the table's typed key(s) and binds the **canonical table id**. There is deliberately no `Position(tableId)` overload — table-id override is the `.at()` modifier — so key types can never collide with `ResourceId` in overload resolution (this matters for `ResourceId`-keyed tables).
- **One model, one vocabulary: accessors return handles; handles `load` and `save`.** The record is a handle (`load`/`save`/`destroy`); every field accessor returns a typed field handle (`load`/`save` — field access is storage I/O too, so the verbs apply uniformly — plus the dynamic op set for arrays/bytes/strings, plus whatever a user type's lib defines). `load`/`save` name the storage I/O and signal that what you hold is a memory snapshot, not a live reference. One sentence describes the whole API, and there is never a second spelling for the same operation.
- Value sugar (`x()` returning `int32`, `x(10)` setting) was prototyped and rejected: Solidity cannot overload on return type, so sugar _displaces_ the handle — and user-typed static fields (enum `transition`, packed-vector `set(x, y)`, wrapped ids) need the handle as their method attachment point. Sugar saved ~25–40 gas of struct allocation (likely optimizer-elided anyway) at the cost of the §6 extension story and a primitive-vs-custom API split. See Rejected alternatives.
- The decoded record struct is plain and mutable in memory; persisting is always an explicit `save`. There is no bound "draft"/snapshot object (considered and dropped — see Rejected alternatives).

## 2. Infra changes (`packages/store`)

### New shared Solidity (written or generated once, framework-wide)

| Component                                     | Contents                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| --------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Record.sol`                                  | `struct Record { ResourceId tableId; bytes32[] keyTuple; address store; }` + `RecordMethods` (`destroy`, `raw` load/save, hook helpers). Table-agnostic; embedded in every table's record handle. `Record` carries exactly the runtime-variable identity/dispatch state — `keyTuple` (bound at entry), `tableId` (mutable via `at()`), `store` (mutable via `own()`). `FieldLayout` is deliberately NOT a member: it is derived data (a pure function of the table), and carrying it next to a mutable `tableId` would create a consistency invariant to police. Instead, layout-needing `RecordMethods` ops have two overloads — `destroy(Record, FieldLayout)` called by generated one-liners with the table's compile-time constant (free `PUSH32`), and `destroy(Record)` which loads the layout from the store (~1 warm SLOAD) for generic/infra code. Both sources are consistent-by-construction. That overload pair is the deliberate seam between the typed layer (app code) and the generic layer (infra code). Deliberately **no `exists()`**: MUD has no existence bit — deletion zeroes storage, so an all-default record is indistinguishable onchain from a never-set one, and any storage-based check false-negatives on legitimately zero-valued records (e.g. a table of `false` booleans). Existence is an app-level convention (sentinel field, as in DUST's `EntityObjectType != 0`) or an offchain fact (indexers track set/delete events). |
| Static field handles, one per static ABI type | e.g. `Int32Field { Record record; FieldLayout fieldLayout; uint8 index; }` + `Int32FieldMethods`: `load`, `save` (layout injected as a constant by the generated accessor). Contains the **only** copy of the per-type cast (`int32(uint32(bytes4(blob)))`) and encode (`abi.encodePacked`). The handle struct (~3 words) is the attachment point for user-type wrappers and extension methods.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| Dynamic field handles, one per element type   | e.g. `Uint32ArrayField { Record record; uint8 dynamicIndex; }` + `Uint32ArrayFieldMethods`: `load` / `load(index)`, `save` / `save(index, value)`, `length`, `push`, `pop`, **`slice`, `splice`** (#2019; indexed `save` replaces v2's `update`, and whole-vs-element access is overload-disambiguated). `BytesField`, `StringField` likewise. Ships N-arity array-literal builders for ergonomic construction (e.g. `Uint32Arrays.from(a, b, c)` overloads) — unused internal overloads aren't compiled in, so the breadth is bytecode-free.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| Store dispatch (inside the field/record libs) | Branch on `record.store`: `0` → `StoreSwitch` (unchanged, SLOAD inference), `address(this)` → `StoreCore` internal, else → `IStore(store)` external. This is `StoreSwitch`'s existing branch with the SLOAD made skippable when pinned.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |

These libs are enumerable from `SchemaType` and can themselves be generated — but generated **once into the framework package**, not per project. Unused internal functions are never compiled into user contracts, so breadth is free.

### Unchanged

Storage layout, events, registration, `StoreCore`'s kernel semantics, `FieldLayout`, `EncodedLengths`, `Storage`, `Memory`. (`StoreSwitch`, `IStore*`, `Schema`, `Bytes`, `Slice`, and tightcoder are unchanged in _behavior_ but are contraction candidates — see the cleanup pass below.)

### Codegen changes (`packages/store/ts/codegen`)

- `field.ts` accessor-body rendering (cast tables, encode selection, store-variant and suffix multiplication) is deleted; replaced by emitting thin handle constructors.
- `renderTable.ts` emits the manifest described in §3.
- Config (`ts/config/v2`): `userTypes` entries gain optional `field` (handle type name, default `${name}Field`) — see §6. Existing configs remain valid.
- Unused-in-practice public surface (`encodeStatic`/`encode`/`encodeKeyTuple`/schema getters as generated externs) moves out of the default per-table output (kept available via shared libs / an opt-in codegen flag).

### World layer

- Systems, `WorldConsumer`, hooks: API-compatible usage; they consume the same handles. The world package may ship an alias method (e.g. `root()` → `own()`) as world-flavored sugar — see §7.

### Cleanup pass: kernel reduction (planned, sized but not yet designed in detail)

The store event emissions are an EIP and stay frozen — which means the protocol kernel is exactly four writes (`Store_SetRecord`, `Store_SpliceStaticData`, `Store_SpliceDynamicData`, `Store_DeleteRecord`). Much of the current onchain surface is convenience that accreted around that kernel because v2's generated tables had nowhere shared to put it. The shared method libraries are that place, so the onchain surface can contract toward the kernel itself:

1. **Shrink `IStoreWrite` to the four event-mirroring primitives.** Five of today's nine write methods are expressible as splices (`setStaticField` IS a static splice; `setDynamicField` = splice(0, oldLen); `push` = splice(end, 0); `pop` = splice(end−n, n)) and move into the field method libs. Deletes ~5 methods × (ABI + `StoreCore` impl + `StoreSwitch` mirror + hook touchpoints), and kills the dual indexing scheme (global `fieldIndex` vs relative `dynamicFieldIndex`) — the only addressing left is static byte range and dynamic field N byte range. `StoreSwitch` (~580 lines of per-method mirrors) shrinks to the kernel and is absorbed into the `StoreAccess` dispatch. Hooks follow the kernel: 4 ops × before/after.
2. **Symmetric range reads.** The read side has no EIP constraint: today's seven read methods reduce to `getRecord`, `getStaticSlice(range)`, `getDynamicSlice(field, range)`, `getDynamicLength(field)` — mirroring the splice writes. Bonus capability: a range read can fetch adjacent packed fields (`x`+`y`) in one call, which no current method can.
3. **Collapse `Schema` into `FieldLayout`.** Two bytes32 encodings of overlapping information, each with its own lib, validation, and codegen renderer — and `FieldLayout` is derivable from `Schema`. Onchain code paths only need the layout; type information is registration _data_ read by offchain consumers from the `Tables` table. Keep schemas as data, delete `Schema` as an onchain code path. (Check whether the EIP text pins the `Tables` table's registration shape — if so the encoding stays while the redundant Solidity lib still goes.)
4. **Fold `tightcoder` and most of `Bytes`/`Slice` into the field methods.** `EncodeArray`/`DecodeSlice`/`TightCoder` are generated-per-type framework Solidity whose only consumers are generated table casts; `Bytes.getBytes1..32` (64 overloads) and the public `Slice` type exist to serve them. In v3 each per-type codec lives in exactly one field method lib, so the tightcoder sub-package, its codegen pipeline, and most of `Bytes.sol` fold in; `Slice` stops being public API.
5. **Flatten the interface and base towers.** Six interfaces (`IStore` = `IStoreKernel` + `IStoreRegistration`; kernel = `IStoreRead` + `IStoreWrite` + `IStoreErrors` + `IStoreEvents`) and four bases (`Store`/`StoreRead`/`StoreData`/`StoreKernel`) for one concept → `IStore`, `IStoreHook`, one `Store` base. ([#2530](https://github.com/latticexyz/mud/issues/2530) is a symptom of the current tower.)
6. **Decide store hooks: remove entirely, or keep fully dynamic — no middle.** All four `StoreCore` write paths load `StoreHooks._get(tableId)` before doing anything — a ~100 gas (warm; 2100 cold per table per tx) storage read on **every write** (4 measured call sites). A per-table opt-in flag was considered and rejected: it's a one-way door at registration, wrong for long-lived autonomous worlds where unforeseen future functionality is the point. The real question is whether hooks earn their keep at all. Evidence: the only first-party consumers are `KeysInTable` and `KeysWithValue` — acknowledged-inefficient index modules whose job is done strictly cheaper by **write-through extension methods** (the DUST pattern: `ReverseMovablePosition` maintained alongside `EntityPosition`, standardized as a shipped method lib that writes both tables inline — no hook lookup, no per-write external `CALL` to a hook contract, just the index write). The current ERC20 module uses zero store hooks (it emits its own events); DUST registers zero. What removal genuinely loses: intercepting writes from writers you've granted _direct table access_ but don't control — mitigated by system-mediated access (better practice anyway) plus namespace-owner system upgradability; note that in ossified worlds (ownership renounced) hooks can't be registered either, so hooks add no optionality there. If that loss is acceptable: delete `IStoreHook`, `Hook.sol`, the `StoreHooks` table, and the before/after machinery — ~100 gas off every write in every world, forever, and [#3636](https://github.com/latticexyz/mud/issues/3636) becomes moot. If not: keep hooks exactly as dynamic as today and treat the SLOAD as the price of optionality (adopting #3636's before→after data passing in the redesign).
7. **Offchain tables: omit read methods.** An offchain table's `set` emits events but writes nothing; reads silently return zeros today. The v3 manifest omits getters (and read-dependent ops) for offchain tables — a compile error instead of silent wrong data. Pairs with a `disabled`/client-only table flag in config ([#3187](https://github.com/latticexyz/mud/issues/3187)).
8. **Finish the naming sweep.** The `Lib`/`Instance` dual-library pattern across the existing package (`FieldLayoutLib`+`FieldLayoutInstance`, same for `EncodedLengths`, `Slice`, `ResourceId`, `Hook`) collapses to one `<Type>Methods` library plus free-function constructors for the survivors of items 1–5. One convention package-wide. (Adjacent: [#2735](https://github.com/latticexyz/mud/issues/2735) `ResourceId` "name" terminology.)
9. **Declare the compiler posture.** The design leans on via-IR inlining (handle folding, `own()` branch elision); v3 officially targets via-IR — docs, templates, and gas numbers assume it, legacy pipeline best-effort.
10. **Ship the injectable-store testing story.** Because the store target is handle state, a lightweight `TestStore` (kernel + registration only) makes tables unit-testable without deploying a World: `Position(player).own(address(testStore)).set(...)`. [#3126](https://github.com/latticexyz/mud/issues/3126) asks for exactly this (`export StoreMock`).
11. **No `codegen/index.sol`.** The barrel-import pattern makes any codegen change ripple into importing contracts' bytecode, breaking deterministic deploys ([#2838](https://github.com/latticexyz/mud/issues/2838), [#2581](https://github.com/latticexyz/mud/issues/2581)). v3 manifests are imported directly, never re-exported through a barrel. NatSpec on the (now small) generated output is cheap to include ([#2690](https://github.com/latticexyz/mud/issues/2690)).

### Table registration and modules

The no-arg entry overload is the **table handle** — completing the model (tables, records, and fields are all values):

```solidity
struct Table {
  ResourceId tableId; // canonical id; at() retargets
  FieldLayout fieldLayout;
  Schema keySchema;
  Schema valueSchema;
  string[] keyNames;
  string[] fieldNames;
  address store; // own() pins, as on records
}
// shared TableMethods (using ... for Table global): register, at, own

// per-table codegen: one more entry overload, constants only
function Position() pure returns (Table memory);
function Position(address player) pure returns (PositionRecord memory); // as before — legal overload pair
```

```solidity
Position().register();                       // canonical id, inferred store
Position().at(tableId).register();           // module installing under its caller's namespace
Position().own(store).register();            // explicit store
```

**Singleton tables** (`key: []`) are the one collision: their record entry is already the no-arg `Counter()`. Resolution: a singleton's table handle IS its record handle — the table is one record, so `Counter().load()`, `Counter().save(5)`, and `Counter().register()` coexist on one generated handle type (record verbs generated as usual, table verbs as thin delegations). Reading note: this puts `register` in the singleton field-name reserved set (no-arg, like `load`); the standard rename rule covers it.

The generic layer stays available for code without the codegen artifacts: `TableMethods.register(table)` works on a hand-built `Table`, and a deployer can batch defs into one `registerTables(Table[])` call instead of N generated `register()` functions ([#1280](https://github.com/latticexyz/mud/issues/1280) is the world-side analog for function selectors). This answers [#3590](https://github.com/latticexyz/mud/issues/3590) (register a table lib under a different namespace without hand-encoding resource ids — `at()` takes the id, or a namespace-flavored overload derives it from namespace + the table's label) and gives modules a first-class path: retarget with `at()`, register, then use the same `at()` on record handles for writes. The `Tables` table and reflection ([#2550](https://github.com/latticexyz/mud/issues/2550)) remain the onchain source of truth for third parties.

Out of scope for this spec but same philosophy: the World layer's generated surface (per-system interfaces, composed `IWorld`, system libraries with their own call-variant multiplication) wants the same manifest + handle treatment; The TS config layer's type-level validate-then-transform architecture stays: type-level validation is load-bearing, not gymnastics — the output types are only safely derivable from _validated_ input types, and the validation layer is what produces precise compile-time errors at the exact config location (including replacing bad fragments with error-message types). Any simplification there is internal refactoring under the same architecture.

Explicitly untouched: event formats and `EncodedLengths`-in-events (EIP), the `bytes32[]` keyTuple (events), and the storage slot scheme (not frozen — events ≠ storage — but good, and changing it buys nothing while breaking in-place upgrades).

## 3. Codegen output (the per-table manifest)

For this config:

```ts
tables: {
  Position: {
    schema: { player: "address", x: "int32", y: "int32", name: "string", waypoints: "uint32[]" },
    key: ["player"],
  },
}
```

codegen emits (signatures shown; bodies are one-liners except the record codec):

```solidity
// codegen/tables/Position.sol
import { Record, RecordMethods } from "@latticexyz/store/src/Record.sol";
import { Int32Field, StringField, Uint32ArrayField } from "@latticexyz/store/src/fields/...";

struct PositionData {
  int32 x;
  int32 y;
  string name;
  uint32[] waypoints;
}

struct PositionRecord {
  Record record;
}
using PositionRecordMethods for PositionRecord global;

ResourceId constant _TABLE_ID = ResourceId.wrap(0x...);
FieldLayout constant _FIELD_LAYOUT = FieldLayout.wrap(0x...);
Schema constant _KEY_SCHEMA = Schema.wrap(0x...);
Schema constant _VALUE_SCHEMA = Schema.wrap(0x...);

/// Entry point: typed key in, record handle out, canonical table id bound.
/// This is the ONLY place the key schema is encoded.
function Position(address player) pure returns (PositionRecord memory r) {
  r.record.tableId = _TABLE_ID;
  r.record.keyTuple = new bytes32[](1);
  r.record.keyTuple[0] = bytes32(uint256(uint160(player)));
}

library PositionRecordMethods {
  // ── modifiers (chainable, one line each) ──
  function at(PositionRecord memory self, ResourceId tableId) internal pure returns (PositionRecord memory);
  function own(PositionRecord memory self) internal view returns (PositionRecord memory);            // = own(address(this))
  function own(PositionRecord memory self, address store) internal pure returns (PositionRecord memory);

  // ── field handle constructors (one line each) ──
  function x(PositionRecord memory self) internal pure returns (Int32Field memory);                  // index 0
  function y(PositionRecord memory self) internal pure returns (Int32Field memory);                  // index 1
  function name(PositionRecord memory self) internal pure returns (StringField memory);              // dynamic 0
  function waypoints(PositionRecord memory self) internal pure returns (Uint32ArrayField memory);    // dynamic 1

  // ── record ops (thin delegations to RecordMethods + the codec below) ──
  function load(PositionRecord memory self) internal view returns (PositionData memory);
  function save(PositionRecord memory self, PositionData memory data) internal;
  function destroy(PositionRecord memory self) internal;

  // ── the only shape-specific logic that remains generated ──
  function _encode(PositionData memory data) private pure
    returns (bytes memory staticData, EncodedLengths lengths, bytes memory dynamicData);
  function _decode(bytes memory staticData, EncodedLengths lengths, bytes memory dynamicData)
    private pure returns (PositionData memory);
}

/// Table registration helper (replaces today's `register()`), delegating to shared code.
function registerPosition() { ... }
```

What's gone relative to v2 output: `getX/_getX/setX/_setX` per field (×3 store variants ×2 suffixes), all per-field dynamic-method bodies, all inline casts, `_keyTuple` reconstruction in every accessor. What remains per table is **declarations, constants, one-line constructors, and the record codec** — the record codec being the only genuinely shape-specific code (struct field order ↔ tight-packed layout).

### Method namespace and field-name collisions

Field accessors share the record handle's method namespace with the framework vocabulary, so field names could collide with reserved methods. The design keeps that surface deliberately small:

- **Solidity overloading absorbs most of it** (verified empirically): attached methods disambiguate by parameter list, so fields named `save` or `at` coexist with `save(self, data)`, `at(self, tableId)`. Field accessors are all no-arg handle constructors, so only **no-argument** framework methods reserve names. (Collision detection should still key on `(name, parameter types)` for future-proofing.)
- **Field-handle methods never constrain field names**: `load`/`save`/`length`/`push`/`slice`/extension methods live on framework types (`Int32Field`, `Uint32ArrayField`, …), not in the field-name namespace.
- **Rare/meta operations live on the `record` member**, not as top-level methods: `raw`, `keyTuple`, `tableId`, `store` are reached via `Position(player).record.…` and reserve nothing (only the member name itself — a method sharing a struct member's name is a hard compile error, also verified).

Residual reserved set: **`load`, `destroy`, `own`, `record`** — kept top-level because record load/save/destroy are 65% of real-world usage (DUST) and must stay unprefixed. (`load` and `destroy` are verbs and field names are nouns; no collision observed across DUST's ~100 field names, and the rename rule backstops. A pleasant side effect of the load/save verbs: `get` and `set` no longer appear anywhere in the API, so both are valid field names.)

Independently of this design, bare field accessors inherit a constraint v2's `getX` prefixes hid: a field named after a **Solidity keyword** (`type`, …) cannot be a method name at all. So a rename rule is required regardless, and reserved words ride the same mechanism:

- Codegen detects collisions (reserved set + keywords) and emits a deterministic trailing-underscore accessor (`type` → `.type_()`, `load` → `.load_()`) with a build warning — trailing underscore is the Solidity style guide's own collision convention. A per-field config override (`codegen: { methodName: "..." }`) allows choosing a better name.
- Overload-legal-but-confusing names (a field named `set`) are allowed; lint-level warning at codegen time.
- Validation across DUST's 40+ tables (~100 distinct field/key names, including `value`, `name`, `data`, `key`, `root`, `index`): **zero** collisions with the reserved set.

The zero-reserved alternative — nesting all field accessors behind a hop (`Position(player).fields().x()`) — was considered and dropped: it taxes 30% of all calls with an extra hop and still doesn't eliminate the keyword problem, so it buys no rule simplification.

The shared field lib it delegates to (for reference; lives once in `packages/store`):

```solidity
struct Int32Field {
  Record record;
  FieldLayout fieldLayout;
  uint8 index;
}
using Int32FieldMethods for Int32Field global;

library Int32FieldMethods {
  function load(Int32Field memory self) internal view returns (int32) {
    bytes32 blob = StoreAccess.getStaticField(self.record, self.index, self.fieldLayout);
    return int32(uint32(bytes4(blob))); // the cast: once per ABI type, framework-wide
  }
  function save(Int32Field memory self, int32 value) internal {
    StoreAccess.setStaticField(self.record, self.index, abi.encodePacked(value), self.fieldLayout);
  }
}
```

## 4. Store dispatch

A handle's `record.store` is the entire dispatch mechanism:

| Spelling              | Resolution                                             | Cost vs v2               | Replaces                |
| --------------------- | ------------------------------------------------------ | ------------------------ | ----------------------- |
| _(default, unpinned)_ | `StoreSwitch` (slot SLOAD → `msg.sender` fallback)     | unchanged                | no-prefix methods       |
| `.own()`              | `StoreCore`, internal — `= own(address(this))`         | ~0 (one compare; see §8) | `_`-prefix methods      |
| `.own(addr)`          | `addr == address(this)` ? `StoreCore` : `IStore(addr)` | new capability           | `IStore`-param variants |

Design notes:

- The default stays **safe-everywhere**: copy-pasted code behaves identically in root systems, non-root systems, hooks, tests, and scripts. Small projects never learn the other two spellings.
- **One concept, two arities**: `own(...)` declares the record's storage owner; the zero-arg form means "me" (`own(address(this))`). The no-arg form states the caller's assumption ("I execute as the contract that owns this data" — root systems, the World, a standalone Store) at the call site, greppably. Misusing `own()` in a non-root contract writes that contract's own storage — the same hazard as misusing `_set` in v2, now at least visible in the source. (Reading note: `own(addr)` is declarative — "owned by addr" — not imperative.)
- `.own(_world())` gives write-once shared libraries a single implementation that is correct in every context (root: resolves to self → internal; non-root: external call), paying one slot SLOAD per handle instead of per op. This eliminates the viral `x`/`_x` duplication in downstream abstraction libs.
- Because the store target is a _value_, deployment posture is a per-project choice, not an API fork: bound apps (the DUST pattern — every program already takes the world in its constructor) pin; portable modules simply don't.

## 5. Keys

- The table entry function is the **single** place a table's key schema is encoded (v2 rebuilds `_keyTuple` inside every accessor). Composite keys are additional parameters: `ResourcePosition(objectType, index)`.
- Keys remain `bytes32[]` — one statically-typed `bytes32` per column. This is load-bearing (storage hashing, event format, indexers) and does not change.
- User types used as keys encode as **one column** via their underlying primitive (plain unwrap + pad). Richer key encodings — one Solidity value expanding into N queryable columns, the DUST `Vec3` case (`uint96` ↔ three `int32` columns for per-axis offchain queries) — are **deferred from this draft**: the drafted per-user-type `keySchema` mixed concerns (a type's value representation vs a table's key/offchain modeling), and the API will be designed separately. See Open questions.

## 6. User types: bring-your-own field codecs

Inversion of responsibility: today codegen _understands_ user types (renders `wrap`/`unwrap` inline); in v3 a user type **ships its own handle**, and codegen only constructs it. The contract between codegen and the type is structural: the handle struct wraps the primitive field handle for its declared storage type.

```ts
userTypes: {
  EntityId: { type: "bytes32", filePath: "./src/types/EntityId.sol" },          // scalar: nothing else needed
  Vec3: { type: "uint96", filePath: "./src/types/Vec3.sol" },                    // packed codec type (see below)
}
```

```solidity
// src/types/EntityId.sol — plain Solidity, no codegen involvement
type EntityId is bytes32;

struct EntityIdField {
  Bytes32Field inner;
}
using EntityIdFieldMethods for EntityIdField global;

library EntityIdFieldMethods {
  function load(EntityIdField memory self) internal view returns (EntityId) {
    return EntityId.wrap(self.inner.load());
  }
  function save(EntityIdField memory self, EntityId value) internal {
    self.inner.save(EntityId.unwrap(value));
  }
}
```

Codegen's involvement is one import and one constructor call per field (`return EntityIdField(Bytes32Field(self.record, _FIELD_LAYOUT, 0));`). It never sees the codec logic.

User types as keys work today via the default scalar path: one column, plain unwrap + pad of the underlying primitive. Multi-column key expansion is deferred (see §5 and Open questions).

### Enums, end to end

Enums declared in config get the same treatment: codegen emits the enum and its (mechanical) field handle once per enum, and domain logic lands as a user method library — no codegen involvement past the handle.

```ts
enums: {
  Status: ["Inactive", "Active", "Frozen"],
},
tables: {
  Account: { schema: { user: "address", status: "Status" }, key: ["user"] },
}
```

```solidity
// codegen (once per enum, alongside the enum definition — stored as uint8, as today)
enum Status {
  Inactive,
  Active,
  Frozen
}

struct StatusField {
  Uint8Field inner;
}
using StatusFieldMethods for StatusField global;

library StatusFieldMethods {
  function load(StatusField memory self) internal view returns (Status) {
    return Status(self.inner.load());
  }
  function save(StatusField memory self, Status value) internal {
    self.inner.save(uint8(value));
  }
}
```

```solidity
// user code — domain logic attached without touching codegen
library StatusMethods {
  error InvalidTransition(Status expected, Status actual);

  function transition(StatusField memory self, Status from, Status to) internal {
    Status current = self.load();
    if (current != from) revert InvalidTransition(from, current);
    self.save(to);
  }
}
using StatusMethods for StatusField;

Status status = Account(user).status().load(); // typed, not uint8
Account(user).status().transition(Status.Active, Status.Frozen);
```

The handle is what v2 enums lack: today an enum field is a `uint8` with a cast in the generated getter, and there is nowhere to hang `transition` — it ends up as a free function per table or copy-pasted requires. Here it's written once against `StatusField` and works on every `Status`-typed field in every table.

This removes the current limitations wholesale, because the codec is open code instead of generator logic:

- **Enums become real types** — a `StatusField` lib can expose `transition(from, to)`, not just a bare `uint8` wrap (full example above).
- **Custom packings** — `type PackedVec2 is uint64` with `getX()/getY()/set(x, y)` over one storage primitive.
- **Nesting** — `type ChunkId is EntityId`-style layering is ordinary struct composition; config only needs the ultimate primitive.
- **It's a package ecosystem**: a type + its field methods + extensions ship as one Solidity file; installing is an import plus a config entry. Most of `Vec3Storage.sol` stops needing to exist (its Vec3-keyed multi-column tables await the deferred key-encoding design).

The struct-field seam: in `PositionData`, a user-typed field is the bare UDVT; the generated record codec uses the UDVT's free `wrap`/`unwrap`. Rich codecs apply at _field-handle_ level; record-level decode hands you the UDVT to use its own accessors.

## 7. Extensibility without touching codegen

Because handles are ordinary types, behavior accretes in libraries:

**Shared-lib growth (framework PRs, zero regeneration).** Adding indexed `save`/`slice`/`splice` to `Uint32ArrayFieldMethods` lights up every array field in every table ever generated. [#2019](https://github.com/latticexyz/mud/issues/2019) collapses from "extend the generator and regenerate the ecosystem" to "add three functions to one library." Same for `RecordMethods` (e.g. a future `copyTo(Record)`).

**Extension methods (user/third-party packs).** There is one mechanism in this design: method libraries. The only distinction — enforced by the language, not by convention — is that `using ... global` is legal only in the type's defining file, so **canonical** methods (`Int32FieldMethods`) are ambient everywhere, while everyone else's methods attach per-file. An "extension" is just a method library you attach yourself — against field handles, per-table record types, or user UDVTs. The `<Type>Methods` naming is the SDK's convention; user and third-party packs name theirs freely — the ecosystem may well call these "traits", and that's fine: same mechanism either way:

```solidity
library CounterMethods {
  function increment(Uint32Field memory self) internal returns (uint32) { ... }
}
library ArrayMethods {
  function appendUnique(Uint32ArrayField memory self, uint32 value) internal { ... }
}
library MoveMethods {
  function teleport(PositionRecord memory self, int32 x, int32 y) internal { ... }
}
// consumer file:
using CounterMethods for Uint32Field;
using ArrayMethods for Uint32ArrayField;
using MoveMethods for PositionRecord;
Score(player).points().increment();
Inventory(owner).slots().appendUnique(5);
Position(player).teleport(0, 0);
```

(No Rust-style machinery is implied: there are no bounds, no required-method checks, nothing to abstract over — this is C#-style extension methods. The usual collision rule applies: two visible same-name, same-signature attachments on one type error at the call site. DUST's `EntityIdLib` — methods on a key type spanning many tables — is the record/UDVT pattern.)

**Layer-appropriate aliases.** The world package can rename Store concepts for its audience without the Store API knowing about namespaces — e.g. `root()` as a world-layer extension method delegating to `own()` (possible, though `own()` is layer-neutral — "my own storage" is accurate for root systems, the World, and standalone Stores alike — so no alias is needed).

**Generic tooling.** Functions over `Record` and typed field handles work across tables they've never seen — `bump(Int32Field memory, int32)` works for `Position.x`, `Health.current`, any int32 field anywhere. Schema reflection (`Schema`/`FieldLayout` are onchain) enables fully generic admin/migration code as a later, independent layer.

## 8. Gas & bytecode trade-offs

Honest accounting (estimates to be confirmed by the benchmark plan below):

- **Handle construction is memory-struct churn**: `Position(player)` allocates the `Record` + wrapper (~4–5 words) on top of the keyTuple alloc v2 already pays, and each field accessor allocates a ~2–3 word handle — together roughly 30–70 gas per accessor chain, likely less where via-IR elides non-escaping structs. Noise on writes (5k–20k+) and cold reads; a few-percent relative cost on warm reads in tight loops, mitigated by reusing handles (they're values — hoist the record or field handle when touching it repeatedly).
- **`.own()` vs v2 `_get`**: worst case ~15–20 gas (MLOAD + compares); with via-IR inlining the `EQ(ADDRESS, ADDRESS)` comparison is CSE-foldable to the bare `StoreCore` call. Verifying this fold is an explicit acceptance criterion.
- **Default path**: unchanged from v2 no-prefix methods (same `StoreSwitch` SLOAD).
- **Bytecode**: internal functions are included only when referenced and deduplicate per function — multi-table contracts shrink (one `Int32FieldMethods.get` instead of N inlined casts); a single-table/single-field contract grows slightly. Extension-method breadth costs nothing until called. Generated _source_ shrinks dramatically (compile time, artifacts).
- **Workload-shaped benchmarks** (DUST profile): a move-loop (warm field reads ×N), an inventory scan (`length` + `load(i)` ×N), record load/mutate/save, both compiler pipelines, `forge snapshot` diff against v2 output. Stretch goal: port one real DUST system.
- **Handle-layout A/B**: the `FieldLayout`-placement decision (§2 — on `Record` vs injected at call sites) was made on design-hygiene grounds with the gas argued to be a wash; benchmark both variants across the workload set (record-op-heavy, single-field-heavy, multi-field-per-record, generic `RecordMethods` ops) to confirm with numbers. Same treatment for `Record` packing generally (open question 4) — the struct's word count multiplies across every access, so small layout choices deserve measured, not argued, answers.

## 9. Rejected alternatives (and why)

- **Calldata-appended world address** (context becomes `[world][sender][value]`, ~10 gas resolution): prototyped on this branch; end-to-end gas savings were minimal and often negative (per-call append cost on every world→system call outweighed per-op read savings at realistic ops-per-call). The SLOAD-based `StoreSwitch` default stays.
- **Per-package compile-time dispatch default** (`storeDispatch: "core"` swapping the meaning of the default): identical code meaning different things in different packages; rejected for clarity.
- **Typed root handles / import-flavored tables** (compile-time `StoreCore` dispatch via parallel types or parallel artifacts): exact-zero dispatch but re-creates the viral fork that made DUST duplicate its abstraction libs. Held as a measured fallback only if `.own()` benchmarks unacceptably.
- **`Position(tableId)` / `Position(tableId, key)` overloads**: collide with single-`ResourceId`-keyed tables; the canonical-id entry + `.at()` modifier avoids the collision class entirely.
- **`.x` as struct member, `f(a)(b)` currying, auto-persisting records, partial struct literals**: ruled out by Solidity semantics (member access requires materializing all fields; function types can't close over values; memory writes have no observer; struct literals are total).
- **Bound "draft"/snapshot records** (`snapshot()` with lazy load, buffered writes, dirty-bit `save()`): implementable (lazy load via memory mutation in `view` is legal; `save()` could coalesce adjacent dirty static fields into one splice), but rejected: a second generated per-table surface, dirty-bitmask branching on every access, and divergence hazards (a snapshot doesn't see external writes; two snapshots of one record don't sync). `load` → mutate → `save` covers the flows.
- **Free-function method sets** (`using { get, set } for Int32Field global` — no library, no name): verified to work with one handle type per file, and attachments travel with the type. But `using { f }` rejects any overloaded identifier (verified), so the `own()`/`own(addr)` pair cannot attach as free functions — records would need a library anyway, and a mixed free-function/library convention was rejected for consistency. Everything ships as `<Type>Methods` libraries; un-overloading `own` to rescue purity would trade a user-facing API regression for invisible naming cleanliness.
- **Static-field value sugar** (`x()` returning `int32`, `x(value)` setting, chainable): briefly adopted on a "static op sets are closed" rationale, then reverted. Solidity can't overload on return type, so sugar displaces the handle — and user-typed static fields (enum `transition`, packed-vector codecs, wrapped ids) need the handle as their method attachment point, making static op sets open after all. The sugar saved one ~3-word allocation per access (~25–40 gas, likely optimizer-elided) and one token, at the cost of the §6 extension story and a primitive-vs-custom API split. Uniform handles won.
- **Dual path (value sugar + handles for the same field)**: rejected — two spellings for one operation means users must always ask which to use.
- **Nesting field accessors behind a member** (`.data.x()` / record ops behind `.meta`): taxes one of the two hot paths (fields 30% / record ops 56–65% of usage) for a namespace purity the rename rule already provides.

## 10. Open questions

1. Does via-IR reliably fold the dispatch branch, the record wrapper, and the field handle constructors? (Benchmark gate; determines whether typed-core handles ever need to exist.)
2. Recommended compiler posture for downstream projects (via-IR strongly encouraged?) and numbers on the legacy pipeline.
3. Arrays of user types: element-wise wrap loop vs the assembly pointer-cast trick, owned by the framework-provided array-wrapper template.
4. Record-handle packing: `keyTuple` as `bytes32[]` is flexible but allocation-heavy; is a fixed-size/inline encoding worth it for 1-key tables (the overwhelmingly common case)?
5. Naming (resolved). Record deletion: `remove()` — `delete` is a Solidity keyword and thus impossible, `del` is an abbreviation, `remove` is ecosystem-idiomatic; `clear()` noted as the semantically precise alternative since deletion zeroes rather than removes existence. Superseded in review: record verbs are `load`/`save`/`destroy` — `load`/`save` name the storage I/O and signal that the struct is a memory snapshot (not a live reference), `destroy` completes that vocabulary; the verbs apply uniformly to field handles too (field access is storage I/O, per review), including the indexed overloads `load(i)`/`save(i, v)` — `get`/`set` disappear from the API entirely, freeing both as field names. Table-id override: `at(tableId)` — `in` is a reserved keyword; `at` is unambiguous since keys bind at the entry function. Store owner: `own()` / `own(addr)` — one declarative concept, two arities; `local`/`core`/`via` superseded. Meta member: `record` — names its own type (`Record record;`, matching the field-handle convention), reads naturally (`.record.keyTuple`), and avoids `base`, a plausible game field name; a field named `record` falls under the standard rename rule. (`exists()` was cut from `RecordMethods` entirely: no existence bit exists onchain, so any storage-based check is a footgun — see §2.) Method-set libraries: `<Type>Methods` suffix (`Int32FieldMethods`, `PositionRecordMethods`) — in a `using`-for world, v2's `Lib` says nothing while `Methods` names exactly what the library is; the `Lib`/`Instance` split is superseded. Handle types keep the `Field` suffix: user-type and enum handles can't share their UDVT/enum's name, dynamics collide with existing names (`Bytes` lib, `string` keyword), and `Int32` vs `int32` would put a case-only distinction on the API's biggest semantic difference (storage reference vs value).
6. Migration story: codemod for v2 call sites (`Table.getX(k)` → `Table(k).x().load()`, `Table._set(k, v)` → `Table(k).own().save(v)`), and whether a v2-compat shim layer is worth generating during transition.
7. Offchain-table ergonomics: setter-only manifest variant?
8. **Composite types for keys/values — leading candidate: declared column expansion + hand-written codec** (direction, not decision; this replaced, in order: per-type `keySchema` (mixed concerns), positional `'Vec3[0]'` schema references (instance ambiguity, string parsing), a `structs` config section with codegen-authored types, and a scaffolded-type variant — both of the last two rejected as too much magic: generated types, write-once files in `src/`, and generated↔user circular imports). The concrete shape: **config describes, never authors; the user writes the type and codec in plain Solidity; the compiler validates the contract.**

   ```ts
   userTypes: {
     Vec3: {
       type: "uint96",
       filePath: "./src/types/Vec3.sol",
       schema: { x: "int32", y: "int32", z: "int32" },   // optional: declares column expansion
     },
   },
   tables: {
     EntityPosition: { schema: { position: "Vec3", entityId: "EntityId" }, key: ["position"] },
     Portal: { schema: { from: "Vec3", to: "Vec3" }, key: ["from", "to"] },
   }
   ```

   ```solidity
   // src/types/Vec3.sol — fully hand-written; no generated counterpart, no scaffold artifact, no cycles
   type Vec3 is uint96;
   library Vec3Codec {
     function encode(Vec3 v) internal pure returns (int32 x, int32 y, int32 z);
     function decode(int32 x, int32 y, int32 z) internal pure returns (Vec3);
   }
   using Vec3Methods for Vec3 global; // methods/operators: user's file, plain using lines
   ```

   All `userTypes` are imports (no declare mode); `schema` just adds "this type expands to these columns." The codec is a library (not attached methods or free functions) because `decode` forces it: it's constructor-shaped (no instance to attach to), and as a bare free function two same-component-shape types would collide (identical params, return-type-only difference — not overloadable); the library is Solidity's namespacing idiom and gives codegen one deterministic call target. Users may still attach `encode` as a method for app code. Codegen calls `${Name}Codec.encode/decode` by convention at entry/key/value sites — a signature mismatch with the declared schema fails _compilation_ of generated code with a precise error, so the config↔Solidity contract is compiler-enforced, not config-machinery-enforced. Import direction is strictly one-way (generated code imports user source, never vice versa). As a key the type expands to N columns (`position_x`, `from_x`/`to_x` — instance naming free via field names); as a value, N tight-packed component fields with per-component offchain columns (partially answering [#1461](https://github.com/latticexyz/mud/issues/1461)) and a generated `Vec3Field` handle whose `save()` coalesces components into one static splice. Storage is byte-identical to a hand-packed primitive — tight-packing lives in `FieldLayout`, not ABI types. A one-shot `scaffold-type` CLI command can emit the ~15-line UDVT+codec starter (following the packing-order-matches-layout convention so whole-value load/save is a bytes-level cast) — a generator the user invokes once, not a build-owned artifact. Edges: components static- and primitive-only in v1, count toward the 28-field cap, no nesting; codec packing order matching layout order is a convention (scaffold default), not an invariant.

## EIP revision notes

v3 treats the store event emissions as frozen. But three EIP-impacting items surfaced during this design — recorded here so any future EIP iteration starts from them rather than rediscovering them:

1. **Splice-event addressing: bytes vs fields** ([#2222](https://github.com/latticexyz/mud/issues/2222) vs [#1222](https://github.com/latticexyz/mud/issues/1222)). The shipped events are byte-addressed and schema-independent (deliberately, per #1222): indexers can sync records as raw blobs, fully parallel, with no schema-ordering dependency in the event stream. #2222 proposes field-aware events (field index, or element offsets instead of byte offsets) — simpler per-field offchain modeling and less offset translation in table libs, but it cements one-splice-one-field and requires a layout-aware kernel (StoreCore would need `FieldLayout` to convert elements→bytes). These directions diverge rather than compose, and v3's architecture (range-based kernel, element→byte translation in shared field methods, `Schema` out of code paths) doubles down on the byte-addressed side — so adopting #2222 later would mean walking back part of the kernel design. **Decide this fork first in any revision.**
2. **The 5-dynamic-field cap is event-format, not implementation** ([#1463](https://github.com/latticexyz/mud/issues/1463)). `EncodedLengths` packs 5×uint40 lengths + a 56-bit accumulator into the one bytes32 carried by `Store_SetRecord` and `Store_SpliceDynamicData`. Raising the cap means a new lengths encoding in events — an EIP change by definition. A revision could reconsider the packing (wider word, variable-length encoding) against the 28-total-field ceiling that `FieldLayout`/`Schema` share.
3. **How much of the registration shape the EIP pins** (touches cleanup item 3, registration-as-data, and [#2711](https://github.com/latticexyz/mud/issues/2711)). Registration is "ordinary records written to the `Tables` table," so its shape (`fieldLayout`, `keySchema`, `valueSchema`, abi-encoded `keyNames`/`fieldNames`) flows through standard events — the question is whether the EIP text specifies that table's schema or treats it as an implementation detail. The answer gates: collapsing `Schema` to registration-only data, changing name encodings (#2711's bytes32 names), and batch registration shapes. **Action item: read the EIP text and mark each registration field as pinned or free before the cleanup pass touches any of them.**

(Confirmed _not_ EIP-bound, for contrast: store hooks, the storage slot scheme, and everything in the read path — those are freely rewritable.)

## Appendix: issue tracker cross-reference

Open issues this design addresses, should address, or consciously cannot:

| Issue                                                                                                                                                                                     | Status in this design                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [#2019](https://github.com/latticexyz/mud/issues/2019) dynamic-length methods (indexed save/slice/splice)                                                                                 | Addressed: shared dynamic field methods (§2); future additions are library PRs, not codegen changes.                                                                                                                                                                                                                                                                                                                                                                                                                   |
| [#3590](https://github.com/latticexyz/mud/issues/3590) table lib registration helpers                                                                                                     | Addressed: table handles — `Position().at(tableId).register()` (§2 registration).                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| [#2693](https://github.com/latticexyz/mud/issues/2693) `decodeStatic` stack-too-deep on wide tables                                                                                       | Must design around: the v3 record codec decodes into the struct in place instead of returning N-wide tuples. Acceptance test: a 28-static-field table must compile.                                                                                                                                                                                                                                                                                                                                                    |
| [#3126](https://github.com/latticexyz/mud/issues/3126) export StoreMock                                                                                                                   | Addressed: `TestStore` + `own(addr)` injectable-store testing (§2 item 10).                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| [#3636](https://github.com/latticexyz/mud/issues/3636) pass data from before to after hooks                                                                                               | Folded into the hook decision (§2 item 6): moot if store hooks are removed; adopted if they stay.                                                                                                                                                                                                                                                                                                                                                                                                                      |
| [#3187](https://github.com/latticexyz/mud/issues/3187) `disabled`/client-only tables                                                                                                      | Folded into offchain/manifest flags (§2 item 7).                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| [#2838](https://github.com/latticexyz/mud/issues/2838) / [#2581](https://github.com/latticexyz/mud/issues/2581) index.sol breaks deterministic deploys                                    | Addressed: no barrel files (§2 item 11).                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| [#2690](https://github.com/latticexyz/mud/issues/2690) NatSpec on generated libs                                                                                                          | Cheap now that output is a manifest (§2 item 11).                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| [#1653](https://github.com/latticexyz/mud/issues/1653) methods taking raw `bytes32[]` keyTuple                                                                                            | Addressed: construct a `Record` directly with a raw keyTuple; the generic layer is exactly this.                                                                                                                                                                                                                                                                                                                                                                                                                       |
| [#1654](https://github.com/latticexyz/mud/issues/1654) arrays of enums / user types in config                                                                                             | Addressed by §6 array wrappers (framework-provided template; loop-vs-assembly is open question 3).                                                                                                                                                                                                                                                                                                                                                                                                                     |
| [#2550](https://github.com/latticexyz/mud/issues/2550) read table info without metadata                                                                                                   | Reflection layer over onchain `Schema`/`FieldLayout` (§7 generic tooling).                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| [#2407](https://github.com/latticexyz/mud/issues/2407) codegen Bytes.sol                                                                                                                  | Superseded: Bytes folds into field methods (§2 cleanup item 4).                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| [#3023](https://github.com/latticexyz/mud/issues/3023) require ≥1 value field                                                                                                             | Config validation; carries over.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| [#1461](https://github.com/latticexyz/mud/issues/1461) structs as field types                                                                                                             | Partially: single-slot packed structs via user-type codecs (§6 `PackedVec2`); true multi-field struct fields remain out of scope (a record is the struct).                                                                                                                                                                                                                                                                                                                                                             |
| [#1463](https://github.com/latticexyz/mud/issues/1463) more than 5 dynamic fields                                                                                                         | Cannot fix: the `EncodedLengths` packing (5×uint40) is in the event EIP.                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| [#2711](https://github.com/latticexyz/mud/issues/2711) bytes32 field names                                                                                                                | Tied to the registration-shape EIP check (§2 cleanup item 3).                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| [#1133](https://github.com/latticexyz/mud/issues/1133) store gas metrics/optimizations                                                                                                    | Folded into the §8 benchmark plan.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| [#2222](https://github.com/latticexyz/mud/issues/2222) field index / element offsets in splice events (vs [#1222](https://github.com/latticexyz/mud/issues/1222)'s byte-addressed design) | EIP-revision fork, recorded: the shipped byte-addressed events ([#1222](https://github.com/latticexyz/mud/issues/1222)) keep events schema-independent and the kernel layout-blind — which v3's range-based kernel and lib-side element→byte translation double down on. [#2222](https://github.com/latticexyz/mud/issues/2222)'s field-aware events would simplify per-field offchain modeling but require a layout-aware kernel and cement one-splice-one-field. If the EIP is ever revised, decide this fork first. |
