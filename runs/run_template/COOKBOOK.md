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
- Connect everything with `electric-pole` (small poles cover ~5x5 supply, 7.5 wire reach). Put
  one pole per mining/smelting block; check `power.satisfaction` (must stay ~1.0).
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
| `blocked` / `no_path` | walking blocked | observe layout, clear trees/rocks, try a different approach direction |
| `no_resource` / `no_entity` | target tile empty/wrong kind | re-observe, correct coordinates (anchor vs center) |
| `no_ingredients` | assembler input starvation | add input inserter/chest/belt; check recipe |
| `no_fuel` | burner machine empty | insert coal, automate with inserter+chest |
| `no_power` | not connected/satisfaction low | add poles, check boiler fuel/steam, `observe-factory.power` |
| `waiting_for_space_in_destination` | output blocked/full | add output inserter/chest, clear belt congestion |
| `missing_science_packs` | lab lacks packs | fix science production or insert packs from chest |
| `item inventory full` | build/inserter item shortage | craft/obtain item, check inventory counts |
| movement timeout / `action_timeout` | long walk or stuck | move in waypoints, clear obstacles, retry once |

## 11. Blueprint workflow

- `decode_blueprint_string(text)` / `encode_blueprint_string(dict)` for inspection.
- `build_blueprint(text, anchor=(x,y), dry_run=True)` returns expanded entities, placement
  diagnostics and missing items; fix those first.
- `build_blueprint(text, anchor=(x,y))` executes in <=50-entity chunks and aggregates results.
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
- Remove a single misplaced building with `mine([{"x": x, "y": y}])` (CLI `act-mine`); use
  `deconstruct_area` for batches. Manager-created entities may lack `last_user`, so pass
  `player_only=False` with explicit `types` for your own buildings.
  targets at a time near the character (long radius runs take real time and can fail per entity
  when unreachable).

## 13. Token and time discipline

- One observation can answer many questions: `observe-factory` + `observe-layout` once, then plan.
- Check `observe-factory().plan.automation` after each subtask: manual mines/crafts are penalty points; prefer drills/furnaces/assemblers.
- Dry-run placement before every multi-entity build; failures are cheaper than rebuilding.
- Batch: up to 50 entities/targets per action; chain jobs instead of one call per entity.
- Never sleep more than 10 seconds; use `wait_for_*` conditions and re-observe.
- Keep `STATE.md` updated with the current subtask, score, `done_when`, and next action.
