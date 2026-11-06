# autorio architecture

Maps the internals for contributors at the `15465ed` development batch (`package.json` `0.1.0`),
including the repository tooling added on top of it. `README.md` is the user manual, `AGENTS.md` the
agent-facing summary, and `CONTRIBUTING.md` the development guide. If code and this document
disagree, the code wins; please send a correction.

## 1. What the system is

autorio is a Node/TypeScript manager that launches the full graphical Factorio game as a local
multiplayer host, exposes player/world state and actions as a JSON HTTP API, and drives an LLM agent
(OpenCode by default; Codex or the DeepSeek Harness headless profile optionally) through a benchmark
run while recording telemetry, an agent transcript, optional OBS video, and independently verified
results.

Constraints that shape the code:

- The game must be the real graphical client, not a dedicated server: native
  character walking/mining and the visible window are part of the evaluation.
- Everything runs on one machine and only on the loopback interface; the API is a
  **cooperative evaluation interface**, not a security boundary against a hostile
  agent (README "Configuration").
- Optional integrations (OBS, screenshot capture, video conversion) stay optional
  and fail cleanly; tests never need Factorio, Steam, OBS, or an agent CLI.

## 2. Process and network topology

```text
 operator / CLI / browser / MCP client           external evaluation code
        │                  │                      │
        │ HTTP             │ stdio + JSON-RPC     │ HTTP (factorio.py)
        │                  ▼                      │
        │          node dist/mcp-server.js ──HTTP─┤
        ▼                                         ▼
 ┌──────────────────────────────────────────────────────────┐
 │ manager: node dist/server.js (or tsx src/server.ts)      │
 │  src/server.ts   HTTP API, static UI, game lifecycle     │
 │  src/runs.ts     RunManager: agents, telemetry, scoring  │
 │  action job queue: serialized gameplay mutations         │
 └──────┬────────────────────────────┬──────────────────────┘
        │ RCON over TCP              │ spawn + pipes
        │ 127.0.0.1:27015            │ cwd = run workspace
        ▼                            ▼
 ┌────────────────────────────┐   agent CLI (opencode / codex / dsh)
 │ graphical Factorio process │        │ runs `python factorio.py ...`
 │  --host <save> multiplayer │        ▼
 │  RCON server + player      │   manager HTTP API (127.0.0.1:3000)
 │  autorio-control mod       │
 └────────────────────────────┘
        │ optional OBS WebSocket client (localhost) + window capture
        ▼
 OBS Studio ── 5 fps frames ──> timelapse conversion (AVFoundation / FFmpeg)
```

| Component | Default address | Notes |
| --- | --- | --- |
| Manager HTTP + static UI | `127.0.0.1:3000` (`AUTORIO_PORT`) | `server.listen(PORT, "127.0.0.1")`; serves `public/`; lock `.autorio/manager.pid` |
| RCON | `127.0.0.1:27015` (`RCON_PORT`) | Password generated into `.autorio/rcon-password` (0600) unless `RCON_PASSWORD` is set |
| Factorio multiplayer host | UDP `34197` (`AUTORIO_GAME_PORT`) | In the isolated profile's `config.ini`; the game bind and RCON are loopback-only |
| Agent | child process | Injected `FACTORIO_API_BASE`/`PYTHONPATH`; RCON/OBS secrets removed from its env |
| MCP server | `node dist/mcp-server.js` | Separate stdio process; proxies to the manager at `AUTORIO_API_BASE` |
| OBS WebSocket | `ws://127.0.0.1:4455` (OBS default) | Optional; manager is an OBS v5 WebSocket client only |
| Cluster instances | `3000..`, `27099..`, `34197..` | `scripts/cluster.mjs` spawns one isolated manager per instance |

One manager owns at most one game/run; parallel evaluation uses several managers with isolated ports
and `AUTORIO_DATA_DIR` (README "Parallel evaluation cluster").

## 3. Module map

| Layer | File(s) | Responsibility |
| --- | --- | --- |
| Transport | `src/server.ts` | Bootstrap: HTTP server creation, Factorio lifecycle, RCON bridge, native-control plumbing, `RunManager`/queue wiring, static+API dispatch, shutdown. The route table and endpoint handlers live in `src/api/`; HTTP plumbing and routing in `src/http/`. |
| Transport | `src/http/plumbing.ts` | `json()` envelope, `readJson()` body reader (size limits), `clampInt`, `parseRconJson` (via `src/validation.ts`). |
| Transport | `src/http/router.ts`, `src/http/static.ts` | Method/path/regex route matcher with params, and static UI serving (content types, `/runs.html` redirect, path safety, no-store caching). |
| Transport | `src/api/{context,shared,agent,jobs,runs,server,saves,manager}.ts` | `ApiContext` wiring plus endpoint groups (agent observe/action, action jobs, runs, server/RCON/saves, manager/shutdown, health); handlers preserve the exact envelopes/status codes. |
| Transport | `src/action-jobs.ts` | Serialized action-job queue: statuses/progress, ordered one-at-a-time execution, idempotency keys, one-hour retention, internal loopback dispatch with a 30-minute safety timeout. Injected into `src/api/jobs.ts`. |
| Observe | `src/telemetry-sampler.ts`, `src/observation-builders.ts`, `src/api/telemetry.ts` | Manager-side production ring buffer (sampled every 5 s independently of benchmark runs, unref'd timer, fail-soft) with per-minute rates, plus read-only `observe/production`, `observe/fluids` and `observe/combat` endpoints (pure Lua builders in `observation-builders.ts`). |
| Operate | `src/area-edit.ts`, `src/api/area-edit.ts` | `observe/area` deconstruction planning scans and reach-checked `copy-settings` (dry-run + synchronous paste via the verified `LuaEntity:copy_settings` API, native reach enforced; client moves first). |
| Transport | `src/command-builders.ts` | Pure `/sc` Lua builders for builds, clearing, destinations, observations, crafting/research and map queries; unit-tested without a manager or game. |
| Boundaries | `src/validation.ts` | Zero-dependency `unknown` guards for RCON/Lua replies, HTTP bodies and agent events (`asRecord`, `parseJson`, `arrayOf`, `invalidFields`, …); the typed-boundary layer replacing `: any` incrementally. |
| Operate | `src/logger.ts`, `src/health.ts` | Zero-dependency structured logger (JSONL `manager.log` + stderr mirror, secret redaction, child context) and the `GET /api/health` payload/status-code builder. |
| Transport | `src/run-cli.ts`, `autorio`, `autorio.cmd`, `autorio.ps1` | Operator CLI and Node-finding/rebuild launchers (`start/list/show/watch/stop/pause/resume/compare`). |
| Transport | `src/mcp-server.ts` | Dependency-free MCP stdio server: 25 tools (observations, action jobs, job status/cancel, runs/benchmarks/server status). |
| Transport | `src/run-terminal.ts`, `src/terminal-view.ts`, `src/recording-window.ts`, `native/recording-window.swift` | Optional terminal viewer and standalone recording window (WKWebView on macOS, Edge/Chrome app window on Windows); closes 2 s after a terminal run state. |
| Runs | `src/runs.ts` | `RunManager`: state machine, workspace prep, baseline cache, spawn/close/lifecycle, token/context accounting, telemetry and scoring, recording hooks, save/checkpoint/resume. Provider specifics live in `src/agents/`. |
| Runs | `src/agents/opencode-events.ts`, `src/agents/codex-events.ts` | Pure JSONL → transcript translators (thread/message/reasoning/command/usage/error ops) with typed appliers and reasoning dedup. |
| Runs | `src/agents/*-launch.ts` | Pure launch specifications (prompt, args, env allow/deny list, WSL script, DSH model patch and play wrappers) for the OpenCode/Codex/DSH backends; `runs.ts` writes the files and spawns. |
| Runs | `src/benchmarks.ts` | Loads/validates `benchmarks/*.json`; RCON telemetry command; `Snapshot` parsing and milestone `reached()` checks. |
| Runs | `src/run-labels.ts`, `src/token-usage.ts`, `src/quota.ts` | Pacific-local labels; Codex token fallback (`last_reported`); quota detection that pauses a run. |
| Game | `src/runtime.ts` | Paths, ports, config, isolated game profile (mod, `config.ini`, `server-settings.json`), map creation, version/Steam checks, mod hash. |
| Game | `src/platform.ts` | Cross-platform process/executable helpers: PATHEXT/`.cmd` shims, `spawnExecutable`/`execExecutable`, `taskkill` trees, Steam/browser discovery, usage sampling. |
| Game | `src/native-control.ts`, `factorio-mod/autorio-control/{info.json,control.lua}` | Native-action `/sc` command builder/poller; Factorio 2.1 mod for per-tick pathfinding walking, mining, sidestep avoidance, tree/rock clearing, cancellation, 5 s lease. |
| Game | `src/rocket.ts` | Finds and launches rocket silos through RCON. |
| Agents | `src/opencode.ts` | OpenCode model normalization (`provider/model#variant`), native-vs-WSL transport, WSL paths/quoting. |
| Agents | `src/dsh.ts` | DSH profile/CLI/credential resolution, per-run model patch, `play.cmd`/`play.ps1`/`play.sh` wrappers, headless NDJSON translator. |
| Observe | `src/vision.ts`, `scripts/capture-window.ps1` | Windows-only screenshot observation; `POST /api/agent/observe/visual` returns validated PNG base64. |
| Record | `src/obs-client.ts`, `src/obs.ts` | Localhost OBS v5 control, run-owned profile/scene, two-window composition, safe restore (`ObsRunRecorder`). |
| Record | `src/timelapse.ts`, `native/timelapse.swift`, `scripts/narrate.ps1` | 5 fps → silent 30 fps H.264 MP4 (6×) via AVFoundation/FFmpeg with metadata verification; Windows TTS narration. |
| Interfaces | `factorio.py` | Importable Python client + CLI: `FactorioClient`, action/job helpers, condition waits, belt/loader builders, blueprint-string codec + `build_blueprint` (chunked jobs, dry-run preflight), `observe_snapshot`/`observe_production`/`observe_fluids`/`observe_combat`/`observe_area`, copy-settings and pure construction planners (pipe/power/inserter/mining/defense). |
| Blueprints | `src/blueprints.ts`, `src/run-blueprints.ts` | Blueprint-string decode/summary and the per-run catalogue (`blueprints/index.json` + raw `.txt` files); `save_blueprint`/`list_blueprints` client helpers and build-time auto-registration. |
| Interfaces | `autorio_types.py`, `autorio_gym.py`, `autorio_trajectory.py` | Typed observation dataclasses; dependency-free Gym-style `FactorioEnv`; SQLite (WAL) episode/step store. |
| Interfaces | `public/` | Operator UI: `index`+`runs.js` (launch/history), `run`+`run.js` (details), `compare`, `recording`+`recording.js` (live transcript/status bar), `transcript-view-model.js` (DOM-free reasoning/action summaries, loop detection, telemetry metrics/markers), renderers, `production-chart.js`, `runs.css`. |
| Interfaces | `scripts/cluster.mjs`, `scripts/cluster-lib.mjs` | Cluster supervisor and side-effect-free helpers for instance planning, env, metadata, run requests. |
| Tooling | `scripts/api-selftest.py`, `scripts/game-status.py`, `scripts/doctor.mjs` | Read-only live API self-test, live game helper, environment doctor. |
| Tooling | `tests/`, `scripts/check-repo.mjs`, `scripts/package.mjs`, `.github/workflows/ci.yml` | Node/Python suites (no real game needed), repo hygiene gate, reproducible packaging, CI matrix. |
| Tooling | `eslint.config.mjs`, `scripts/coverage-gate.mjs`, `.githooks/pre-commit`, `scripts/install-hooks.mjs` | Type-aware ESLint (`no-floating-promises`/`no-misused-promises` errors, `no-explicit-any` warning), coverage thresholds (82/78/84 via Node's built-in report), and the fast pre-commit hook (check:repo + format:check + typecheck). |
| Tooling | `scripts/release.mjs`, `.github/workflows/live-selftest.yml`, `scripts/ci-live-selftest.ps1` | Semver/CHANGELOG/annotated-tag release automation and the manual self-hosted Windows live selftest (Steam + real game required). |

## 4. Manager ↔ game bridge

**RCON.** One TCP connection to the game (`rconCommand()`, 3 s default timeout). Gameplay code is
`/sc` Lua printing JSON via `helpers.table_to_json`, parsed back with `JSON.parse`; it serves
telemetry, observations, native control, maps, and `/save`. RCON is loopback-only; its password is
removed from agent environments.

**Native control mod.** `src/native-control.ts` generates `remote.call('autorio-control', ...)`:
`start`, then `poll` (100 ms), `stop`, with cancellation/timeouts; lease expiry is the fallback if
the manager disconnects. Each action carries a random token. The mod's `on_tick` walks the real
character through Factorio's pathfinder, mines with real mining times, sidesteps when stuck, mines a
blocking tree/rock, and clears build footprints. The lease is refreshed by every `poll`; on save
load the mod resets and never replays saved requests. JSON is embedded as Lua long-bracket strings.

**Action jobs.** State-changing requests are queued: `{action, payload}` to `POST /api/agent/jobs`,
poll `GET /api/agent/jobs/:id`. Direct `POST /api/agent/act/*` is rejected unless it carries an
internal per-process header (the queue dispatches over loopback `node:http`, avoiding undici's 300 s
abort). One job runs at a time so clients can't race the player; items are split (one entity/target
per internal request), idempotency keys are kept for an hour, and cancellation happens between
atomic actions. Builds pre-clear reachable trees/rocks in their footprint and retry once on
`cannot_build`. Underground belts and pipe-to-ground take a dedicated path: the manager creates
the entity with an explicit `type` (`input`/`output`) and consumes the place item, because the
player-cursor path cannot choose the variant. The queue itself lives in `src/action-jobs.ts`
behind a small `ActionJobQueue` interface (injected logging/native-stop/run-busy hooks); the HTTP
handlers in `src/api/jobs.ts` are thin delegates.

**Observations and telemetry.** Read-only endpoints
`/api/agent/observe/{world,map,map-overview,player,research,recipes,connections,layout,factory,placement,resources,entity,entity-prototype,description}`
build Lua returning normalized JSON, alongside the capability observations
`/observe/{production,fluids,combat,area}` (production rates come from the independent
`src/telemetry-sampler.ts` ring buffer; fluids/combat/area are bounded Lua area scans). The pure
Lua builders live in `src/command-builders.ts` and `src/observation-builders.ts` /
`src/area-edit.ts` (unit-tested without a game); route registration/handlers live in `src/api/`,
while RCON dispatch and shared state stay in `src/server.ts`. Benchmark telemetry is one `/sc`
snapshot per sample (`TELEMETRY_COMMAND`: tick, production, research, rockets, plus an optional
power summary from electric networks within 128 tiles of the player) parsed by `benchmarks.ts`;
the sampler reuses that parser outside runs.

**Map thumbnail.** `POST /api/agent/observe/map-overview` renders a compact, downsampled
ASCII map (`rows`, `legend`, window/step metadata) from charted chunks only. It
samples terrain, player-force entities, resources and the player at up to
1024-tile radius / 160-cell size; the Lua builder keeps the response bounded.
Python: `FactorioClient.observe_map_overview()` / CLI `observe-map-overview`;
  `format=svg|png` returns a compact image payload and identical requests are
  cached briefly to avoid repeated RCON scans.

**Health and operational logs.** `GET /api/health` returns 200 when every probe passes and 503
`degraded` (with a `problems` list) when a probe throws; an idle manager is healthy. The structured
logger writes JSONL to `<data-dir>/manager.log`, mirrors one human line per record to stderr, redacts
secret-looking keys, and records HTTP requests (method, path, status, duration; health polls excluded).
`AUTORIO_LOG_LEVEL` selects `debug|info|warn|error`.

**Automation scoring.** `src/automation-score.ts` computes the agent score from
automated production, science, power satisfaction, research and rockets, minus
manual mining/crafting, stale STATE.md and full-blackout penalties. A blackout
is counted once per transition after any network reports positive production
capacity: demand > 0 and satisfaction ≤ 0.5% subtracts 500 points; the count and
active state persist in `run.json`.

**Agent interface usage.** Every `/api/agent/...` request handled while a run is
active is counted by `METHOD /path` (job IDs normalize to
`/api/agent/jobs/:id`) and persisted in `run.json`; the run page and recording
window expose totals/endpoint counts via
`GET /api/runs/:id/tool-calls` (active shorthand `/api/tool-calls`). Internal
action-loopback requests and polling are included, so the view reflects the
agent's complete interface profile.

**Power planning.** `plan_power_network` covers targets using the selected
pole's real supply width (small/medium 5, substation 18); `plan_power_line`
creates straight horizontal/vertical trunks with wire-reach spacing and includes
both endpoints (big pole default, 30 reach). The planner avoids using big poles
as a dense coverage grid.

**Manual-penalty grace.** `recordJob` counts manual mines/crafts only after
`MANUAL_PENALTY_GRACE_SECONDS` (default 1800) of active play; the run view exposes
`manual_penalty_grace_active`/`manual_penalty_grace_seconds`, and recovery
recounting follows the same window. State/blackout penalties are unaffected.

**Resource mining.** `FactorioClient.mine_continuous` repeats the native mine
action on the *same* target until no resource remains or a count is reached;
`act-mine --resource` defaults to `--count all` and rejects multiple resource
targets so the character cannot hop ore veins after one cycle.

**Inserter direction.** Inserters use `direction` as the pickup/facing side
(Factorio semantics); drop is the opposite tile. All planner helpers invert the
desired flow, and `observe-connections` labels source/target accordingly.

**Empty containers.** Factory observations include container totals and up to
200 empty chests; they are default refactor debt. Scoped cleanup removes only
empty containers (contents checked per target), never silently full chests.

**Scoped refactor.** `buildRefactorAudit` tags actions by belts/power/pipes/
machines/rail, includes power and fluid factory failures by default, and only
adds rail when requested. `invalid_count` is the scoped sum; `deconstruct-area
--scope` maps the same categories to entity-type filters.

**Cleanup rewards.** `cleanupMineUnits` reads `cleanup=true` targets; successful
entities add positive score and are subtracted from manual mining penalties.
`recordRefactorAudit` adds a positive reward per invalid-debt unit removed. Both
queued and direct build paths share the refactor/blueprint gate.

**Nearest-first deconstruction.** `observe-area?order=near` selects candidates
nearest the window center before truncation; `deconstruct_area` then sorts with a
nearest-neighbor walk from the player/explicit start, optionally filters by
`max_distance`, and chunks the ordered list. This keeps bulk recycling local.

**Blueprint efficiency.** `evaluateBlueprint` decodes a stored/wire blueprint,
classifies machine/belt/inserter/pole/pipe support, computes density metrics and
accepts dynamic output/power/build-time inputs for output-per-tile/machine/kW.
Scores are transparent structural and dynamic indexes, not a single universal
truth.

**Blueprint gate.** `RunManager.blueprintGate` rejects build jobs after the
opening grace until the run registry contains a blueprint; capture is an
observation/registry action and remains allowed. This enforces capture and
surfaces existing designs in the UI.

**Route planning.** `plan_grid_route` A* operates on the free-space grid
produced by `observe-free-space`; `plan-route` wraps it with belt/pipe/wall/power
entity planners, width clearance and pole spacing, without building.

**Free-space/geometry.** `observe-free-space` renders a buildable/blocked grid
and connected free rectangles; `geometry-check` computes rotated footprints,
detects overlaps and calls native placement analysis without building.

**Pipeline perception.** `observe-pipeline` composes factory + connection +
area observations into a graph of machines, inserters, belts, pipes and power,
with bboxes/status/recipe and prioritized bottlenecks; `pipeline-audit` exposes
only the bottleneck section. `LAYOUT.md` is the agent's persistent geometry
memory for anchors, grids, corridors and gaps.

**Refactor debt/gate.** The manager periodically stores a `refactor` state
(invalid count, fingerprint, debt age, audit count). A build job is rejected with
`REFACTOR_REQUIRED` once debt persists past the gate grace; cleanup actions stay
allowed. Three debt audits or 50 blackouts arm `big_reset_pending` and the run
page shows a flashing attention banner.

**Blueprint capture.** `encodeCapturedBlueprint` turns observed built entities
(center positions + directions/recipes) into a normal wire string, and
`/api/agent/blueprints/capture` registers it for the active run. This closes the
build → capture → reuse/iterate loop.

**Crash debris visibility.** Layout marks neutral crash-site spaceship debris as
`X`, map-overview as `S`, and observe-map symbols include it; these are neutral
entities, not player-force, so the old filters hid them.

**Mine target forwarding.** The `/act/mine` handler preserves
`allow_buildings` on the native target; native mining uses it to permit
intentional removal of player-owned blockers (rescue/deconstruct).

**Trapped-player rescue.** `FactorioClient.unstick` probes short path routes and
mines low-value player-owned blockers with `allow_buildings` until movement
opens; no teleport. It is a client-side recovery helper using existing actions.

**Refactor audit.** `buildRefactorAudit` merges factory status problems and
connection issues into prioritized repair actions (critical production first,
then blocked machines, then belt/inserter links), with examples and a stable
fingerprint for the three-strike escalation.

**Connection audit summary.** `summarizeConnectionsData` groups issues, adds fix
suggestions, classifies link counts and renders a compact arrow/issue map for
complex belt areas without changing the raw audit rows.

**Belt relayout.** `relayout_belts`/`relayout-belts` wraps deconstruction of
all belt types in an area; the three-strike policy requires it after repeated
link failures instead of endless patch attempts.

**Belt connectivity.** `validate_belt_entities` checks planned runs for dead
ends/head-on/missing-input tiles before build; `observe-connections` audits
existing belts and reports `belt_no_input` in addition to dead ends and
non-belt endpoints. Corners and crossings must be explicitly oriented.

**Belt/pipe contents.** Entity observation reads `LuaTransportLine.get_contents`
for up to two belt lanes and `LuaEntity.get_fluid_contents` for actual fluid
amounts; `belt-contents`/`fluid-contents` are thin client helpers over
`observe-entity`.

**No-idle policy.** Explicit `wait` is rejected, `wait_for_*`/`wait_until`
  deadlines are capped by `AUTORIO_MAX_WAIT_SECONDS` (default 5s), and the
  shell/Python sleep shims cap at 2s. Prompt, AGENTS template and COOKBOOK require
  a 3-item next-work queue so a blocked condition triggers the next build/fix
  task instead of idle polling.

**Agent envelope version.** Agent JSON omits `schema_version`; the
`X-Autorio-Schema-Version` response header and `/api/health.versions.api_schema`
carry it instead. Non-agent/operator API envelopes keep the field for existing
clients.

**Agent response compaction.** `src/http/agent-compact.ts` trims manager-only
bookkeeping from `/api/agent/*` JSON while preserving errors, alerts, inventories,
observations and job results. CLI JSON no longer includes local `timing_ms`.
The public non-agent API envelope is unchanged.

**Mining safety.** The native miner filters player-owned non-resource entities
unless the target carries `allow_buildings: true`. `act-mine`/`mine_continuous`
stay protected, `deconstruct-area` and crash-debris recovery opt in; a protected
target returns `protected_building` instead of silently dismantling the factory.

**Critical alerts.** `src/alert-store.ts` deduplicates factory problem
counts into revisioned critical/warning alerts. `/api/agent/*` responses are
augmented with an `alerts` envelope, and critical alerts older than the gate
grace block mutating requests with `ALERTS_PENDING` until the current revision is
acked. Long-unresolved critical alerts accrue a cumulative `alert_penalty` in the
automation score; there is no agent restart path.

**Agent knowledge.** `src/agent-knowledge.ts` is the canonical compact
engineering reference (inserters, pipes, trains, power, chemistry, defense,
production, blueprints) with aliases, common mistakes and wiki references. It is
served by `GET /api/agent/knowledge`, mirrored as `KNOWLEDGE.md` in each run
workspace, and referenced from the prompt.

**Unified linear builder.** `FactorioClient.build_line`/CLI `build-line`
dispatches pipe, belt, wall and pole plans over a shared route: `auto` uses the
native pathfinder and `_path_route_tiles` for an orthogonal corridor,
`straight` retains the historical L/straight builders, and underground variants
are explicit straight-only. This centralizes obstacle handling for continuous
installations.

**Belt rules.** `BELT_RULES` in `entity-usage.ts` encodes the base-game lane and
junction rules (two lanes, no automatic summing at crossings/head-on meetings,
one-lane side-loading, splitter merge/cap, underground crossing, belt throughput).
The per-entity guidance, `entity-usage-catalog`, COOKBOOK and agent prompt all
reference the same notes.

**Build exactness.** `act-build` accepts only integer top-left anchors; a
fractional anchor is rejected with `anchor_must_be_integer` and a hint to use
`observe-entities.anchor`. The manager waits two ticks after a native move so a
running character cannot place from a stale cursor frame, and every successful
build reports `actual_anchor`, `offset_tiles` and `exact` computed from the live
bounding box. The player-movement staging still uses pathfinder results; build
positions themselves are absolute.

**Entity interfaces.** `observe-entities` annotates each result with
`type` and an `interfaces[]` list: inserter `pickup`/`drop`, belt/splitter
`input`/`output`, fluid connection points (position/direction/fluidbox/target),
and power-pole role. `observe-layout` entity summaries include the prototype
`type`; `observe-connections` carries types on both endpoints. Interface
positions are tile coordinates, so they can be fed directly into build/placement
planning.

**Footprints.** `observe-entities` returns each entity's `anchor` (top-left
occupied tile), `footprint`/`collision_bounds`, `tile_size`, center and occupied
tile; `observe-layout` fills full bounding boxes, `observe-placement` uses the
game's dry-run footprint validation, and `observe-entity-prototype` exposes
tile/collision/selection boxes. Map symbols remain point markers and should not
be used to infer footprint.

**Entity usage catalog.** `entityUsageCatalog()` serializes every curated
type/name rule for offline lookup; the per-entity endpoint adds live prototype
limits (tile size, rotation, energy source, fluid boxes, placement item, health)
and falls back to type/observation guidance for modded entities. The COOKBOOK
and prompt direct agents to the catalog before designing unfamiliar blocks.

**Entity usage.** `src/entity-usage.ts` holds curated behavior rules by prototype
type (one-way belts, splitter inputs/outputs, underground pairs, inserter pickup/
drop, machines, fluids, power, logistics) and falls back to type-based observation
guidance for modded/unknown entities. `POST /api/agent/observe/entity-usage`
combines it with a live prototype lookup; the agent prompt/COOKBOOK require it
before designing unfamiliar junctions.

**Prototype descriptions.** `POST /api/agent/observe/description` resolves an
entity or technology `localised_description` in the game's current locale; it
returns the raw LocalisedString and the rendered text, or
`missing_translation: true` when the base game has no description for that
prototype (common for many entities). Python `client.describe(name, kind=...)`
/ CLI `describe --kind entity|technology --name ...`.

**Blueprint catalogue.** Blueprints created by an agent are registered per run and are
available to the agent and operator:
`GET /api/blueprints` lists the active run, `POST /api/blueprints` registers into
it; run-scoped equivalents are `GET|POST /api/runs/:id/blueprints` and
`GET /api/runs/:id/blueprints/:blueprintId` for decoded detail, with `PATCH`
  (label/description) and `DELETE` management. Registration
validates and summarizes the Factorio wire string (base64/zlib/JSON), dedupes by
SHA-256, and stores raw text plus an index under the run directory. The run page and the live recording window show a **Blueprints** count and toggle with decoded summaries, an SVG layout preview and raw-wire download; the Python client also exposes `blueprint-list` / `blueprint-save` CLI commands. Python clients use
`FactorioClient.list_blueprints()` / `save_blueprint()`; `build_blueprint()` also
registers automatically when the launched agent has `AUTORIO_RUN_ID` (injected by
`RunManager`).

## 5. Run lifecycle and data flow

States (`RunState` in `src/runs.ts`): `preparing`, `launching`, `running`, `saving`, then terminal
`completed`/`failed`/`stopped`/`timed_out`/`interrupted` or resumable `paused`.

1. **Start** — `POST /api/runs` (dashboard, CLI, cluster) calls
   `RunManager.start()`, which allocates a run id/name and writes `run.json`.
2. **Prepare** — `workspace/` gets a frozen `factorio.py` and the playbook from
   `runs/run_template/AGENTS.md`, plus `TASK.md`/`benchmark.json` and the design
  cookbook `COOKBOOK.md`; versions and
   SHA-256 hashes are recorded. The fixed-seed baseline is cached under
   `.autorio/baselines/<hash>/baseline.zip` (keyed by Factorio version + map
   settings + mod hash), generated once with `createMap()`, and copied per run as
   `game.zip`. The agent CLI is version-checked before the clock starts (DSH also
   needs an API key).
3. **Launch** — starts the graphical game from the isolated profile, hosting the run
   save with loopback RCON; waits for telemetry readiness
   (`AUTORIO_STARTUP_SECONDS`, default 180 s). The first `/sc` exits the cutscene,
   sets daylight, inserts starting items, disables intro/crashsite; a baseline
   snapshot is recorded and native controls reset. Recording window/terminal and
   optional OBS capture start, the game is unpaused (`game.speed = 1`), baseline
   research milestones are marked `initial`, and the agent is spawned.
4. **Agent** — the backend runs in the workspace with `FACTORIO_API_BASE` and
   `PYTHONPATH`; its prompt points at `AGENTS.md`/`COOKBOOK.md`/`TASK.md` and the Python client.
   stdout is parsed into transcript events (`agent.events.jsonl`, `codex.log`);
   session id, token/context counters, and quota errors update `run.json`.
5. **Telemetry and scoring** — a monitor samples every `sample_seconds`, appends
   `telemetry.jsonl`, computes production-rate deltas, and records milestones at
   their **first-observed** wall time/game ticks (baseline subtracted). Completion
   is declared only when the independently observed completion milestone is
   reached — never from the agent's claim or exit code. A watchdog enforces
   `max_seconds`; three consecutive telemetry failures fail the run.
6. **Finalize** — state becomes `saving`: pause the game, kill the agent process
   tree (and WSL pid), cancel jobs/native controls, stop OBS, request `/save`, copy
   `final.zip`, and store `segments/NNN/checkpoint.zip` with a SHA-256.
   `SUMMARY.md` is written and the run becomes terminal; recorded video converts to
   a 6× timelapse in the background. Pause resumability is preserved by the
   checkpoint: `resume` reloads the same save/workspace/session and re-copies the
   game profile.

## 6. Agent backends and transcript translation

Every backend is normalized into the events that `public/recording.js` and
`public/codex-transcript.js` render: `thread.started`, `item.started`/`item.completed`
(`agent_message`, `reasoning`, `command_execution`), `turn.completed`, and `error`.

| Backend | Command | Translation and notes |
| --- | --- | --- |
| `opencode` (default) | `opencode run --format json --thinking --model provider/model --auto` (+ `--session` on resume) | `text` → message, `reasoning` → reasoning/thought log, `tool_use` → command execution, `step_finish.tokens` → counters, `sessionID` → session. Native binary or WSL via generated `agent-launch.sh` + `wsl.exe -d <distro>`; cached tokens tracked as a max, not summed. |
| `codex` | `codex exec --json --ignore-user-config --sandbox ... -C <workspace> --output-last-message REPORT.md` (+ `-c` provider overrides, `resume <session>`) | Consumes Codex `item.*`/`turn.completed` events directly; `thread.started` sets the session. `AUTORIO_CODEX_*` configures an OpenAI-compatible provider; session-log token fallback is labelled `last_reported`. |
| `dsh` | `dsh --profile headless --json`, task over stdin, `--session-id` on resume | `translateDshEvent()` maps `session`, `thinking`, `text`, `tool_call`, `tool_result`, `status.step_end` (usage), `status.turn_end` (error); unknown events are ignored. Per-run `dsh-model.patch.yml`; key from env/`.env`/`$DSH_HOME/.credentials.yaml` refs only passed to the child; Windows `play.cmd` + `play.ps1`/`play.sh` fallback; always web transcript. |
| `manual` | none | `--manual` prepares game + telemetry for diagnostics without an agent. |

Workspaces contain short-wait helpers (`bin/sleep`, `sitecustomize.py` cap sleeps at 10 s) and
prompts require condition waits (`wait_for_*`). `AUTORIO_CONTEXT_LIMIT` stops the agent, writes
`RESUME.md`, clears the session id, and restarts it in place without stopping the game.

## 7. On-disk layout

Everything generated lives under `AUTORIO_DATA_DIR` (default `.autorio/`, git-ignored):

```text
.autorio/
  baselines/<hash>/{baseline.zip,profile/}  manager.log  manager.pid  factorio.pid
  rcon-password  saves/  manager/  tools/  cluster/  runs/<run-id>/
    run.json  benchmark.json  game.zip  final.zip  SUMMARY.md  recording-window.json
    telemetry.jsonl  milestones.jsonl  jobs.jsonl  activity.log  codex.log
    agent.{stdout,stderr}.log  agent.events.jsonl  agent-launch.json
    thoughts.log  thoughts.txt  profile/  workspace/  blueprints/{index.json,<sha>.txt}
    segments/NNN/checkpoint.zip
    video/{timelapse.mp4,timelapse.json}
```

There is no automatic retention/cleanup: old runs, baselines, and videos stay until removed
manually.

## 8. Extension points

- **New gameplay API endpoint** — add the Lua builder in `src/command-builders.ts` and
  register the route in the matching `src/api/*.ts` group (`register*Routes(router, ctx)`;
  `json()`/`readJson()` conventions; observations are read-only `POST`). If it
  mutates state, register it as a queued action job (`JobAction`, `actionPaths` in
  `src/action-jobs.ts`) rather than exposing it directly; then add a `factorio.py`
  method and CLI subcommand, cover it in `scripts/api-selftest.py`, and add an MCP
  tool or Gym action if it belongs there.
- **New MCP tool** — add a `ToolDefinition` to `TOOLS` in `src/mcp-server.ts`
  (`inputSchema` + `request()`, `jobRequest()` for actions). stdout stays  protocol-only; diagnostics go to stderr; test it in
  `tests/mcp-server.test.mjs` against its fake HTTP server.
- **New agent backend** — extend the `Run["agent"]` union, CLI/UI presets, add a
  `checkAgent()` version probe and a launch method emitting the shared transcript
  events, token/context accounting, quota handling, and resume support. Add a
  fake-CLI lifecycle test and document it in README/AGENTS/`.env.example`.
- **New benchmark** — normally only a `benchmarks/*.json` addition: id, title,
  task, `max_seconds`, `sample_seconds`, map seed/settings, starting items,
  daylight policy, and milestones with exactly one `completion` id
  (`loadBenchmarks()` validates the shape at startup).
- **New UI** — static files in `public/` need no build step (`Cache-Control: no-store`).

## 9. Known debt and limitations

- **`src/server.ts` monolith** — resolved: pure Lua builders, the action-job queue, agent
  backends/launch specs, HTTP plumbing/route groups and the API handlers were extracted, leaving
  `server.ts` as bootstrap + game/RCON lifecycle (~680 lines). Remaining glue is intentional
  (RCON bridge, lifecycle, wiring) but can still be split further if it grows.
- **Operational tooling gaps** — structured logs and `/api/health` exist, but there are still no
  metrics endpoint, log rotation or alerting; the CI matrix runs build/tests/hygiene/formatting/
  lint/coverage but no automatic live Factorio integration (the `Live selftest` workflow is manual
  and self-hosted).
- **`any` leakage at JSON boundaries** — resolved: the API handler layer now parses request
  bodies and RCON/Lua replies through explicit interfaces and `src/validation.ts` guards, so
  the repo has **0** `no-explicit-any` warnings. Keep new dynamic boundaries typed and promote
  the ESLint rule from warning to error once the guard helpers stabilize.
- **No authentication** — the HTTP API and RCON are loopback-only; the internal
  job header is a random per-process UUID, not authorization. The API assumes a
  trusted local operator/agent: run workspaces ask agents to use only the Python
  gameplay API, but raw RCON remains available to the operator.
- **One run at a time** — parallel evaluation needs cluster manager processes,
  bound by memory/GPU budget (2–3 graphical instances on a normal desktop).
- **Platform scope** — graphical play requires macOS or Windows; Linux is useful
  for tests/CLI work only. Visual capture also needs an interactive unlocked
  Windows desktop.
- **Polling-based, file-backed state** — milestones are first-observed samples, not
  engine events (Gym `GameInfo.tick` is approximate while paused); runs are
  `run.json` + JSONL files and jobs are in-memory (one-hour retention). A manager
  restart marks unfinished runs `interrupted`; there is no automatic resume.
- **Docs drift** — README, `AGENTS.md`, and this file must be updated with API or
  module changes (the repo-hygiene gate only checks that the files exist).

## 10. Further reading

- `README.md` (user manual), `CONTRIBUTING.md` (setup, gates, tests, style, recipes).
- `CHANGELOG.md` (current batch); `AGENTS.md`, `runs/run_template/AGENTS.md` and
  `runs/run_template/COOKBOOK.md` (agent summaries, the run playbook and the design cookbook).
- `docs/agent-capability-plan.md` (agent capability gaps, blueprint/telemetry/planner roadmap).
