# AGENTS.md

## Background

In this environment, the game Factorio will be used as an evaluation of your capabilities.

## Objective

Read `TASK.md` and complete the objective in the running Factorio game as quickly as possible. **Your primary evaluation is how little active wall-clock time you take to complete the game objective.** Time spent thinking, inspecting, writing scripts, and executing actions all counts while the run is active; quota pauses and game loading do not.

Prioritize useful in-game progress and the critical path to the objective. Use efficient batches and reusable Python scripts when helpful, avoid redundant observations or unnecessary waiting, and let machines produce while you plan your next steps. Verify important results, but keep explanations concise and do not spend time polishing reports while the objective is unfinished. Do not stop until the objective is actually complete. Speed must come from effective play through the provided interface, not bypassing the game rules.

## Available interface

- Use `factorio.py` to observe and act in the game.
- It is both a command-line program and an importable Python module.
- The default manager address is `http://localhost:3000`.
- If provided, `FACTORIO_API_BASE` overrides the manager address.
- Run `python factorio.py --help` on Windows, or `python3 factorio.py --help` on
  macOS/Linux, plus command-specific help when needed.
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
- Use condition waits (`wait_for_item`, `wait_for_research`, `wait_for_factory`,
  `wait_until`) instead of fixed sleeps. Sleep only when no game condition can
  change.
- Prefer electric automation once power is stable; keep burner inserters and
  drills fuelled automatically until then.
- Verify automation with `observe-layout`, `observe-factory`, and production
  rates. A chest of materials is not proof that a line runs.
- Treat "I will refuel/collect it later" as a design failure: if it needs
  periodic attention, automate it now or leave it out.
- Emergency manual action is allowed only to restore power/coal; immediately
  replace the manual step with an automated one.


- You may only interact with the game through the provided Python library. Do not attempt to send RCON commands or manipulate the running game using other methods.
- Inspect the current player, inventory, world, resources, and relevant entity
  prototypes before committing to a substantial build.
- Prefer importing `FactorioClient` in a Python script for multi-step plans.
- Treat action results as authoritative. Check `action_job_ok()` and inspect
  individual results because a completed batch may contain partial failures.
- For any flow that would need repeated insert/extract (coal, ore, plates, science),
  build belts with `build_belt_line()` / `act-build-belt` and connect machines with
  `build_loader()` / `act-build-loader` (endpoints exactly two tiles apart on one
  axis). Chests are buffers, not transport.
- Never sleep for production; use `wait_for_item`, `wait_for_research`,
  `wait_for_factory`, or `wait_until` so work resumes the moment a condition is met.
- Use `observe-layout` for a compact ASCII map of the current base (rows are
  north-to-south, one character per tile/step). `rows` is a composite layer
  (actor > built > natural > resource > terrain); `built_rows` and
  `resource_rows` preserve entities hidden underneath, and `overlaps` lists
  cells with more than one layer. Use it to plan belt lines and spot gaps.
- Use `observe-factory` to check power, fuel, and blocked-building status counts
  before committing to more machines; fix `no_fuel`, `no_power`, and
  `waiting_for_space_in_destination` before expanding.
- Use placement observations before constructing tightly packed layouts.
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
