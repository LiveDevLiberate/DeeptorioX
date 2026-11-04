# Agent capability plan (post-game interfaces)

Status: proposal, 2026-11-04. Scope: how to raise what an LLM agent can actually do inside the
running game now that the interface layer is modular (`src/http`, `src/api`, `src/agents`,
`factorio.py`, MCP, Gym) and typed end-to-end.

## 1. Current interface inventory

| Surface | Location | What exists |
| --- | --- | --- |
| HTTP JSON API (schema v2) | `src/api/*.ts`, 43 routes | 13 observations: world / map / player / research / recipes / entity / resources / factory / layout / connections / placement / entity-prototype / visual. 10 actions via the serialized job queue: build, mine, rotate, move, set-recipe, craft, insert, extract, research, launch-rocket. Server/run/save/health/rcon/manager endpoints. Actions are native-character actions (walking, reach, real mining time), serialized one-at-a-time, with per-item results and `clearing` pre-pass. |
| Python client | `factorio.py` | `FactorioClient` methods for every endpoint, condition waits (`wait_until`, `wait_for_item`, `wait_for_research`, `wait_for_factory`), `inventory_counts`, `build_belt_line`, `build_loader`, CLI with 25 commands, job polling/cancel. |
| MCP server | `src/mcp-server.ts` | 25 tools mirroring observations/actions/jobs/runs/benchmarks (hand-written list). |
| Gym env | `autorio_gym.py`, `autorio_types.py`, `autorio_trajectory.py` | `reset/step/observe/close`, 12 action types, typed observations, reward/verifier hooks, SQLite trajectory store. |
| Run playbook | `runs/run_template/AGENTS.md` | Scored six-subtask loop (production, logistics, mining, research, defense, armed exploration), automation-first rules, STATE.md cycle, time discipline, short-wait guards. |
| Observability | `src/logger.ts`, `src/health.ts` | JSONL logs, `/api/health`, request logs. |

Building blocks an agent can rely on today: charted-world RLE + ASCII layout, resource patch
summaries, factory status/bottleneck scan (statuses, fuel, power satisfaction, alerts), connection
audit (dead belts, inserter source/target mismatches), placement dry-run with blockers, native
build clearing, condition waits, batch arrays (up to 50 entities/targets per job).

## 2. Capability gaps

### A. Construction expressiveness (highest impact)
- **No blueprint support anywhere** (no string import/export, no plan expansion). Agents must
  place hundreds of entities one-by-one, so scaling stops at small manual layouts.
- No underground belts / pipes / splitters / underground-pipe pairing helpers; belt helper only
  builds straight surface belts, loader helper only one inserter.
- No power-network planning helper (pole placement/coverage), no fluid-aware routing, no
  inserter-pair helper for machine rows, no furnace/assembler chain preset.
- No material preflight for a whole plan: placement dry-run exists per entity, but there is no
  "expand plan -> required items -> conflicts -> execute" transaction.
- No copy/paste settings (assembler recipe, chest filters, inserter filters), no upgrade/replace,
  no deconstruct-area (undо mistakes require mining every entity manually).

### B. Production observability
- **No production rates outside benchmark runs.** `/api/agent/observe/factory` returns counts and
  statuses, but no per-minute production/consumption, so agents cannot verify that an automation
  actually produces and cannot find the bottleneck item.
- No fluid levels/networks, no power network graph (only aggregate satisfaction in factory scan),
  no machine input/output inventory view without one `observe-entity` call per machine.
- No enemy/combat observation (enemy nests/units/damage/turret ammo), no radar/chart coverage API
  beyond `observe-map`.

### C. Mid/late-game systems
- No trains (rails, signals, stations, schedules), no logistic bots/roboports/chest filters,
  no circuit network, no vehicles. Oil/fluids can only be built entity-by-entity; pumpjack
  layouts and pipe routing are manual.
- No defense helpers (turret lines with ammo), no repair/upkeep loop.

### D. Agent efficiency and reliability
- Many round trips: every observation is a separate RCON command; a snapshot of player+factory+
  research costs 3+ calls and seconds of latency.
- Tool definitions are duplicated across Python CLI/library, MCP and Gym; every new capability
  must be added three times.
- Playbook has rules but no **design cookbook**: proven layouts, error-recovery matrix
  (`out_of_reach`, `cannot_build`, `blocked`, `no_path`, item shortages), and observation
  checklists are re-derived by the model each run.
- No action duration estimates (walk distance/mining time) for planning; no danger signal
  (enemy proximity/attack) before moving.

## 3. Roadmap

Effort in engineer-days, parallelizable across two agents.

### P0 — next batch (≈ 7–9 days)

Implementation status (2026-11-04, current batch):
- P0-1 blueprint pipeline: **done** in the Python client (`decode_blueprint_string`,
  `encode_blueprint_string`, `expand_blueprint`, `FactorioClient.build_blueprint` with chunked
  jobs, dry-run placement and missing-items preflight, CLI `act-build-blueprint`). Server-side
  blueprint endpoint, recipes/filters/modules/quality and MCP/Gym wrappers remain follow-ups.
- P0-2 telemetry/snapshot: **done**. Server side: `src/telemetry-sampler.ts` (independent 5 s
  sampler, unref'd timer, RCON-connected gate) + `/api/agent/observe/production|fluids|combat`.
  Client side: `observe_snapshot` (player+factory+research+production with per-part errors),
  `observe_fluids/combat/area`, `wait_for_production`, `wait_for_fluid`. `recent_damage` deltas
  remain client-computed. Live-validated on a real Windows game (production rates, 85-pipe fluid
  scan, combat scan, area scan).
- P0-3 planners: **done (surface plan)** in the Python client — `plan_pipe_line`/`build_pipe_line`,
  `plan_power_network`/`build_power_network`, `plan_inserter_pairs`, `plan_mining_outpost`,
  `plan_defense_line`, plus `plan_build` dry-run placement/missing-item preflight. Underground
  belt/pipe-to-ground pairs are **deferred**: Factorio 2.1 `LuaPlayer.build_from_cursor` has no
  input/output subtype parameter, so the native build path cannot place them reliably (documented
  limitation; needs a blueprint-paste/ghost-based build path first). Planners place geometry only,
  recipes/filters follow with `act-set-recipe`.
- P0-4 area edit: **done** server-side (`/api/agent/observe/area`, copy-settings dry-run +
  synchronous reach-checked `act/copy-settings` using the verified `LuaEntity:copy_settings`
  API). Deconstruction stays client-driven (observe area -> act-mine batch).
- P0-5 cookbook: **done** (`runs/run_template/COOKBOOK.md` copied into every run workspace and
  referenced from the agent prompt/playbook).

Live validation (2026-11-04, Windows test copy, real graphical Factorio 2.1 + RCON): started the
compiled manager, hosted `clear-test.zip`, unpaused via RCON, then exercised the new endpoints on a
live save — `observe/production` returned a real 26–28-sample window/research state, `observe/fluids`
scanned 85 pipes, `observe/combat` returned the player (health 250) with no enemies/peaceful map,
`observe/area` matched 239 of 240 entities, `copy-settings` correctly refused out-of-reach pipes and
succeeded (with `removed_items`) after a native `act-move`; the Python client's `observe_snapshot`,
blueprint dry-run and planners also ran against the live manager. Manager/game shut down cleanly.
1. **Blueprint pipeline** (≈2–3 d)
   - Python: `decode_blueprint(str)` / `encode_blueprint(dict)` using stdlib `base64+zlib+json`
     (Factorio 2.x blueprint string format), `FactorioClient.build_blueprint(str, *, clear=True,
     dry_run=False)`.
   - HTTP: `POST /api/agent/act/build-blueprint` (job payload `{blueprint|entities, anchor, dry_run,
     clear_obstacles}`): expand entities with direction/tile offsets, resolve `recipes`/filters,
     preflight material + placement + reach, optionally return `plan` with required items and
     blockers, then execute ordered native builds with existing clearing/retry. Keep per-entity
     results.
   - CLI `<cmd> act-build-blueprint`, MCP tool `build_blueprint`, Gym action
     `{"type":"build_blueprint","blueprint":...}`.
   - Why: unblocks large factories; agents can leverage known designs instead of hand-placing.
2. **Aggregate snapshot + production telemetry** (≈2 d)
   - Manager-side sampler ring buffer (independent of runs): every `AUTORIO_SAMPLE_SECONDS`
     (default 5 s) read `production`/research/power counts via one RCON call and store
     `{t, production, research, power}` in memory (and optionally telemetry.jsonl).
   - `POST /api/agent/observe/snapshot`: one call -> `{tick, player, factory, research, snapshot:
     {production_per_minute, deltas, power, alerts}, charts}`.
   - `POST /api/agent/observe-productive` (rates window 1–15 min): item rates, input starvation,
     power satisfaction, blocked machines; `observe-fluids` (fluid networks/levels) and
     `observe-combat` (enemy nests/units, damage, turret ammo).
   - Python/Gym/MCP wrappers + `wait_for_production(item, rate, seconds)` condition wait.
   - Why: agents get a closed feedback loop (build → measure → fix) and stop blindly expanding.
3. **Construction & power/fluid planners** (≈2 d)
   - Client-side pure planners (return entity lists; executed via existing build/job):
     `build_underground_belt(from,to)`, `build_pipe_line(from,to)` (including underground pairs),
     `build_power_network(entities)` (pole coverage), `build_inserter_pairs(machines)`,
     `build_mining_outpost(patch, drills, output)` (drills on ore tiles + belts + chest),
     `build_defense_line(from,to,turret,ammo)`.
   - Manager `act-build` already handles clearing/reach; planners only compute coordinates and
     verify with `observe-placement` batch.
4. **Copy/deconstruct area** (≈1 d)
   - `act-copy-settings(source, targets)` (recipe/filter/splitter priority), `act-deconstruct
     {area, filters}` (native character mines player-built entities; refuse resources/character),
     `act-replace` for same-footprint upgrades.
5. **Playbook cookbook** (≈0.5 d, docs)
   - `runs/run_template/COOKBOOK.md`: (a) mining→smelt→assemble bootstrap, (b) green/red science
     line, (c) 1–5 MW power, (d) oil/plastics, (e) defense wall, (f) observation checklist and
     error-recovery matrix. Prompt references it; add a "capability upgrade" note for blueprint/
     snapshot tools.

### P1 — mid game (≈ 6–8 days)
6. Fluid/oil chain helpers (pumpjack layout, refinery/chem plant presets, tank/pipe levels).
7. Combat/defense loop: `observe-combat`, `arm-turrets(area)`, damage/repair alerts, radar charting.
8. Logistics: chest filters, splitter filters/priority, requester/provider presets; vehicle
   `drive_to` for exploration (car/tank) and automatic obstacle-aware routing.
9. Tool-registry refactor: define a single `capabilities.ts` (name, params JSON Schema, endpoint,
   description) generation for MCP + Gym + Python CLI help, so new tools are added once.
10. Capability benchmarks: green-science-line, 1 MW power, oil processing, mining outpost,
    defense wave — scored like current benchmarks, plus live selftest for new endpoints.

### P2 — late game / research (later)
11. Trains (rails/signals/stations/schedules), roboports/logistic bots, circuit network,
    multi-agent coordination, blueprint upgrade planner, Space Age planets if enabled.

## 4. Success metrics
- Tool calls and wall-clock per benchmark (target −30% on the same objective).
- New capability benchmarks pass: green science line, 1 MW power, oil, defenses.
- Agent token usage per run (log/usage already tracked) and stuck/blocked actions.
- No regression on the existing 221 Node + 59 Python tests, coverage gate >=82/78/84;
  every new endpoint gets a client + MCP + Gym wrapper and at least unit tests (pure planners)
  plus live selftest checks.

## 5. Suggested sequencing
Start with P0-1 (blueprint) + P0-2 (snapshot/telemetry) in parallel, since they are independent
and unlock the largest capability jumps; then P0-3 planners + P0-5 cookbook, then P0-4. Each batch
ships behind the normal gates (`npm run verify`, coverage, live manager smoke, benchmark run on
the Windows test copy) and gets a release bump.
