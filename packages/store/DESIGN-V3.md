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
- Users extend field/record behavior (and bring their own types, including key encodings) with plain Solidity — no codegen involvement.
- The intuitive default spelling is correct in every execution context; the gas-optimal spelling is one explicit token.

### Non-goals

- No storage-layout, event-format, or `StoreCore` protocol changes. Generated v3 libs are wire-compatible with v2 data.
- No auto-persisting records (impossible without storage-pointer semantics) and no partial struct literals (no Solidity syntax for it).
- No change to `StoreSwitch`'s resolution mechanism (see Rejected alternatives).

## 1. What usage looks like

```solidity
import { Position, PositionData } from "./codegen/tables/Position.sol";

// ── records (the most common ops) ──────────────────────────────────
PositionData memory pos = Position(player).get();
pos.x += 1;                                  // plain memory mutation
pos.name = "spawn";
Position(player).set(pos);
Position(player).remove();
someGenericFn(Position(player).record);      // the generic Record: keyTuple, tableId, raw ops

// ── fields: every accessor returns a typed field handle ────────────
int32 x = Position(player).x().get();
Position(player).x().set(10);
Position(player).waypoints().push(42);
uint256 n = Position(player).waypoints().length();
uint32 wp = Position(player).waypoints().getItem(2);
Position(player).waypoints().setItem(2, 7);  // new in v3 (#2019)

// ── user-typed fields carry their own methods (see §6) ─────────────
Account(user).status().transition(Status.Active, Status.Frozen);
Chunk(coord).vec().set(10, -3);              // packed codec: one storage write

// ── store dispatch (explicit paths) ────────────────────────────────
Position(player).get();                      // default: StoreSwitch inference — correct everywhere
Position(player).own().set(pos);          // "this contract's storage IS the store" (≈ v2 `_set`)
Position(player).own(worldAddr).get();       // declare an explicit store (scripts, periphery, cross-world)

// ── table id override (non-canonical table) ────────────────────────
Position(player).at(tableId).get();
```

Notes on the shape:

- `Position(...)` is a **free function** (not a type), so `Position(player)` is a call, not a conversion. It takes the table's typed key(s) and binds the **canonical table id**. There is deliberately no `Position(tableId)` overload — table-id override is the `.at()` modifier — so key types can never collide with `ResourceId` in overload resolution (this matters for `ResourceId`-keyed tables).
- **One model everywhere: accessors return handles, operations live on handles.** The record is a handle (`get`/`set`/`remove`); every field accessor returns a typed field handle (`get`/`set`, plus the dynamic op set for arrays/bytes/strings, plus whatever a user type's lib defines). One sentence describes the whole API, and there is never a second spelling for the same operation.
- Value sugar (`x()` returning `int32`, `x(10)` setting) was prototyped and rejected: Solidity cannot overload on return type, so sugar _displaces_ the handle — and user-typed static fields (enum `transition`, packed-vector `set(x, y)`, wrapped ids) need the handle as their method attachment point. Sugar saved ~25–40 gas of struct allocation (likely optimizer-elided anyway) at the cost of the §6 extension story and a primitive-vs-custom API split. See Rejected alternatives.
- The decoded record struct is plain and mutable in memory; persisting is always an explicit `set`. There is no bound "draft"/snapshot object (considered and dropped — see Rejected alternatives).

## 2. Infra changes (`packages/store`)

### New shared Solidity (written or generated once, framework-wide)

| Component                                     | Contents                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Record.sol`                                  | `struct Record { ResourceId tableId; bytes32[] keyTuple; FieldLayout fieldLayout; address store; }` + `RecordLib` (`remove`, `raw` get/set, hook helpers). Table-agnostic; embedded in every table's record handle. Carrying `fieldLayout` (set from the table constant at entry; zero → `RecordLib` lazy-loads) gives generic `Record` ops full gas parity with typed paths — `record.remove()` and the table's `remove()` are the same call, the typed one a pure delegation; that's the deliberate seam between the typed layer (app code) and the generic layer (infra code). Deliberately **no `exists()`**: MUD has no existence bit — deletion zeroes storage, so an all-default record is indistinguishable onchain from a never-set one, and any storage-based check false-negatives on legitimately zero-valued records (e.g. a table of `false` booleans). Existence is an app-level convention (sentinel field, as in DUST's `EntityObjectType != 0`) or an offchain fact (indexers track set/delete events). |
| Static field handles, one per static ABI type | e.g. `Int32Field { Record record; uint8 index; }` + `Int32FieldLib`: `get`, `set` (layout read from `record.fieldLayout`). Contains the **only** copy of the per-type cast (`int32(uint32(bytes4(blob)))`) and encode (`abi.encodePacked`). The handle struct (~2 words) is the attachment point for user-type wrappers and traits.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| Dynamic field handles, one per element type   | e.g. `Uint32ArrayField { Record record; uint8 dynamicIndex; }` + `Uint32ArrayFieldLib`: `get`, `set`, `length`, `getItem`, `push`, `pop`, `update`, **`setItem`, `slice`, `splice`** (#2019). `BytesField`, `StringField` likewise.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| Store dispatch (inside the field/record libs) | Branch on `record.store`: `0` → `StoreSwitch` (unchanged, SLOAD inference), `address(this)` → `StoreCore` internal, else → `IStore(store)` external. This is `StoreSwitch`'s existing branch with the SLOAD made skippable when pinned.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |

These libs are enumerable from `SchemaType` and can themselves be generated — but generated **once into the framework package**, not per project. Unused internal functions are never compiled into user contracts, so breadth is free.

### Unchanged

`StoreCore`, `StoreSwitch`, `IStore*`, `Schema`, `FieldLayout`, `EncodedLengths`, `Bytes`, `Slice`, `Storage`, `Memory`, tightcoder. Storage layout, events, and registration are untouched.

### Codegen changes (`packages/store/ts/codegen`)

- `field.ts` accessor-body rendering (cast tables, encode selection, store-variant and suffix multiplication) is deleted; replaced by emitting thin handle constructors.
- `renderTable.ts` emits the manifest described in §3.
- Config (`ts/config/v2`): `userTypes` entries gain optional `field` (handle type name, default `${name}Field`) and `keyColumns` (see §6). Existing configs remain valid.
- Unused-in-practice public surface (`encodeStatic`/`encode`/`encodeKeyTuple`/schema getters as generated externs) moves out of the default per-table output (kept available via shared libs / an opt-in codegen flag).

### World layer

- Systems, `WorldConsumer`, hooks: API-compatible usage; they consume the same handles. The world package may ship a trait alias (e.g. `root()` → `own()`) as world-flavored sugar — see §7.
- `renderWithStore` / store-argument variants disappear from world codegen the same way.

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
import { Record, RecordLib } from "@latticexyz/store/src/Record.sol";
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
using PositionRecordLib for PositionRecord global;

ResourceId constant _TABLE_ID = ResourceId.wrap(0x...);
FieldLayout constant _FIELD_LAYOUT = FieldLayout.wrap(0x...);
Schema constant _KEY_SCHEMA = Schema.wrap(0x...);
Schema constant _VALUE_SCHEMA = Schema.wrap(0x...);

/// Entry point: typed key in, record handle out, canonical table id bound.
/// This is the ONLY place the key schema is encoded.
function Position(address player) pure returns (PositionRecord memory r) {
  r.record.tableId = _TABLE_ID;
  r.record.fieldLayout = _FIELD_LAYOUT;
  r.record.keyTuple = new bytes32[](1);
  r.record.keyTuple[0] = bytes32(uint256(uint160(player)));
}

library PositionRecordLib {
  // ── modifiers (chainable, one line each) ──
  function at(PositionRecord memory self, ResourceId tableId) internal pure returns (PositionRecord memory);
  function own(PositionRecord memory self) internal view returns (PositionRecord memory);            // = own(address(this))
  function own(PositionRecord memory self, address store) internal pure returns (PositionRecord memory);

  // ── field handle constructors (one line each) ──
  function x(PositionRecord memory self) internal pure returns (Int32Field memory);                  // index 0
  function y(PositionRecord memory self) internal pure returns (Int32Field memory);                  // index 1
  function name(PositionRecord memory self) internal pure returns (StringField memory);              // dynamic 0
  function waypoints(PositionRecord memory self) internal pure returns (Uint32ArrayField memory);    // dynamic 1

  // ── record ops (thin delegations to RecordLib + the codec below) ──
  function get(PositionRecord memory self) internal view returns (PositionData memory);
  function set(PositionRecord memory self, PositionData memory data) internal;
  function remove(PositionRecord memory self) internal;

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

- **Solidity overloading absorbs most of it** (verified empirically): attached methods disambiguate by parameter list, so fields named `set` or `on` coexist with `set(self, data)`, `at(self, tableId)`. Field accessors are all no-arg handle constructors, so only **no-argument** framework methods reserve names. (Collision detection should still key on `(name, parameter types)` for future-proofing.)
- **Field-handle methods never constrain field names**: `get`/`set`/`length`/`push`/`setItem`/trait methods live on framework types (`Int32Field`, `Uint32ArrayField`, …), not in the field-name namespace.
- **Rare/meta operations live on the `record` member**, not as top-level methods: `raw`, `keyTuple`, `tableId`, `store` are reached via `Position(player).record.…` and reserve nothing (only the member name itself — a method sharing a struct member's name is a hard compile error, also verified).

Residual reserved set: **`get`, `remove`, `own`, `record`** — kept top-level because record get/set/remove are 65% of real-world usage (DUST) and must stay unprefixed. (`remove` is a verb and field names are nouns; no collision observed across DUST's ~100 field names, and the rename rule backstops.)

Independently of this design, bare field accessors inherit a constraint v2's `getX` prefixes hid: a field named after a **Solidity keyword** (`type`, …) cannot be a method name at all. So a rename rule is required regardless, and reserved words ride the same mechanism:

- Codegen detects collisions (reserved set + keywords) and emits a deterministic trailing-underscore accessor (`type` → `.type_()`, `get` → `.get_()`) with a build warning — trailing underscore is the Solidity style guide's own collision convention. A per-field config override (`codegen: { methodName: "..." }`) allows choosing a better name.
- Overload-legal-but-confusing names (a field named `set`) are allowed; lint-level warning at codegen time.
- Validation across DUST's 40+ tables (~100 distinct field/key names, including `value`, `name`, `data`, `key`, `root`, `index`): **zero** collisions with the reserved set.

The zero-reserved alternative — nesting all field accessors behind a hop (`Position(player).fields().x()`) — was considered and dropped: it taxes 30% of all calls with an extra hop and still doesn't eliminate the keyword problem, so it buys no rule simplification.

The shared field lib it delegates to (for reference; lives once in `packages/store`):

```solidity
struct Int32Field {
  Record record;
  uint8 index;
}
using Int32FieldLib for Int32Field global;

library Int32FieldLib {
  function get(Int32Field memory self) internal view returns (int32) {
    bytes32 blob = StoreAccess.getStaticField(self.record, self.index);
    return int32(uint32(bytes4(blob))); // the cast: once per ABI type, framework-wide
  }
  function set(Int32Field memory self, int32 value) internal {
    StoreAccess.setStaticField(self.record, self.index, abi.encodePacked(value));
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
- User types can define **key codecs** mapping one Solidity value ↔ N typed columns (§6). The motivating case is DUST's `Vec3` (one `uint96` ↔ three `int32` columns, kept separate for per-axis offchain queryability).

## 6. User types: bring-your-own field and key codecs

Inversion of responsibility: today codegen _understands_ user types (renders `wrap`/`unwrap` inline); in v3 a user type **ships its own handle**, and codegen only constructs it. The contract between codegen and the type is structural: the handle struct wraps the primitive field handle for its declared storage type.

```ts
userTypes: {
  EntityId: { type: "bytes32", filePath: "./src/types/EntityId.sol" },          // scalar: nothing else needed
  Vec3: {
    type: "uint96",
    filePath: "./src/types/Vec3.sol",
    keyColumns: { x: "int32", y: "int32", z: "int32" },                          // key codec shape (optional)
  },
}
```

```solidity
// src/types/EntityId.sol — plain Solidity, no codegen involvement
type EntityId is bytes32;

struct EntityIdField {
  Bytes32Field inner;
}
using EntityIdFieldLib for EntityIdField global;

library EntityIdFieldLib {
  function get(EntityIdField memory self) internal view returns (EntityId) {
    return EntityId.wrap(self.inner.get());
  }
  function set(EntityIdField memory self, EntityId value) internal {
    self.inner.set(EntityId.unwrap(value));
  }
}

// Key codec convention (only needed when keyColumns is declared):
library Vec3KeyCodec {
  function encodeKey(Vec3 v, bytes32[] memory keyTuple, uint256 offset) internal pure;
  function decodeKey(bytes32[] memory keyTuple, uint256 offset) internal pure returns (Vec3);
}
```

Codegen's involvement is one import and one constructor call per field (`return EntityIdField(Bytes32Field(self.record, 0));`), plus calling the key codec inside the table entry function. It never sees the codec logic.

### Enums, end to end

Enums declared in config get the same treatment: codegen emits the enum and its (mechanical) field handle once per enum, and domain logic lands as a user trait — no codegen involvement past the handle.

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
using StatusFieldLib for StatusField global;

library StatusFieldLib {
  function get(StatusField memory self) internal view returns (Status) {
    return Status(self.inner.get());
  }
  function set(StatusField memory self, Status value) internal {
    self.inner.set(uint8(value));
  }
}
```

```solidity
// user code — domain logic attached without touching codegen
library StatusTrait {
  error InvalidTransition(Status expected, Status actual);

  function transition(StatusField memory self, Status from, Status to) internal {
    Status current = self.get();
    if (current != from) revert InvalidTransition(from, current);
    self.set(to);
  }
}
using StatusTrait for StatusField;

Status status = Account(user).status().get(); // typed, not uint8
Account(user).status().transition(Status.Active, Status.Frozen);
```

The handle is what v2 enums lack: today an enum field is a `uint8` with a cast in the generated getter, and there is nowhere to hang `transition` — it ends up as a free function per table or copy-pasted requires. Here it's written once against `StatusField` and works on every `Status`-typed field in every table.

This removes the current limitations wholesale, because the codec is open code instead of generator logic:

- **Enums become real types** — a `StatusField` lib can expose `transition(from, to)`, not just a bare `uint8` wrap (full example above).
- **Custom packings** — `type PackedVec2 is uint64` with `getX()/getY()/set(x, y)` over one storage primitive.
- **Nesting** — `type ChunkId is EntityId`-style layering is ordinary struct composition; config only needs the ultimate primitive.
- **Lossy key codecs** are a legitimate explicit choice (e.g. a `bytes32`-keyed name table using `keccak(name)`), documented as indexer-lossy.
- **It's a package ecosystem**: a type + its field lib + key codec + traits ship as one Solidity file; installing is an import plus a config entry. `Vec3Storage.sol` stops needing to exist.

The struct-field seam: in `PositionData`, a user-typed field is the bare UDVT; the generated record codec uses the UDVT's free `wrap`/`unwrap`. Rich codecs apply at _field-handle_ level; record-level decode hands you the UDVT to use its own accessors.

## 7. Extensibility without touching codegen

Because handles are ordinary types, behavior accretes in libraries:

**Shared-lib growth (framework PRs, zero regeneration).** Adding `setItem`/`slice`/`splice` to `Uint32ArrayFieldLib` lights up every array field in every table ever generated. [#2019](https://github.com/latticexyz/mud/issues/2019) collapses from "extend the generator and regenerate the ecosystem" to "add three functions to one library." Same for `RecordLib` (e.g. a future `copyTo(Record)`).

**Traits (user/third-party packs).** Plain libraries against handle types — field handles, per-table record types, and user UDVTs — attached per-file:

```solidity
library CounterTrait {
  function increment(Uint32Field memory self) internal returns (uint32) { ... }
}
library ArrayTrait {
  function appendUnique(Uint32ArrayField memory self, uint32 value) internal { ... }
}
library MoveTrait {
  function teleport(PositionRecord memory self, int32 x, int32 y) internal { ... }
}
// consumer file:
using CounterTrait for Uint32Field;
using ArrayTrait for Uint32ArrayField;
using MoveTrait for PositionRecord;
Score(player).points().increment();
Inventory(owner).slots().appendUnique(5);
Position(player).teleport(0, 0);
```

(Note: `using ... global` is reserved to the file defining the type, so framework types ship framework traits globally; third-party traits use per-file `using`. Both compose. DUST's `EntityIdLib` — methods on a key type spanning many tables — is the record/UDVT pattern.)

**Layer-appropriate aliases.** The world package can rename Store concepts for its audience without the Store API knowing about namespaces — e.g. `root()` as a world-layer trait delegating to `own()` (possible, though `own()` is layer-neutral — "my own storage" is accurate for root systems, the World, and standalone Stores alike — so no alias is needed).

**Generic tooling.** Functions over `Record` and typed field handles work across tables they've never seen — `bump(Int32Field memory, int32)` works for `Position.x`, `Health.current`, any int32 field anywhere. Schema reflection (`Schema`/`FieldLayout` are onchain) enables fully generic admin/migration code as a later, independent layer.

## 8. Gas & bytecode trade-offs

Honest accounting (estimates to be confirmed by the benchmark plan below):

- **Handle construction is memory-struct churn**: `Position(player)` allocates the `Record` + wrapper (~4–5 words) on top of the keyTuple alloc v2 already pays, and each field accessor allocates a ~2–3 word handle — together roughly 30–70 gas per accessor chain, likely less where via-IR elides non-escaping structs. Noise on writes (5k–20k+) and cold reads; a few-percent relative cost on warm reads in tight loops, mitigated by reusing handles (they're values — hoist the record or field handle when touching it repeatedly).
- **`.own()` vs v2 `_get`**: worst case ~15–20 gas (MLOAD + compares); with via-IR inlining the `EQ(ADDRESS, ADDRESS)` comparison is CSE-foldable to the bare `StoreCore` call. Verifying this fold is an explicit acceptance criterion.
- **Default path**: unchanged from v2 no-prefix methods (same `StoreSwitch` SLOAD).
- **Bytecode**: internal functions are included only when referenced and deduplicate per function — multi-table contracts shrink (one `Int32FieldLib.get` instead of N inlined casts); a single-table/single-field contract grows slightly. Trait breadth costs nothing until called. Generated _source_ shrinks dramatically (compile time, artifacts).
- **Workload-shaped benchmarks** (DUST profile): a move-loop (warm field reads ×N), an inventory scan (`length` + `getItem` ×N), record get/mutate/set, both compiler pipelines, `forge snapshot` diff against v2 output. Stretch goal: port one real DUST system.

## 9. Rejected alternatives (and why)

- **Calldata-appended world address** (context becomes `[world][sender][value]`, ~10 gas resolution): prototyped on this branch; end-to-end gas savings were minimal and often negative (per-call append cost on every world→system call outweighed per-op read savings at realistic ops-per-call). The SLOAD-based `StoreSwitch` default stays.
- **Per-package compile-time dispatch default** (`storeDispatch: "core"` swapping the meaning of the default): identical code meaning different things in different packages; rejected for clarity.
- **Typed root handles / import-flavored tables** (compile-time `StoreCore` dispatch via parallel types or parallel artifacts): exact-zero dispatch but re-creates the viral fork that made DUST duplicate its abstraction libs. Held as a measured fallback only if `.own()` benchmarks unacceptably.
- **`Position(tableId)` / `Position(tableId, key)` overloads**: collide with single-`ResourceId`-keyed tables; the canonical-id entry + `.at()` modifier avoids the collision class entirely.
- **`.x` as struct member, `f(a)(b)` currying, auto-persisting records, partial struct literals**: ruled out by Solidity semantics (member access requires materializing all fields; function types can't close over values; memory writes have no observer; struct literals are total).
- **Bound "draft"/snapshot records** (`snapshot()` with lazy load, buffered writes, dirty-bit `save()`): implementable (lazy load via memory mutation in `view` is legal; `save()` could coalesce adjacent dirty static fields into one splice), but rejected: a second generated per-table surface, dirty-bitmask branching on every access, and divergence hazards (a snapshot doesn't see external writes; two snapshots of one record don't sync). `get` → mutate → `set` plus chainable setters cover the flows.
- **Static-field value sugar** (`x()` returning `int32`, `x(value)` setting, chainable): briefly adopted on a "static op sets are closed" rationale, then reverted. Solidity can't overload on return type, so sugar displaces the handle — and user-typed static fields (enum `transition`, packed-vector codecs, wrapped ids) need the handle as their method attachment point, making static op sets open after all. The sugar saved one ~3-word allocation per access (~25–40 gas, likely optimizer-elided) and one token, at the cost of the §6 extension story and a primitive-vs-custom API split. Uniform handles won.
- **Dual path (value sugar + handles for the same field)**: rejected — two spellings for one operation means users must always ask which to use.
- **Nesting field accessors behind a member** (`.data.x()` / record ops behind `.meta`): taxes one of the two hot paths (fields 30% / record ops 56–65% of usage) for a namespace purity the rename rule already provides.

## 10. Open questions

1. Does via-IR reliably fold the dispatch branch, the record wrapper, and the field handle constructors? (Benchmark gate; determines whether typed-core handles ever need to exist.)
2. Recommended compiler posture for downstream projects (via-IR strongly encouraged?) and numbers on the legacy pipeline.
3. Arrays of user types: element-wise wrap loop vs the assembly pointer-cast trick, owned by the framework-provided array-wrapper template.
4. Record-handle packing: `keyTuple` as `bytes32[]` is flexible but allocation-heavy; is a fixed-size/inline encoding worth it for 1-key tables (the overwhelmingly common case)?
5. Naming (resolved). Record deletion: `remove()` — `delete` is a Solidity keyword and thus impossible, `del` is an abbreviation, `remove` is ecosystem-idiomatic; `clear()` noted as the semantically precise alternative since deletion zeroes rather than removes existence. Table-id override: `at(tableId)` — `in` is a reserved keyword; `at` is unambiguous since keys bind at the entry function. Store owner: `own()` / `own(addr)` — one declarative concept, two arities; `local`/`core`/`via` superseded. Meta member: `record` — names its own type (`Record record;`, matching the field-handle convention), reads naturally (`.record.keyTuple`), and avoids `base`, a plausible game field name; a field named `record` falls under the standard rename rule. (`exists()` was cut from `RecordLib` entirely: no existence bit exists onchain, so any storage-based check is a footgun — see §2.)
6. Migration story: codemod for v2 call sites (`Table.getX(k)` → `Table(k).x().get()`, `Table._set(k, v)` → `Table(k).own().set(v)`), and whether a v2-compat shim layer is worth generating during transition.
7. Offchain-table ergonomics: setter-only manifest variant?
