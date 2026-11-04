# Changelog

All notable changes to autorio are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project aims to follow [Semantic Versioning](https://semver.org/). The
package is still versioned `0.1.0` and has no release tags yet; history before
commit `9e4e677` predates this file.

## [Unreleased]

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

[Unreleased]: https://github.com/ryanmadden/autorio/compare/9e4e677...HEAD
