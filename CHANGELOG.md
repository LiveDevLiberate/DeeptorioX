# Changelog

All notable changes to autorio are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project aims to follow [Semantic Versioning](https://semver.org/). Released
versions are tracked by annotated git tags; history before commit `9e4e677` predates
this file.

## [Unreleased]

## [0.11.0] - 2026-11-04

### Changed

- **Agent prompt starts with a mandatory STATE.md step.** The task prompt now
  begins with `STEP 0`: the first tool call must write `STATE.md` from a filled
  template (`Updated`/`Objective`/`Scores`/`Current`/`Done when`/`Next`), and it
  is updated whenever the subtask or its done-when condition changes. Verified
  against the real DSH backend: with the previous prompt the file never appeared;
  with the new prompt the model's first tool call writes `STATE.md` (Chinese
  values included).
- The prompt also requires a short progress message in the configured language
  after each subtask (and at least every ~10 tool calls), so the `消息` filter and
  TTS narration get Chinese content even when the model's internal chain of
  thought stays English.

## [0.10.6] - 2026-11-04

### Changed

- **No more permanent “STATE.md pending” line.** The status bar only shows the
  plan line when the agent has actually written `STATE.md` (with
  `Current:`/`Done when:`/`Scores:`) or when live research progress exists;
  otherwise the line is hidden instead of advertising a file that may never
  appear. `STATE.md` parsing, stale-plan marking and scores remain for runs that
  do use it (earlier Codex runs wrote it; recent DSH runs did not).
- The agent task prompt now explicitly asks the model to create `STATE.md`
  before its first action (`Current:`, `Done when:`, `Scores:`) and update it
  whenever the subtask changes, so future runs are more likely to populate the
  operator view.

## [0.10.5] - 2026-11-04

### Fixed

- **Actions filter showed a blank transcript.** Command groups are rendered as a
  single top-level `<details>` node, but the `kind` tag was only set on the rows
  inside it, so the Actions chip hid everything. The group node is now tagged
  `commands` and the filter keeps it visible (with a `?filter=actions` deep link
  for testing).
- **Filtered-out nodes could stay visible.** Author `display` rules (e.g. the
  flex turn divider) overrode the `hidden` attribute; a global
  `#codexOutput [hidden] { display: none !important }` now keeps filtered
  content hidden.
- **Empty filters now say so.** When a filter has no matching entries the
  transcript shows a dashed “No entries for this filter / 当前过滤下没有内容”
  note instead of an empty page (e.g. the Messages filter before the model emits
  its first progress message).

## [0.10.4] - 2026-11-04

## [0.10.3] - 2026-11-04

### Changed

- **Recording theme v3 (clean neutral dark).** Replaced the teal/indigo glow
  background and multi-hue surfaces with a neutral slate shell (`#0b0e11` →
  `#090c0f`) and a single blue accent (`#7aa2f7`): running/interactive states are
  blue, completed green, paused amber, failures red; cards are `#11161b` with
  `#222b33` borders. Action badges are now neutral pills with only the category
  icon tinted, decision frames keep just an amber left rule, and the mint
  header rule/green cast are gone. Overlay mode uses the same flat palette.

## [0.10.2] - 2026-11-04

### Changed

- **Recording colour system v2.** The transcript palette is now a cool slate
  base (`#0a0f13` → `#080d11`) with a mint primary accent, blue for messages,
  amber reserved for decisions/warnings and red for failures; the green cast on
  the background/text is gone, card surfaces and action badges are desaturated,
  and the header gets a subtle mint→blue top rule. Contrast was raised for body
  text, timestamps and raw toggles. Decision frames are now limited by a
  stricter imperative-plan heuristic (`next step`, `I need to …`, `let's …`,
  `下一步`/`计划` …), so ordinary narrative about belts/furnaces stays neutral
  instead of lighting up every paragraph amber.

## [0.10.1] - 2026-11-04

### Fixed

- Filter chip icons now survive label localization: updating the chip labels
  replaces only the text span instead of overwriting the whole button, so the
  game-icons.net glyphs (stack/brain/wrench/chat/siren/compass) stay visible in
  both languages; chips also expose `aria-pressed` for the active filter.

## [0.10.0] - 2026-11-04

### Changed

- **Recording-window icons now come from [game-icons.net](https://game-icons.net/).**
  25 white-on-transparent line/silhouette SVGs (Lorc, Delapouite, Skoll, Sbed)
  live in `public/icons/`, are rendered as CSS masks tinted with `currentColor`
  (chips, telemetry pills, action badges, card headers, unread pill) and are
  listed with author/source/license in `public/icons/ATTRIBUTION.md`
  (CC BY 3.0). The manager now serves `.svg` as `image/svg+xml` so the masks
  load; the previous hand-drawn inline sprite is gone.

## [0.9.0] - 2026-11-04

### Added

- **Transcript icons and framed reasoning segments.** A small inline SVG icon
  sprite (line icons, `currentColor`, no dependencies) is used sparingly: filter
  chips (layers/bulb/wrench/chat/alert/compass), telemetry metric pills
  (gear/flask/bolt/alert), action badges per category (hammer, pickaxe, eye,
  arrows, flask, rocket, trash, clock, …), card headers (bulb for reasoning,
  terminal for command groups, wrench for tool output, flag for event markers)
  and the unread pill. Reasoning bodies are split into framed sub-boxes per
  thought segment, with plan/decision segments carrying an amber left accent so
  long thoughts read as discrete blocks instead of one wall of text.

## [0.8.0] - 2026-11-04

### Changed

- **Recording transcript visual refresh.** The live thinking window now uses a
  terminal-dashboard look: glassy status header with a state pill, pulsing
  activity dot and telemetry metric chips; centered 1000px transcript column;
  reasoning and command groups as bordered cards with CSS-triangle chevrons;
  colour-coded action badges (build/mine/observe/recipe/…), inline raw toggles,
  turn dividers, styled scrollbars and a floating unread pill. Terminal runs no
  longer show a duplicate English activity label or an empty six-score row, and
  long paths/messages wrap on narrow widths. `?overlay=1` keeps the larger-text
  transparent variant. Functional behaviour and DOM hooks are unchanged
  (front-end tests still pass).

## [0.7.1] - 2026-11-04

### Fixed

- Transcript auto-expansion: the newest two reasoning blocks are expanded again (and the
  newest command group), instead of every reasoning block being collapsed because the
  open-state was computed before the block list was updated. Found while watching a real
  smoke run in the recording window.

## [0.7.0] - 2026-11-04

## [0.6.0] - 2026-11-04

### Added

- **Thinking-window readability.** The live transcript now renders reasoning as
  collapsed blocks with one-line summaries (newest two expanded; repeated thoughts
  collapse into `repeated ×N`), commands as action rows with category badge,
  target and result plus category counters (`12 build · 3 mine · 1 failed`) and a
  `loop? ×N` warning for repeated actions, non-command tools as label+detail, and
  turn dividers with relative timestamps for live events. A floating unread
  (`N new ↓`) pill pauses auto-follow when scrolled up. Action rows show command
  duration when available. The status bar gains
  telemetry metrics (top production rate with a mini sparkline, power satisfaction,
  research progress,
  latest failure), and telemetry deltas insert event markers (research completed,
  item starts producing, rocket launched). A toolbar filters by
  Thinking/Actions/Messages/Errors/Decisions and searches the transcript
  (persisted); long runs keep a bounded DOM with a trimmed-note. `?overlay=1`
  switches to a transparent, large-text OBS overlay. New
  `public/transcript-view-model.js` keeps the heuristics DOM-free and unit-tested.
- **Condensed reasoning digest for TTS.** `runs/<id>/thoughts.digest.log` /
  `thoughts.digest.txt` receive one summarized reasoning line per chunk (keyword
  sentence preferred, 200-char cap, consecutive duplicates skipped; raw
  `thoughts.log` unchanged). `scripts/narrate.ps1` adds `-Digest` (follow the
  digest stream), default-on `-Dedupe`/`-NoDedupe` and updated help/examples.

## [0.5.0] - 2026-11-04

## [0.4.0] - 2026-11-04

### Added

- **Underground belt / pipe-to-ground support.** The build action accepts a per-entity  `underground_type: "input" | "output"`; the manager creates the explicit subtype through a
  dedicated Lua path (`create_entity` + item consumption, reach/collision checks) instead of the
  native cursor path, which cannot select underground variants. The Python client expands
  blueprint `input`/`output` subtypes into `underground_type`, ships them in every chunk, and adds
  `plan_underground_belt_line` / `plan_underground_pipe_line` (straight axis-aligned input/output
  pairs at tier distances 4/6/8 for belts, 10 for pipes, with surface connectors) plus
  `build-underground-belt` / `build-underground-pipe` CLI commands. Live-validated on a real
  Windows-hosted Factorio: pairs were created with the correct `belt_to_ground_type` subtypes and
  the standard belt build path stayed intact.

- **Client deconstruct-area.** `FactorioClient.deconstruct_area` plans an area through
  `observe/area` (types/filters/player_only/limit) and removes the targets with the normal native
  miner in <=50-target queued jobs: `dry_run` returns the exact plan without mining, empty areas
  are ok no-ops, per-entity failures aggregate into `ok:false` without stopping later chunks, and
  fatal job failures stop with `failed_chunk`/`error`. CLI `deconstruct-area` mirrors it
  (`--include-all` = player_only false, `--types tree,simple-entity` for passability sweeps,
  `--types resource` for ore). Live-validated on the real Windows game: area scan -> mine job
  removed a tree (wood collected) and correctly reported a stale target as `no_entity`.

## [0.3.0] - 2026-11-04

### Added

- **Agent capability P0.** Manager-side production telemetry sampler (5 s, independent of
  benchmark runs) with `observe/production` (per-minute rates/deltas/research/rockets),
  `observe/fluids`, `observe/combat` and `observe/area`; area editing with copy-settings
  dry-run + synchronous reach-checked `act/copy-settings`; MCP tools for all new observations
  (25 -> 31). Python client: Factorio blueprint-string codec + `build_blueprint` (chunked jobs,
  dry-run placement and missing-items preflight, CLI `act-build-blueprint`),
  `observe_snapshot`/`wait_for_production`/`wait_for_fluid`, and pure construction planners
  (pipe lines, power networks, inserter pairs, mining outposts, defense lines) with build
  wrappers. A design cookbook (`runs/run_template/COOKBOOK.md`) is copied into every run
  workspace and referenced by the agent prompt.

## [0.2.1] - 2026-11-04

## [0.2.0] - 2026-11-04

This section summarizes the 29 commits in `9e4e677..15465ed` (2026-11-03 to
2026-11-04), plus the repository tooling and documentation landing on top of them,
grouped by theme.

### Added

- **Native Windows support.** Platform helpers for `PATHEXT`/`.cmd` shims,
  `taskkill` process trees, Steam/GOG/standalone Factorio detection, browser
  discovery, and process-usage sampling; recording view in an isolated
  Edge/Chrome app window and terminal viewer in its own console; OBS
  `window_capture` sources and FFmpeg/FFprobe timelapse conversion;
  `autorio.cmd`/`autorio.ps1` launchers, `npm run doctor`, Windows docs, and
  `.cmd`-shim Python discovery in tests.
- **Agent backends.** A native/WSL OpenCode backend (`opencode run --format
  json`) that translates events into the existing transcript schema, tracks
  session ids and token usage, and terminates WSL agents by pid; an optional
  Codex backend that accepts an OpenAI-compatible provider via
  `AUTORIO_CODEX_*` overrides; and a DeepSeek Harness headless backend
  (`--agent dsh`) with profile/model/credential resolution, a per-run
  `agent-default-model` patch overlay, Windows `play.cmd`/`play.ps1`/`play.sh`
  wrappers, NDJSON event translation, and `--session-id` resume.
- **Evaluation interfaces.** An MCP stdio server (`src/mcp-server.ts`, 25
  tools); the dependency-free Gym-style `autorio_gym.py` with typed
  observations (`autorio_types.py`) and a SQLite episode/step store
  (`autorio_trajectory.py`); the Windows game-window screenshot endpoint
  `POST /api/agent/observe/visual`; and the multi-instance
  `scripts/cluster.mjs` supervisor with isolated manager/RCON/game ports and
  data directories.
- **Engineering baseline.** GitHub Actions CI (Ubuntu Node 20, Windows Node 24)
  running build, Node+Python tests, repository hygiene and a format check;
  Prettier with `.editorconfig`/`.nvmrc`/LF `gitattributes`; `npm run verify`,
  `test:coverage` (Node built-in, no coverage dependency), `check:repo`,
  `format:check` and reproducible `package` (patch + `git archive` zip +
  sha256); a zero-dependency structured logger (`JSONL manager.log`, stderr
  mirror, secret redaction, request logs, `AUTORIO_LOG_LEVEL`) and the
  `GET /api/health` liveness probe (200/503, `problems` list); extraction of the
  pure Lua command builders from `src/server.ts` into
  `src/command-builders.ts`; and `docs/architecture.md`, `CONTRIBUTING.md`,
  `CHANGELOG.md` plus a README table of contents.
- **Observation and planning tools.** Aggregate `observe-factory`
  (entity/power/fuel/research status and alerts); `observe-layout` ASCII
  rendering with explicit overlap layers; `observe-connections` audit with
  directional inserter symbols; `build_belt_line()`/`act-build-belt`;
  loader helpers (`loader_entity()`, `build_loader()`, `act-build-loader`);
  condition waits (`wait_until`, `wait_for_item`, `wait_for_research`,
  `wait_for_factory`) instead of fixed sleeps; and a read-only
  `npm run selftest` API check.
- **Agent playbook and time discipline.** An automation-first core rule, a
  scored six-subtask loop with measurable finish lines and a `STATE.md`
  update cycle, armed exploration for idle time, active-plan exposure with a
  stale-plan warning, a 64-tile move guard with suggested waypoints, capped
  shell/Python sleeps enforced by workspace wrappers, and a configurable
  `AUTORIO_CONTEXT_LIMIT` that restarts the agent session in place (writing
  `RESUME.md`) without stopping the game.
- **Native control improvements.** Sidestep avoidance when the character is
  blocked, mining blocking trees/rocks when sidestepping cannot free it,
  clearing build footprints before placement (mines overlapping trees/rocks
  and non-minable stumps, retries once on `cannot_build`), and operator
  `pause`/`resume` that saves a checkpoint, keeps the game/workspace/session,
  and re-copies mods on resume.
- **Developer tooling and documentation (post-batch).** Quality-gate scripts
  (`verify`, `check:repo`, `format`, `format:check`, `test:coverage`, `package`),
  the GitHub Actions CI matrix, EditorConfig/Prettier configuration, and this
  architecture/CONTRIBUTING/CHANGELOG set with a README table of contents.
- **Engineering hardening (P2/P3).** The serialized action-job queue moved out of
  `server.ts` into `src/action-jobs.ts`; OpenCode/Codex event translation and the
  provider launch specifications moved into `src/agents/*` with typed op
  appliers; a zero-dependency `src/validation.ts` boundary guard set for
  RCON/Lua/HTTP/agent payloads; type-aware ESLint with a fast versioned
  pre-commit hook (`npm run hooks:install`); a coverage threshold gate
  (`npm run coverage`, 82 % lines / 78 % branches / 84 % functions) wired into
  CI; a manual self-hosted Windows `Live selftest` workflow; and semver release
  automation (`npm run release`, CHANGELOG section + compare links + annotated
  tag).
- **Engineering hardening round 2.** `src/server.ts` finished its decomposition
  (2221 → 679 lines): request plumbing, static serving and the route matcher moved
  to `src/http/`, and every endpoint group (`src/api/agent.ts`, `jobs.ts`, `runs.ts`,
  `saves.ts`, `server.ts`, `manager.ts`) now registers through an injected
  `ApiContext` — 43/43 routes preserved, live manager smoke verified. Remaining
  `any` usages outside the API handlers were replaced with `unknown` +
  `src/validation.ts` guards and typed domain interfaces. The API handlers were then typed
  as well (explicit request/response interfaces + `parseBuildRequests`/`normalize*` helpers),
  taking the repo from 178 to **0** `no-explicit-any` warnings; Node suite is now 221 tests
  with the coverage gate at ~83.7/84.7/87.3 (thresholds 82/78/84).
- **UI and recording.** A compact, English/Simplified-Chinese transcript
  status bar (state/activity/time/tokens, current subtask and done condition,
  six subtask scores, collapse for narrow windows); OpenCode reasoning
  captured to `thoughts.log`/`thoughts.txt` with a Windows System.Speech
  narration script; and `scripts/game-status.py` plus docs for on-demand
  observation while a run is active.

### Changed

- **OpenCode is the default agent** for CLI, dashboard, and API runs (model
  `opencode-go/deepseek-v4.1-flash`); Codex remains available behind
  `--agent codex`, and the control mod now targets Factorio 2.1.
- **Agents wait less and report it.** Agent prompts ban long shell sleeps and
  require batched tool calls; the status bar shows thinking/idle seconds; and
  telemetry/status prefer current research while flagging a plan older than
  10 minutes as stale.

### Fixed

- **Factorio 2.1 compatibility:** recipes read `recipe.categories` (with the
  2.0 fallback) and ingredient/product types; technologies expose
  level/max_level/upgrade/trigger and upgrades of already-researched techs can
  be researched; empty upgrade/trigger research lists are normalized.
- **Walking and placement:** native walking measures progress against the
  current path waypoint so a character sliding along a tree is detected as
  stuck; builds no longer walk the character to a staging tile when the
  intended center is already in range; long actions dispatch over plain
  `node:http` so they fail on their own terms instead of as `fetch failed`.
- **Stale plans are no longer trusted silently:** the status header shows
  fresh research instead of an old blocked label, and `observe-factory.plan`
  exposes staleness/age/research/remaining so the agent can update `STATE.md`.

[Unreleased]: https://github.com/ryanmadden/autorio/compare/v0.11.0...HEAD
[0.11.0]: https://github.com/ryanmadden/autorio/compare/v0.10.6...v0.11.0
[0.10.6]: https://github.com/ryanmadden/autorio/compare/v0.10.5...v0.10.6
[0.10.5]: https://github.com/ryanmadden/autorio/compare/v0.10.4...v0.10.5
[0.10.4]: https://github.com/ryanmadden/autorio/compare/v0.10.3...v0.10.4
[0.10.3]: https://github.com/ryanmadden/autorio/compare/v0.10.2...v0.10.3
[0.10.2]: https://github.com/ryanmadden/autorio/compare/v0.10.1...v0.10.2
[0.10.1]: https://github.com/ryanmadden/autorio/compare/v0.10.0...v0.10.1
[0.10.0]: https://github.com/ryanmadden/autorio/compare/v0.9.0...v0.10.0
[0.9.0]: https://github.com/ryanmadden/autorio/compare/v0.8.0...v0.9.0
[0.8.0]: https://github.com/ryanmadden/autorio/compare/v0.7.1...v0.8.0
[0.7.1]: https://github.com/ryanmadden/autorio/compare/v0.7.0...v0.7.1
[0.7.0]: https://github.com/ryanmadden/autorio/compare/v0.6.0...v0.7.0
[0.6.0]: https://github.com/ryanmadden/autorio/compare/v0.5.0...v0.6.0
[0.5.0]: https://github.com/ryanmadden/autorio/compare/v0.4.0...v0.5.0
[0.4.0]: https://github.com/ryanmadden/autorio/compare/v0.3.0...v0.4.0
[0.3.0]: https://github.com/ryanmadden/autorio/compare/v0.2.1...v0.3.0
[0.2.1]: https://github.com/ryanmadden/autorio/compare/v0.2.0...v0.2.1
[0.2.0]: https://github.com/ryanmadden/autorio/compare/9e4e677...v0.2.0
