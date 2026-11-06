# Design cookbook (agent recipes)

Proven layouts and recovery patterns for the autorio Factorio API. Read this after `AGENTS.md`
and before planning any build. Everything here uses the manager's build API
(`build(entities)` / `act-build`, batch limit 50 entities per job, `clear=True` by default,
anchor = integer top-left tile, direction `0=N, 4=E, 8=S, 12=W`).

## 1. Build workflow (do this every time)

1. `observe-player` (inventory + position), `observe-factory` (alerts/power/fuel), and
   `observe-layout` around the proposed area.
2. Write the exact entity list (name + anchor + direction) and the required items.
3. Dry-run first: `observe-placement` with the whole list; fix blockers/out-of-reach entries.
4. `build(entities, clear=True)` in chunks of <= 50; check every result's `ok` and `clearing`.
5. Verify with `observe-factory` (status/`alerts`), `observe-connections` (dead belts,
   inserter source/target), and production rates (`observe-production` / `observe-snapshot` when
   available). Only then expand.
6. Leave 2 tiles of empty space between blocks; future expansion is cheaper than rebuilding.

## 2. Bootstrap without power (burner era)

- Put a `burner-mining-drill` directly on an ore tile (anchor = top-left; drills are 2x2,
  so anchor x/y must be even for a 2x2 footprint).
- Feed it with `insert(coal)` or hand-feed; output goes to the tile in front of the drill.
- A `stone-furnace` (2x2) placed at the drill output picks the ore up only if an `inserter` or a
  belt sits between them — place drill -> inserter -> furnace, or drill -> belt -> furnace.
- First automation goal: burner drill + stone furnace + iron chest, then replace with electric
  drills fed by coal/steam power.
- No coal nearby? Use `observe-resources` for the nearest patch and extend belts before crafting
  more machines.

## 3. Miner -> belt -> furnace -> belt -> chest

Belt direction = the direction items move. A compact smelting row:

```text
[drill 2x2] -> [belt east] -> [furnace 2x2] -> [belt east] -> [chest]
```

- Belt anchors are single tiles; `build_belt_line(from, to)` builds a straight line
  (auto direction), or place `transport-belt` tiles with explicit directions.
- Long or obstructed runs: `build_underground_belt_line(from, to, name=...)` emits
  input/output `underground-belt` pairs (subtypes handled by the manager) with surface
  connector tiles between pairs; tiers span 4/6/8 tiles (yellow/red/blue). Straight
  axis-aligned lines only — chain two calls around corners.
- Insertion is not needed between belt ends and machines: a belt pointing into a furnace feeds
  it; a belt under the furnace output picks the plate up.
- Furnace output tile is the tile in front (direction) of the furnace; leave it empty.
- Electric furnaces/assemblers need power + inserters, so plan the power block first.

## 4. Power block (steam)

```text
[offshore-pump] -> [pipe] -> [boiler] -> [steam-engine]
```

- Place the pump on water (`observe-world` shows water tiles as `~` in layout); pump output is
  the tile in front of it.
- Boiler and steam engine are 3x5/5x3 (anchor = top-left; use `observe-entity-prototype` when
  unsure). Pipe water into the boiler's input, engine next to the boiler output.
- Typical ratio (verify with `observe-factory.power`): 1 offshore pump : 20 boilers : 40 steam
  engines; start with 1:1:2 for 900 kW-class demand.
- **Pole choice matters**:
  - small pole: 5×5 supply, 7.5 wire reach — local coverage only;
  - medium pole: 5×5 supply, 9 wire reach — local coverage with longer wires;
  - substation: 18×18 supply, 18 wire reach — best for large machine blocks;
  - big pole: only 4×4 supply but 30 wire reach — use for straight transmission trunks, never as a dense coverage grid.
- Use `build-power-network --pole substation` for an aligned local coverage grid, or
  `build-power-line --from x,y --to x,y --pole big-electric-pole` for a straight trunk.
  Keep rows/columns aligned; do not hand-place a pole beside every machine.
- Check `power.satisfaction` (must stay ~1.0) and `observe-factory` for `no_power`.
- Add a chest of coal next to boilers and an inserter to feed them automatically.

## 5. Assembler + inserter pattern (the core unit)

For every production block:

```text
[chest/belt input] -> [inserter ->] [assembling-machine 3x3] [-> inserter] -> [belt/chest output]
```

- Assembler anchor = top-left tile; `set_recipe(target, recipe)` after building.
- Inserter direction points from source to target. `build_loader(source, target)` places one
  inserter between two positions.
- Recipe/ingredient checks: `observe-recipes` + `observe-entity` on the assembler to confirm
  `recipe` and `status` (`no_ingredients`, `no_power`, `waiting_for_space_in_destination`).
- Buffer chests: output chest + inserter prevents backing up the assembler; input chest lets
  you batch-feed instead of hand-feeding every cycle.

## 6. Green science line (starter factory)

Goal: steady `automation-science-pack` + `logistic-science-pack` into a lab.

- Iron smelting row (section 3) producing `iron-plate`; a second row for copper.
- Gears: assembler with `iron-gear-wheel` (2 iron plates -> 1 gear), output into a chest.
- Belts: assembler `transport-belt` (1 gear + 1 iron plate -> 2 belts).
- Green science: assembler `logistic-science-pack` (1 belt + 1 inserter -> 2 packs).
- Inserters: assembler `inserter` (1 gear + 1 iron plate + 1 electronic circuit).
- Circuits: assembler `electronic-circuit` (1 iron plate + 3 copper cable), cable assembler
  (1 copper plate -> 2 cable).
- Labs: `lab` (3x3) fed by inserter from a chest or belt; `observe-research` shows current tech.
- Rough target: 2 furnaces per science assembler; add belts/inserters between every machine —
  never hand-feed once an assembler exists.

## 7. Oil (when crude oil is found)

- `pumpjack` (3x3) on `crude-oil` tiles; pipe crude to `oil-refinery` (5x5).
- Basic oil processing yields petroleum gas in 2.x; pipe it to `chemical-plant` for
  `plastic-bar` (petroleum + coal) and later `sulfuric-acid` (for batteries/processing units).
- Pipes connect adjacent fluid boxes; use `pipe` + `build_underground_pipe_line(from, to)` to cross
  belts (input/output `pipe-to-ground` pairs with surface connectors; 10-tile spans, straight
  axis-aligned only). Verify fluid connections with `observe-connections`/`observe-entity`.
- Store surplus petroleum in `storage-tank`; measure with `observe-fluids`.

## 8. Defense (only when enemies exist)

- `gun-turret` (2x2) every ~10 tiles along the threat direction, with ammo: feed from a chest
  by inserter, or hand-insert `firearm-magazine`/`piercing-rounds-magazine`.
- Wall segments (`stone-wall`) one tile in front of turrets; leave a repair path.
- Check `observe-combat` (when available) for nests/units and turret ammo; if damage occurs,
  patch walls and add ammo before expanding further.
- Peaceful benchmark maps: score defense 0 and skip this section.

## 9. Observation checklist per subtask

| Subtask | Required observations | Done condition |
| --- | --- | --- |
| Production | `observe-factory` (alerts/status), `observe-production` rates | target item rate stable for 2 windows |
| Logistics | `observe-connections` issues, `observe-layout` | no dead belts / inserter mismatches |
| Mining | `observe-resources`, `observe-factory` (drill status/fuel) | drills working, ore rate stable |
| Research | `observe-research` (current/available), `observe-factory` (labs) | target tech queued/completed |
| Defense | `observe-combat`, `observe-factory` (turrets ammo) | no damage for 10 min |
| Exploration | `observe-map`, `observe-resources` | patch found + route recorded |

## 10. Error recovery matrix

| Symptom / error | Meaning | Fix |
| --- | --- | --- |
| `out_of_reach` | target outside build distance | `move` closer (<= 64 tiles; prefer 10-20), re-observe |
| `cannot_build` | collision or player overlap | clear footprint, retry; if still blocked move 1-2 tiles away |
| `blocked` / `no_path` | walking blocked | run `path-preview`; water/cliffs are impassable — route around with waypoints instead of retrying the same goal; clear trees/rocks only for local blockers |
| `no_resource` / `no_entity` | target tile empty/wrong kind | re-observe, correct coordinates (anchor vs center) |
| `no_ingredients` | assembler input starvation | add input inserter/chest/belt; check recipe |
| `no_fuel` | burner machine empty | insert coal, automate with inserter+chest |
| `no_power` | not connected/satisfaction low | add poles, check boiler fuel/steam, `observe-factory.power` |
| `waiting_for_space_in_destination` | output blocked/full | add output inserter/chest, clear belt congestion |
| `missing_science_packs` | lab lacks packs | fix science production or insert packs from chest |
| `item inventory full` | build/inserter item shortage | craft/obtain item, check inventory counts |
| movement timeout / `action_timeout` | long walk or stuck | move in waypoints, clear obstacles, retry once |

## 10.4 Descriptions

- `client.describe("automation", kind="technology")` (CLI
  `describe --kind technology --name automation`) returns the localized
  technology description plus its raw LocalisedString key.
- Use `kind="entity"` for buildings/entities, e.g. `describe("assembling-machine-2")`.
  Not every base-game entity has a description; check `missing_translation`.
- Get names from `observe_research` / `observe_recipes` / factory or blueprint
  observations, then describe only the entries relevant to the current plan.

## 10.5 Map overview

- `observe_map_overview(x=..., y=..., radius=256, size=96)` (CLI
  `observe-map-overview`) returns a downsampled view of **charted** chunks with
  `.`/`~`/`#`/`*`/`@` glyphs. Use it to choose expansion direction or find water;
  it cannot reveal uncharted terrain.
- Pass `format="svg"` or `format="png"` when you need a compact picture for a
  message; the default rows are best for planning in text.

## 10.6 Entity usage and junctions

- Before building an unfamiliar machine or junction, call
  `entity-usage --name <entity>` / `client.entity_usage(name)`. It returns a
  curated behavior summary, flow direction, placement rules and common mistakes,
  plus the entity prototype metadata.
- `entity-usage-catalog` / `client.entity_usage_catalog()` returns all curated
  type/name rules in one response; use it when you need to look up several
  buildings. `entity-usage --name` returns the matching rule plus live prototype
  limits (tile size, rotation, energy, fluid boxes, placement item, health).
- **Belts are one-way**: a surface crossing is not a bidirectional output
  junction. To cross/merge flows use an underground-belt pair, a splitter, or
  side-loading; each belt still has a single flow direction.
- **Splitters** take one rear input and emit to two forward outputs. They cannot
  emit backward or exchange two inputs in both directions.
- **Underground belts** are paired input/output segments; both ends must face the
  same travel direction.
- **Inserters** pick from behind and drop in front; use two inserters for two
  directions.
- If `entity-usage` returns `source: "type_fallback"`, use
  `observe-entity-prototype`, `observe-layout` and `observe-connections` to infer
  behavior instead of assuming a bidirectional building.

## 10.7 Pipes around water and cliffs

- `build-pipe-line` is only an L-shaped plan and `build-underground-pipe` is
  straight; neither routes around a lake.
- Use `build-pipe-route --from x,y --to x,y` when terrain is unseen or a lake is
  between the endpoints. It asks the native pathfinder for a walkable route and
  converts it into connected orthogonal pipes (`--name pipe` by default).
- If the route fails with `no_path`, move the endpoint to a reachable shore /
  waypoint and build in stages. Do not keep retrying the same straight line.
- A diagonal route corner emits both orthogonal corner possibilities; a water
  corner is skipped while the other corner keeps the pipe network connected.
- After building, inspect the route with `observe-connections` or
  `observe-fluids`; fluid networks connect only through adjacent pipe tiles.

## 10.8 Belt lanes and junctions

Official rules (Factorio wiki, Belt transport system):

- Every belt tile has **2 lanes**. The lanes can carry two different item types
  side by side; a splitter filter or underground-belt trick can unmerge them.
- Belts **do not automatically sum flows** at a + crossing, a head-on meeting, or
  a surface crossing. Use side-loading, a splitter, or underground belts.
- Belts **cannot load or unload chests/machines/furnaces** by themselves. End the
  belt next to the building and put an inserter between the belt and the
  building; the same applies when taking products out.
- Side-loading a perpendicular belt feeds **one lane** of the target belt. If that
  lane is full, the side belt backs up; it does not add a second lane.
- A splitter has **2 inputs and 2 outputs**, splits 1:1, preserves lanes, supports
  input/output priority and item filters, and can merge two inputs — but the output
  is still limited by the output belt's throughput.
- Base throughput is **15/30/45 items/s** for yellow/red/blue belts. Merging two
  saturated belts into one output is a bottleneck: use parallel belts, a balancer,
  or separate outputs.
- To cross two independent flows, use an underground-belt pair or a splitter. The
  crossing itself does not exchange items or sum throughput.
- A belt corner only turns items if the corner tile is rotated to the new direction.
- Underground belts are directional pairs; they cross other flows without mixing
  (the entrance half blocks side input, the belt half accepts side input).

Practical checks before a junction:

1. `observe-entities` / `observe-connections` to see belt directions.
2. If two flows must merge, use a splitter or side-load; never rely on a crossing.
3. If two full belts must merge, expect one belt's throughput cap; add a parallel
   downstream belt or balancer instead of a single output.
4. If two item types share a belt, keep one type per lane and use a splitter filter
   to separate them if needed.

## 10.9 Unified linear builder

Use one command for every linear installation that may hit terrain:

```bash
factorio.py build-line --kind pipe|belt|wall|pole \
  --from x,y --to x,y [--name entity] [--route auto|straight] [--spacing n]
```

- `route=auto` (default) asks the native pathfinder for a walkable corridor and
  lays an orthogonal route, so lakes/cliffs are detoured instead of retried.
- `route=straight` uses the old L-shaped/straight plan; use it only when the
  corridor is known open.
- `--kind underground-pipe` and `--kind underground-belt` are straight-only;
  segment long routes at waypoints.
- `--kind pole` places poles at wire-reach intervals; `--spacing` can make it
  denser (never exceed the pole's reach).
- `--kind wall` lays one wall tile per route tile (defense lines with turrets
  still use `build-defense-line`).

Do not keep retrying a straight line into water. If `auto` returns `no_path`,
choose a reachable shore/waypoint and build the route in stages.

## 10.10 Knowledge lookup

- `factorio.py knowledge --topic inserters|pipes|trains|power|chemistry|defense|production|blueprints`
  returns concise rules, common mistakes and wiki references; `factorio.py knowledge`
  lists all topics.
- The run workspace also contains `KNOWLEDGE.md` with the same quick reference.
- Use this before designing a new system, then verify with the relevant
  `observe-*` calls; knowledge is guidance, current game state is authoritative.

## 11. Blueprint workflow

- `decode_blueprint_string(text)` / `encode_blueprint_string(dict)` for inspection.
- Batch builds use `build([{"name":"transport-belt","anchor":{"x":10,"y":20},"direction":4}])`
  or CLI `act-build --entities-json '<json>'`; `x`/`y` shorthand is accepted, but every
  entity needs a name and anchor. An empty/invalid list now errors instead of silently
  succeeding with zero placements.
- `build_blueprint(text, anchor=(x,y), dry_run=True)` returns expanded entities, placement
  diagnostics and missing items; fix those first.
- `build_blueprint(text, anchor=(x,y))` executes in <=50-entity chunks and aggregates results.
- CLI: `factorio.py blueprint-save --blueprint-file plan.txt --label "..."` (or `--blueprint <wire>`)
  and `factorio.py blueprint-list` do the same without writing a script.
- **Capture successful layouts** with `blueprint-capture --label "cell v1"` (or
  `client.capture_blueprint`). Capture only after `factory-audit` and
  `observe-connections` pass; the command stores the current player-built area in
  the run registry.
- **Use the registry before redesigning**: `blueprint-list`, then build a
  matching known-good blueprint with `build_blueprint(..., dry_run=True)`.
- **Optimize by versions**: capture v1, measure output and compare
  `entity_count`/`tile_count`/width/height; capture v2 with a new label, keep the
  better one, delete/annotate the worse. Do not rebuild the same cell from
  scratch each time.
- `save_blueprint(payload_or_text, label="...", description="...")` also stores a
  blueprint in the current run catalogue. `build_blueprint` registers what it
  builds automatically; use `list_blueprints()` to see available designs.
  Underground belt / pipe-to-ground input/output subtypes are preserved (the manager creates
  the explicit subtype and consumes the item); recipes/filters/modules still need a follow-up
  `act-set-recipe`/manual edit. Prefer proven community blueprints for smelting arrays,
  green/red science, and oil processing before inventing a layout; then adapt to resources.

## 12. Cleanup and deconstruction

- `deconstruct_area(x, y, radius, types=[...], player_only=False, dry_run=True)` first (from the
  Python client): it calls `observe-area` and returns the exact target plan. Run it with
  `dry_run=False` to remove the targets with the normal native miner (walking + real mining time,
  <=50 targets per job).
- Player-built things: `player_only=True` (default) uses the `last_user` heuristic; leave it false
  and set `types` to sweep trees/rocks (`["tree","simple-entity"]`) or ore (`["resource"]`).
- Use it to clear a build site, remove mistakes, or collect wood/stone; prefer mining a few
- Rotate in place instead of rebuilding: `rotate([{"x": x, "y": y}], direction=4)` sets the
  final facing (0/4/8/12; CLI `act-rotate --target x,y --direction 4`). One entity per call.
- Mine resources with `act-mine --resource` (safe: it only matches resources).
- Player-owned buildings are protected from accidental mining: `act-mine` returns
  `protected_building` unless you explicitly pass `--allow-buildings` (or a target
  with `allow_buildings: true`). Use this only for an intentional removal.
- For a single misplaced building use `deconstruct_area` (which opts into removal);
  for batches use its `types`/`player_only` filters.
  targets at a time near the character (long radius runs take real time and can fail per entity
  when unreachable).

## 12.1 Resource mining

- Mine a resource vein with **one target at a time**:
  `act-mine --resource --target x,y` (defaults to `--count all`) or
  `client.mine_continuous({"x": x, "y": y}, count="all", resource="iron-ore")`.
- The default keeps the character on that target until the vein depletes/its
  inventory fills; do not pass several ore targets and switch after one cycle.
- Use a positive `--count N` only when you intentionally want N extraction cycles.
- `act-mine` without `--resource` is for normal entities (trees, chests,
  buildings); it still mines one target at a time.

## 12.2 Debris and container logistics

- Crash-site spaceship debris (`crash-site-spaceship*`) is mineable; some pieces
  are containers with loot. Use `recover-debris --center-x X --center-y Y
  --radius R` to extract their contents into the player inventory and then mine
  every piece.
- Inspect a chest with `observe-container --target x,y` (or `observe-entity`);
  it returns slot/name/count stacks.
- Move contents with `container-transfer --from x,y --to x,y` (all stacks) or
  add `--item name [--count N|all]`. It transfers through the player inventory;
  a full target leaves leftovers in the player inventory.
- Normal chests are passive: use inserters or a logistics network for automated
  loading/unloading. Do not mine a loot container before extracting it.

## 12.3 Critical alerts

- Agent API responses include an `alerts` envelope. Critical alerts block
  mutating actions with `ALERTS_PENDING` once they are older than the gate grace.
- When blocked: run `alerts` / `observe-factory` to inspect the samples, fix
  power/fuel/fluid/resource causes, then `alerts --ack` and retry.
- Acknowledgements are revision-based: if the alert set changes, the gate
  re-arms. Unresolved critical alerts accrue an `alert_penalty` instead of
  restarting the agent.

## 12.4 Never idle

- Do not call `wait`, `sleep`, or long `wait_for_*`. `wait` is disabled and
  blocking waits are capped at 5 seconds (`AUTORIO_MAX_WAIT_SECONDS`).
- Maintain a **3-item next-work queue** in STATE.md / your plan. When output,
  research or a resource is not ready, immediately do the next item:
  add drills/furnaces/inserters, fix power/fuel/water, stock chests/belts, set
  recipes, expand belts, clear a future build site, craft intermediates.
- Waiting is only acceptable inside a running action job; when a wait helper
  times out, treat it as a signal to change subtask, not to retry the wait.
- At every checkpoint ask: "what can be built or fixed right now?" and do that
  before polling production again.

## 12.5 Inspecting belt and pipe contents

- `belt-contents --target x,y` (or `observe-entity`) returns `belt.lines[]` with
  the items currently on each belt lane, e.g. coal on lane 1 and ore on lane 2.
- `fluid-contents --target x,y` returns actual `fluid_contents` (name/amount)
  inside a pipe/fluid entity, plus fluid-box details.
- `observe-fluids` summarizes whole fluid networks; use `fluid-contents` when
  you need to know whether a specific pipe actually contains liquid.
- Belt contents are transient; re-check after a few seconds before concluding
  a lane is empty. Entity inventories remain under `inventories`.

## 12.6 Belt connectivity checks

- Before building a belt route, the planner validates the plan (`validate_belt_entities`):
  dead ends, head-on belts and missing inputs are rejected with coordinates.
- After building (or when auditing existing belts), run `observe-connections`.
  Check `issues` for `belt_dead_end`, `belt_opposite`/head-on,
  `belt_points_to_non_belt`, and `belt_no_input`.
- Corners: every belt tile must face the next tile; a belt at a corner that
  still faces the old direction is a dead end.
- Crossings: belts do not cross or merge by themselves. Use underground pairs
  for crossings and splitters/side-loading for merges; verify both endpoints.
- Fix invalid belt sections before extending them; do not build more belts on
  top of a disconnected line.

## 12.61 Connection audit summary

`observe-connections` now includes:

- `issue_summary.groups`: counts + examples + a fix suggestion per issue kind;
- `belt_links`: counts of straight/side_load/head_on/non_belt/dead_end links;
- `junctions`: first 40 non-straight/parallel belt tiles with coordinates;
- `map`: a compact north-up arrow grid with belt directions and issue markers,
  plus a legend. `map.rows` is capped to about 80 characters per side.
- `parallel_belts`: count of belts with same-direction neighbors (not connected).

Read the map for shape and use `issues`/`junctions` coordinates for exact fixes.

## 12.65 Belt link classification

`observe-connections` returns `next_connection` and `parallel_belts` for each belt:

- `straight`: next belt faces the same direction; both lanes continue.
- `side_load`: next belt is perpendicular; only one lane side-loads (corner/merge) —
  never assume full two-lane throughput.
- `head_on`: next belt faces back; invalid.
- `non_belt`: next tile is a machine/chest/etc; belts cannot transfer there.
- `dead_end`: no entity in the output tile.
- `parallel_belts` counts same-direction belts beside this tile. **Parallel
  side-by-side belts have no connectivity**; only the tile directly in front is
  the output target.
- At a direct cross/T, classify each arm separately; use underground pairs for
  crossings and splitters/side-loading for merges.

## 12.7 Belt three-strike rule

- Count attempts per belt section/junction. If link/connection checks still fail
  after **3 attempts**, stop adding/rotating individual tiles.
- Run `relayout-belts --center-x X --center-y Y --radius R --dry-run` to see the
  belt removal plan, then run it without `--dry-run` to recycle **all** belts in
  that area (all belt types, player-built or not).
- Re-observe the cleared area, re-plan from scratch with `build-line --kind belt`
  (prevalidated), and verify with `observe-connections` before extending.
- Never leave duplicate/broken belts and build a second copy on top. A full
  re-layout is cheaper than repeated patching.

## 12.8 Refactor audit loop

- Run `factory-audit --center-x X --center-y Y --radius R` after each build and
  at least every ~10 minutes, or when research/production stalls.
- It merges `observe-factory` problems and `observe-connections` issues into a
  prioritized `actions` list: top critical fuel/power/fluid, then blocked
  machines, then belt/inserter links, then parallel-belt warnings.
- Fix only the highest-impact action, verify with `observe-*`/`observe-connections`,
  then run the audit again. Do not start a new build while a critical action is
  unresolved.
- If the same issue/action fingerprint persists after 3 repair attempts, escalate:
  `relayout-belts` for belt regions, or deconstruct/redesign the affected
  machine block. Record the fingerprint/attempt count in STATE.md.
- A clean audit (`actions: []`) is the go-ahead to expand; otherwise optimize
  before expanding.

## 12.9 Trapped player rescue

- If pathfinding says `no_path` and the player is surrounded, run
  `factorio.py unstick` (or `client.unstick()`).
- It first tries short routes in eight directions, then mines low-value
  player-owned blockers one at a time (belts/pipes/poles/walls/gates; machines
  only as a last resort) until a route opens. Native mining only — no teleport.
- After escaping, repair the opening with a gate/walkway and record the
  enclosure problem in the refactor audit.

## 12.11 Crash debris cleanup

- Crash-site spaceship debris is neutral, so player-force-only map layers used to
  hide it. It now appears as `X` in `observe-layout` and `S` in
  `observe-map-overview`; `observe-map` symbols include it too.
- Recover it with `recover-debris --center-x X --center-y Y --radius R` (extracts
  loot first, then mines the pieces). Do not leave debris blocking walkways or
  building sites.

## 12.12 Refactor gate and big-reset warning

- The manager periodically audits factory + belt/inserter problems. When
  `invalid_count` stays >= `AUTORIO_REFACTOR_INVALID_THRESHOLD` (default 20) for
  the gate grace, it returns `REFACTOR_REQUIRED` and blocks **new build jobs**
  until the debt is cleaned. Mines/deconstruction/relayout remain allowed.
- Run `factory-audit` and fix the highest-priority action:
  - critical fuel/power/fluid first;
  - belts: `relayout-belts` for a section with many bad links;
  - isolated buildings: deconstruct or connect them.
- Re-audit after cleanup. Building is allowed again when invalid_count falls
  below the threshold.
- If the debt persists for `AUTORIO_REFACTOR_RESET_AUDITS` (default 3) audits, or
  blackouts reach 50, `big_reset_pending` is set and the UI shows a red flashing
  **ATTENTION / BIG RESET** banner. Stop expanding; prepare chests and begin the
  big-reset procedure rather than patching further.
- A failed `REFACTOR_REQUIRED` means "clean before building", not "retry build".

## 12.13 Blueprint-first expansion

- After the opening grace, the manager rejects build jobs with
  `BLUEPRINT_REQUIRED` until at least one blueprint is registered.
- Before expanding: `factory-audit`/`observe-connections`, capture a validated
  cell with `blueprint-capture --label "..."`, then retry the build.
- Reuse before redesign: `blueprint-list`, `build_blueprint(..., dry_run=True)`;
  compare versions and keep the best. The run page Blueprints count/panel shows
  every captured design.

## 12.14 Evaluating blueprint efficiency

- Static evaluation (before/after capture):
  `blueprint-evaluate --id <id>` reports entity_count, tile_count, machines,
  belts, inserters, poles, pipes, machines/100 tiles, support/machine and a
  structural score (machine density minus overhead).
- Dynamic evaluation (after building the cell):
  `blueprint-evaluate --id <id> --output iron-gear-wheel=60 --power-kw 30 --build-seconds 120`
  adds output/min, output/tile, output/machine, output/entity, output/kW and
  build-time/entity.
- Compare versions only with the same recipe/output; prefer Pareto improvements:
  same or more output with no more tiles, entities, power or invalid
  connections. A structurally denser blueprint is not automatically better if
  its throughput or power efficiency is worse.
- Capture v1, measure, capture v2, evaluate both, keep the winner, delete/rename
  the loser.

## 12.15 Local nearest-first recycling

- `deconstruct-area` now scans with `order=near` and orders targets by
  nearest-neighbor travel from the player/center, then chunks them. It does not
  run across the map for one isolated building.
- Keep recycling local:
  `deconstruct-area --center-x X --center-y Y --radius R --start x,y --max-distance 30`
  (`--max-distance` skips far targets and reports `skipped_far`).
- `--order scan` restores name/position order only for deterministic audits; do
  not use it for bulk recycling.
- Big-reset/recycle passes should use nearest order and stop when the local area
  is clear, then move to the next cluster.
- **Do not write sweep scripts with hard-coded cross-map center lists.** Re-observe
  the player, deconstruct the nearest local cluster, then select the next nearest
  cluster; never visit 10-20 fixed map coordinates in one pass.

## 12.16 Cleanup is rewarded, rebuild waits

- Cleanup deconstruction is marked `cleanup=true`: it does **not** count as
  manual resource mining and earns positive points:
  - `+5` per successfully removed invalid/obsolete player-owned entity;
  - `+10` per unit of invalid debt removed between audits.
- The build gate now blocks direct `act-build` too, not only queued build jobs.
  Rebuild only after the audit invalid count reaches the configured clean target
  (default `0`). `REFACTOR_REQUIRED` means keep cleaning.
- When `big_reset_pending` is set, stop expanding, prepare chests and start the
  reset; do not start a new production block first.

## 12.17 Refactor scope: power, pipes, rail

- Default refactor scope is `belts,power,pipes,machines`:
  - power: `no_power`, pole/network failures;
  - pipes: `no_input_fluid` and pipe/pump failures;
  - belts: dead ends/head-ons/no-input/point-to-non-belt;
  - machines: fuel/ingredients/output/inserter problems;
  - containers: empty chests/logistic chests on the map (removed as safe cleanup).
- Rail is **opt-in** only:
  `factory-audit --scope belts,power,pipes,machines,containers,rail`
  or `factory-audit --include-rail`; `deconstruct-area --scope ...,rail`.
- Empty chest cleanup is safe: `deconstruct-area --scope containers` only removes
  containers whose inventory is empty; non-empty chests are skipped and reported
  as `skipped_nonempty_containers`.
- Cleanup by scope:
  ```bash
  factorio.py deconstruct-area --center-x X --center-y Y --radius R \
    --scope belts,power,pipes,machines,containers --max-distance 30
  ```
  Wire/pipes/poles are included; do not leave broken power or fluid links as
  “unrelated” debt. Rail cleanup only when a train/rail refactor is explicitly in
  scope.
- Build gate counts the scoped debt; it stays closed until the clean target is
  reached.

## 12.18 Inserter direction

- Factorio inserter `direction` is the **pickup/facing side**; the drop tile is
  the opposite tile. To move items from A to B, point the inserter at A.
- Builders were corrected: `build-inserter-pairs --direction east` now places
  both inserters facing **west** (pickup west, drop east); mining-outpost and
  defense-line inserters were inverted the same way.
- `observe-connections` now reports `source` on the facing/pickup side and
  `target` opposite. Use it to verify; do not place inserters by assuming the
  direction is the drop side.

## 12.19 Structured pipeline perception

- Use `observe-pipeline --center-x X --center-y Y --radius R` instead of
  reconstructing flow from raw entity lists/ASCII. It returns:
  - machine nodes with recipe/status/footprint/bbox and input/output inserters;
  - belts, directed belt segments (head/tail/length), belt contents (`items`),
    pipe fluids (`fluid`), power poles with `network_id`;
  - edges (`inserter`, `belt`, `pipe`, `power_range`) and a prioritized
    `bottlenecks` list.
- Use `pipeline-audit` for only the bottleneck section when deciding what to fix.
- Maintain `LAYOUT.md` with anchors, axes, machine/pole grids, pipe corridors,
  segment head/tail, known gaps and next extension. Update it before/after layout
  changes; do not keep geometry only in context.
- For geometry: observe bbox/tile_size before placing, choose an aligned machine
  row and pole grid first, then extend belts/pipes along the corridor.
- Use `observe-free-space --center-x X --center-y Y --radius R --step 1` for
  buildable cells and the largest connected free rectangles; do not infer free
  space from a sparse ASCII layout.
- Use `geometry-check --entity name,x,y,dir ...` (or `--entities-json`) before
  building. It resolves footprints, applies east/west rotation, validates
  directions (0/4/8/12), reports overlaps and native placement blockers without
  building.
- Use `plan-route --from x,y --to x,y --kind belt|pipe|wall|power` to plan a
  corridor through observed free space (A*, no build). Inspect the `route` and
  `entities`, then pass the entities to build; `--width` keeps multi-tile
  clearance, `--spacing` controls pole spacing.

## 13. Token and time discipline

- One observation can answer many questions: `observe-factory` + `observe-layout` once, then plan.
- Need a tool signature? Run `factorio.py tools --json` / `client.tools()` first; the manifest is generated from the code.
- Check `observe-factory().plan.automation` after each subtask: manual mines/crafts are penalty points; prefer drills/furnaces/assemblers.
- Keep STATE.md fresh (`state-write` / `write_state`) at least every 5 min; stale state blocks mutating actions after 10 min.
- Dry-run placement before every multi-entity build; failures are cheaper than rebuilding.
- Batch: up to 50 entities/targets per action; chain jobs instead of one call per entity.
- Never idle; keep a 3-task backlog. `wait` is disabled and `wait_for_*` is capped at 5s; switch tasks on timeout.
- Keep `STATE.md` updated with the current subtask, score, `done_when`, and next action.
