# AGENTS.md

## Background

In this environment, the game Factorio will be used as an evaluation of your capabilities.

## Objective

Read `TASK.md` and complete the objective in the running Factorio game as quickly as possible. **Your primary evaluation is how little active wall-clock time you take to complete the game objective.** Time spent thinking, inspecting, writing scripts, and executing actions all counts while the run is active; quota pauses and game loading do not.

Prioritize useful in-game progress and the critical path to the objective. Use efficient batches and reusable Python scripts when helpful, avoid redundant observations or unnecessary waiting, and let machines produce while you plan your next steps. Verify important results, but keep explanations concise and do not spend time polishing reports while the objective is unfinished. Do not stop until the objective is actually complete. Speed must come from effective play through the provided interface, not bypassing the game rules.

Before building more than a single machine, read `COOKBOOK.md` in this workspace: it contains proven layouts (mining/smelting rows, power block, assembler patterns, green science, oil, defense), per-subtask observation checklists, and the error-recovery matrix. Reuse those patterns instead of re-deriving them.

## Core subtask loop

The game reduces to six repeating subtasks. Do not wander: score them, choose
one, define a measurable finish line, execute with automation, verify, re-score.

### Subtasks and finish lines

| Subtask | Start when | Finish when | Measure |
| --- | --- | --- | --- |
| Existing line optimization | machines idle, blocked, starved, or below target rate | target output sustained for 3 minutes with no `no_power`/`no_fuel` and no blocked machines | output/min, idle/blocked counts |
| Logistics optimization | manual transfer needed, belt/inserter gap, or a chest buffer is the only link | the item reaches its destination continuously for 3 minutes without agent intervention | manual transfers = 0, throughput, belt coverage |
| New mine | ore patch depleted, ore stock falling, or a new resource is required | drills are placed, fuelled/powered, output linked, and `N` ore/min is delivered for 3 minutes | ore/min, remaining ore, delivery |
| Research optimization | labs idle, science packs missing, current tech ETA too high | current tech completes or the queue is healthy, labs run continuously, and pack supply meets demand for 3 minutes | science/min, ETA, missing packs |
| Base defense | enemies or damage exist (skip on peaceful benchmark maps; score 0) | perimeter is covered, ammo/repair is automated, and no damage occurs for 10 minutes | coverage, damage, ammo |
| Armed exploration | no higher-priority subtask scores above ~45, the base is stable, and map/resource coverage is incomplete; a required resource is missing | target area is charted, resource patches/threats/routes are recorded in `RESOURCES.md`/`MAP.md`, and you return with safe health/ammo | new chunks, patches found, threats marked/cleared, distance, health/ammo |

A finish line is always quantified and time-based. "Looks good" is not done.
Timebox each subtask (usually 10-20 minutes); if it is not done at the timebox,
re-score instead of polishing forever.

### Armed exploration (idle-time subtask)

Exploration is the fallback when nothing important is blocked, and the emergency
tool when a hard resource is missing (oil for blue science, uranium, a fresh ore
patch). It is not random wandering.

- Only start when the base is stable (no `no_fuel`/`no_power` alerts), a
  maintenance loop is running, and no other subtask scores above ~45.
- Go armed: weapon, ammo, armor, repair packs, and enough fuel/food for the
  trip. If enemies are present, do not explore unarmed. Retreat when health or
  ammo is low; mark strong nests instead of feeding the base to them.
- Search with a plan: use radar and `observe-map`/`observe-resources`, then sweep
  expanding arcs or parallel lines through uncharted chunks. Do not re-walk
  charted corridors.
- Record every find in `RESOURCES.md` (type, center, amount, distance, route) and
  threats/coverage in `MAP.md`.
- Stop at the timebox, when the target resource is found, when a route/outpost
  site is identified, or when health/ammo makes continuing unsafe. Return,
  refuel, and hand off to the **New mine** subtask.
- Exploration is a low score by default; it rises when a required resource is
  missing. A missing hard prerequisite (for example crude oil) is an emergency
  override, not idle exploration.


### Scoring

Score every subtask 0-100 before choosing and after finishing:

- `impact` 0-40: how directly it advances the rocket/science critical path
- `urgency` 0-30: no power/fuel, missing hard resource, ore depletion, blocked output, attacks
- `payoff` 0-20: how soon it unblocks other production
- `effort` 0-10 penalty: long walking, scarce materials, risky layout

`score = impact + urgency + payoff - effort`

Emergency override: zero power/fuel, damage/attack, or a stuck agent is handled
immediately, regardless of score. Use `observe-factory` alerts/totals,
`observe-layout`, `observe-research`, and `inventory_counts()` as evidence.
Record scores and reasons in `STATE.md`.

### The loop

1. Snapshot: `observe-factory`, `observe-layout`, `observe-research`, inventory.
2. Score all six subtasks and write the numbers and reasons in `STATE.md`.
3. Pick the highest score; if two are within 10 points, prefer the one on the
   rocket/science critical path.
4. Write the current subtask, score, quantified `done_when`, timebox, and first
   action in `STATE.md`.
5. Execute automation-first, in batches; never one entity per model turn.
6. Verify with observations. If `done_when` is met, mark it done and re-score.
7. If the timebox expires, re-score and switch. If an emergency appears, switch
   immediately.
8. Keep the factory running while planning; never idle on waits. Maintain a
   3-item work queue and switch to the next build/fix task when a condition is
   not ready.

Do not switch subtasks mid-task without an emergency or an expired timebox.
Update `STATE.md` after every subtask so a resumed session can continue.

### Automation score

The manager computes an operator-visible automation score from game telemetry and
your action jobs. Read it after every subtask from
`observe_factory()["plan"]["automation"]` (fields: `score`, `positive`,
`penalty`, `manual_mines`, `manual_crafts`, `breakdown`); `act-mine` and
`act-craft` responses include the current block too.

- Positive: weighted cumulative automated output since the baseline, science-pack
  output, satisfied power demand, current-research progress, and rocket launches.
- Penalty: every hand-mined natural resource unit (1 point) and every
  hand-crafted item (2 points). Removing/deconstructing placed buildings is not a
  penalty; mining trees/rocks/ores by hand is.

Automate extraction and crafting with drills, furnaces, assemblers and inserters;
hand work lowers the score and wastes active play time. The score is feedback,
not a hard failure condition.

### STATE.md update deadline

`STATE.md` is the operator plan and is enforced by the manager:

- Write it before your first gameplay action (`client.write_state(...)` or
  `state-write --current ...`); the API renders the canonical markdown.
- Refresh it at least every 5 minutes and whenever the current subtask or its
  done-when condition changes. `state-show` / `GET /api/agent/state` returns
  `age_seconds`, `due` and `blocked`.
- After 10 minutes (600 s) the manager refuses mutating action jobs with
  `409 STATE_UPDATE_REQUIRED`; observations remain available. Update STATE.md
  through the API and continue. The same rules apply after a resume.
- `act-mine` / `act-craft` responses and `observe_factory()` include the current
  `state` block, so check it before long work.


### STATE.md template

```md
# STATE
Updated: <time>
Objective: rocket
Scores: production 40, logistics 35, mining 60, research 50, defense 0, exploration 25
Current: mining (score 60)
Done when: 2 coal drills fuelled, coal delivered to boiler chests, 60 coal/min sustained 3 min
Timebox: 15 min
Progress: <measured values>
Next candidate: research (50) or armed exploration (25) when idle
```


### Fixing layouts: rotate and remove

- You may rotate, mine or deconstruct your own buildings; never build around a wrong layout.
- `rotate([{"x": x, "y": y}], direction=4)` sets the final facing (0=north, 4=east,
  8=south, 12=west) in one call; CLI: `act-rotate --target x,y --direction 4`. Without
  `direction` it turns the first entity under the tile by one step (90°).
- `mine([{"x": x, "y": y}])` / CLI `act-mine` removes one entity or resource with the
  normal native miner. `deconstruct_area(x, y, radius, player_only=False, types=[...],
  dry_run=True)` plans and removes batches; always dry-run a larger cleanup first.
- `player_only=True` matches entities with `last_user`, which manager-created buildings
  may not have; pass `player_only=False` with explicit `types` when cleaning up your own
  builds.
- Re-observe after repairs (entity status, belt/pipe direction, power) before continuing.
  Rotating or reusing an entity is cheaper and faster than rebuilding it.


## Available interface

- Follow the output language requested by the run prompt for every message and
  reasoning summary; keep code, commands, paths and identifiers unchanged.
- Before each script or action batch, start the reasoning with a compact goal:
  Chinese 5–6 characters or English 5–6 words, prefixed `目标:` or `Goal:`
  (`目标：修复铜矿供电`). The UI uses that line as the collapsed thought label.
- Use `factorio.py` to observe and act in the game.
- It is both a command-line program and an importable Python module.
- The default manager address is `http://localhost:3000`.
- If provided, `FACTORIO_API_BASE` overrides the manager address.
- Run `python factorio.py --help` on Windows, or `python3 factorio.py --help` on
  macOS/Linux, plus command-specific help when needed.
- **Tool discovery:** call `factorio.py tools --json` (or `client.tools()`) and read
  `manager_endpoints`, `cli_commands` and `client_methods` before inventing a
  command. The manifest is generated from `factorio.py` + `src/api/agent.ts`, so
  it lists current signatures, parameters and usage; do not read source files to
  discover the interface. `factorio.py tools --local` works without a manager.
- For rocket objectives, inspect a silo with `observe_entity`, then call
  `launch_rocket([{"x": x, "y": y}])` (CLI: `act-launch-rocket --target x,y`).
  The silo's `rocket` observation includes parts, required parts, `silo_status`,
  `ready`, and the force's recorded `rockets_launched`. A successful action
  initiates launch; keep working until the game records the actual launch.

## Operating rules

### Automation first (core rule)

Automate every repeated or continuous flow. Manual transfer is only for
bootstrapping or an emergency, never for routine production.

- If you would insert/extract the same item more than **3 times**, or move items
  between two buildings, build an automated link instead: a belt + loader, or a
  direct inserter when the endpoints are exactly two tiles apart.
- A placed machine is not finished until its input feed, output removal, and
  power/fuel are connected. Do not move on with an unconnected machine.
- Make coal, ore, plate, and science flows self-sustaining. Boiler and drill fuel
  must come from chests/inserters/belts, not from the agent revisiting them.
- Run maintenance and collection as a background Python loop/script. Spend model
  turns on design and exceptions, not on one-off refuels; check the loop with
  `observe-factory` and intervene only when an alert appears.
- Batch work: one script or job should place a whole belt line, mine a list, or
  feed many machines. Do not use one model turn per entity when a loop can do it.
- Do not idle. Keep a 3-item next-work queue and do the next build/fix task when
  output/research/resources are not ready. `wait` is disabled; `wait_for_*` is
  capped at 5 seconds (`AUTORIO_MAX_WAIT_SECONDS`). If it times out, switch
  tasks instead of retrying the wait.
- Prefer electric automation once power is stable; keep burner inserters and
  drills fuelled automatically until then.
- Verify automation with `observe-layout`, `observe-factory`, and production
  rates. A chest of materials is not proof that a line runs.
- Treat "I will refuel/collect it later" as a design failure: if it needs
  periodic attention, automate it now or leave it out.
- Emergency manual action is allowed only to restore power/coal; immediately
  replace the manual step with an automated one.


- You may only interact with the game through the provided Python library. Do not attempt to send RCON commands or manipulate the running game using other methods.
- `build()` mines reachable trees and rocks that overlap the footprint before
  placing, then retries once on `cannot_build`. Check `clearing.cleared` and
  `clearing.skipped`; it never removes player buildings, cliffs, water, or
  resources. Use `clear=False` / `--no-clear` only for deliberate exceptions.
- Inspect the current player, inventory, world, resources, and relevant entity
  prototypes before committing to a substantial build.
- Prefer importing `FactorioClient` in a Python script for multi-step plans.
- `craft` waits until its products appear and fails with `not_handcraftable`,
  `output_full`, or `Insufficient ingredients` when the craft cannot run. Use
  `--no-wait`/`detach=True` only when you intentionally queue work in the background.
- Treat action results as authoritative. Check `action_job_ok()` and inspect
  individual results because a completed batch may contain partial failures.
- For any flow that would need repeated insert/extract (coal, ore, plates, science),
  build belts with `build_belt_line()` / `act-build-belt` and connect machines with
  `build_loader()` / `act-build-loader` (endpoints exactly two tiles apart on one
  axis). Chests are buffers, not transport.
- Never wait or sleep idly. `wait` is disabled and blocking `wait_for_*` calls
  are capped at 5 seconds. Use the time for the next useful task: add
  drills/furnaces/inserters, fix power/fuel/water, stock inputs, set recipes,
  expand belts, clear a future build site, or craft intermediates.
- Use `observe-layout` for a compact ASCII map of the current base (rows are
  north-to-south, one character per tile/step). `rows` is a composite layer
  (actor > built > natural > resource > terrain); `built_rows` and
  `resource_rows` preserve entities hidden underneath, and `overlaps` lists
  cells with more than one layer. Use it to plan belt lines and spot gaps.
- Use `observe-connections` to audit inserter source/target links and belt continuity;
  fix `inserter_no_source`, `inserter_no_target`, `belt_dead_end`,
  `belt_opposite`, and `machine_no_inserters` before adding more machines.
- Use `observe-factory` to check power, fuel, and blocked-building status counts
  before committing to more machines; fix `no_fuel`, `no_power`, and
  `waiting_for_space_in_destination` before expanding.
- Use placement observations before constructing tightly packed layouts.
- Never request a single move farther than ~64 tiles (the client rejects it).
  Move in waypoints. Before a long move or any unseen terrain, call
  `preview_path(x,y)` (`path-preview --target x,y`): it returns the pathfinder
  waypoints or `ok=false,error=no_path` without walking. If it reports
  `no_path`, do **not** retry the same goal — water `~` and cliffs `#` (from
  `observe-layout`) are impassable: choose a waypoint around them, bridge with
  landfill where appropriate, or pick another target. High `avoid_count` on a
  move means it was blocked; replan instead of resending it.
- `observe-factory` returns `plan.stale`; when it is stale, update `STATE.md` before acting again.
- Update `STATE.md` whenever a blocker is resolved or the current subtask changes; `observe-factory` includes the active plan and its age, and stale plans mislead the operator and the next session.
- Account for the player's actual walking path, obstacles, entity reach, and native mining time. If a valid
  placement reports `blocked`, move to an accessible side and retry only the
  failed placement.
- Verify the completed result by observing entity status and inventories over
  time. Successful placement alone does not prove that a factory works.
- Do not edit the manager bridge or restart, stop, or replace the running game
  server unless `TASK.md` explicitly asks for it.
- Do not modify `factorio.py` merely to bypass an in-game challenge.

## Completion

When the objective is working, provide a concise report of what was built or
changed, how it was verified, and any limitations that remain.
