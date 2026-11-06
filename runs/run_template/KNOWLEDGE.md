# Agent engineering knowledge

Concise rules for the systems the benchmark agent commonly breaks. Query one
topic at runtime with `factorio.py knowledge --topic <id>` or read the matching
section below.

## 1. Inserters (`inserters`)

- Pickup is behind, drop is in front; one inserter is one-way.
- Electric inserters need power; burner inserters need fuel. No power/fuel means no movement.
- Base throughput ≈ 0.83 items/s; stack size/capacity research raises it. Long-handed reach 2, normal 1.
- One inserter cannot serve two sources/destinations; use one pair per machine.
- Belts cannot load/unload chests, machines or furnaces directly; put an inserter at the boundary.
- Filter inserters control mixed belts/byproducts.

## 2. Pipes and fluids (`pipes`)

- A connected pipe network shares one fluid; never connect different fluids.
- Pumps are directional; offshore pumps need shoreline water.
- Underground pipe pairs cross obstacles; same direction, within max distance.
- Tanks buffer one fluid; full output backs up the network.
- Long/high-volume runs need pumps; pipes equalize levels but do not create infinite flow.

## 2.4 Belt connectivity

- A belt must face its next tile; a corner tile that still faces the old
  direction is a dead end.
- Belts do not cross or merge automatically. Crossings need underground pairs;
  merges need side-loading/splitters.
- `observe-connections` reports `belt_dead_end`, head-on, non-belt endpoints and
  `belt_no_input`; fix these before extending a line.

## 2.4 Belt connection audit summary

`observe-connections` returns grouped issue counts, fix suggestions, junction
samples, link-type counts and a north-up compact map (`^>v<`, + side-load,
X head-on, N non-belt, ! dead end, ? no input). Use the map for shape and the
issue coordinates for exact repairs.

## 2.4 Belt link classification

- Only the tile directly in front of a belt receives its output.
- `straight` next belt = both lanes; perpendicular = one-lane side load;
  opposite = head-on; non-belt = no transfer; parallel side-by-side = no connection.
- Judge each arm of a cross separately; crossings need underground pairs, merges
  need splitters/side-loading.

## 2.45 Belt 3-strike rule

- If a belt section fails link checks 3 times, stop patching. Use
  `relayout-belts` (dry-run first) to recycle all belts in the area, re-observe,
  re-plan, and validate before building again.

## 2.5 Belt and pipe contents

- `belt-contents --target x,y` shows items on each belt lane (`belt.lines`).
- `fluid-contents --target x,y` shows actual fluid amounts inside a pipe/entity;
  `observe-fluids` shows whole networks.

## 2.9 Refactor audit

- `factory-audit` returns prioritized actions from factory problems + belt/inserter
  links. Repair the top action, verify, re-audit; don't expand while critical.
- Three repeated attempts on the same audit fingerprint → relayout/redesign the
  affected region instead of patching again.

## 2.95 Trapped player

- `unstick` tries short paths, then mines low-value player-built blockers until a
  route opens. No teleport; repair a proper gate/walkway afterward.

## 2.97 Crash debris visibility

- Layout marks crash-site spaceship debris as `X`; map overview uses `S`.
  Recover with `recover-debris` instead of leaving wreckage on paths.

## 2.99 Refactor gate

- High invalid factory/belt debt blocks new build jobs with `REFACTOR_REQUIRED`.
  Clean via factory-audit + deconstruct/relayout, then re-audit.
- Three debt audits or 50 blackouts arm the red BIG RESET warning; prepare chests
  and reset instead of adding more buildings.

## 2.995 Blueprint gate

- No blueprint after the opening grace means build jobs return
  `BLUEPRINT_REQUIRED`. Capture a validated cell first; then reuse/iterate.

## 2.997 Blueprint efficiency

- Static: machines/tile, support/machine, entity and tile counts.
- Dynamic after building: output/min per tile/machine/entity/kW and build time.
- Compare like-for-like recipes; prefer Pareto improvements, not a single score.

## 3. Trains (`trains`)

- Rail signals divide blocks: one train per block, signal on the right of travel.
- Chain signal before a junction, normal signal after; prevents junction deadlock.
- Locomotives need fuel; wagons need inserters/pumps at a stop.
- Stops must be in a train schedule; signals alone do not create a route.
- Avoid bidirectional single track; use train limits/stackers to avoid queue deadlocks.

## 4. Power grid (`power`)

- Supply area powers machines; wire reach connects poles. Both must cover the layout.
- Small/medium: 5×5 local; substation: 18×18/18 reach; big pole: 4×4 supply, 30 reach (transmission only).
- Isolated poles power nothing; generators/accumulators/consumers must share a network.
- Steam needs water+fuel; check pump/boiler/engine fluids and inserter power.
- Keep `observe-factory.power.satisfaction` near 1.0; blackouts can stop fuel/water inserters.

## 5. Oil and chemistry (`chemistry`)

- Select the refinery/chemical-plant recipe first.
- Basic oil → petroleum; advanced adds heavy/light oil. Route each output separately.
- Plastic = petroleum+coal; sulfur = petroleum+water; acid = sulfur+water+iron plates; batteries need acid.
- Cracking: heavy→light→petroleum, consumes water, needs chemical plants.
- Never mix different fluids; a backed-up byproduct stops the refinery.

## 6. Weapons and defense (`defense`)

- Gun turrets need ammo; laser turrets need power/reserve; flamethrower needs oil+power.
- Walls block movement, gates let friendlies through; keep lines continuous with overlapping turret coverage.
- Artillery needs shells and targets distant nests, not close defense.
- Continuously supply ammo/fluid/power; repair/replace breaches.

## 7. Production optimization (`production`)

- Do not idle: keep a 3-task backlog and switch to building/fixing when a condition is not ready.
- `wait` is disabled; blocking `wait_for_*` is capped at 5s. Use observe/status instead of sleeping.

- Measure first (production/consumption/status), then fix the bottleneck.
- Belt throughput ≈ 15/30/45 items/s; two full belts into one output is a bottleneck.
- Inserter throughput matters; use fast/stack inserters or parallel inserters.
- Use correct ratios (e.g. 1 offshore pump : 20 boilers : 40 steam engines).
- Balance lanes; buffers only cover spikes; modules/beacons need more power/inputs.
- Prefer parallel lines over one overloaded line.

## 8. Containers and crash debris (`containers`)

- `observe-container --target x,y` (or `observe-entity`) shows slot/name/count stacks.
- `container-transfer --from x,y --to x,y` moves all stacks through the player inventory; use `--item`/`--count` to filter. A full target leaves leftovers in the player inventory.
- Chests need inserters or logistics to load/unload in normal production.
- Crash-site spaceship debris is mineable and some pieces contain loot. `recover-debris` extracts the loot first, then mines the pieces.
- Do not destroy a loot container before extracting its contents.

## 8.5 Critical alerts

- Every agent response carries `alerts` (critical/warning, counts, first-seen).
- Critical alerts older than the gate grace block mutating calls with
  `ALERTS_PENDING`; inspect/fix, then `alerts --ack`.
- Unresolved critical alerts accrue an `alert_penalty`; there is no restart.

## 9. Blueprints (`blueprints`)

- Capture a validated layout with `blueprint-capture`; list/reuse before designing.
- Iterate versions, compare entity/tile counts and output, keep the best; dry-run
  before building and set recipes/settings afterward.

- Create/save from a known-good layout; list with `blueprint-list`.
- `act-build-blueprint` places relative to an anchor; dry-run first and pass the top-left anchor.
- The manager expansion places entities/directions/subtypes but does NOT apply recipes/filters/modules; set them after.
- Do not stamp over existing entities; observe/clear the area first.
- Build in sections, then verify power/fluid/connection coverage.

## Quick workflow

1. `knowledge --topic <id>` for the rules.
2. `entity-usage --name <entity>` for one building's behavior/limits.
3. `observe-*` before mutating.
4. Build small, verify, then scale.
