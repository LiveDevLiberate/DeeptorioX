# AGENTS.md

## Project summary
- Node/TypeScript service (macOS and Windows) that launches the full graphical Factorio game as a local multiplayer host, exposes a JSON gameplay API, and manages benchmark runs.
- Agents use the importable Python client (`factorio.py`). `./autorio` (or `autorio.cmd` on Windows) launches and monitors agent runs: OpenCode by default, `--agent codex` for Codex, `--agent dsh` for the DeepSeek Harness headless profile.
- `src/platform.ts`: cross-platform executable/process/path helpers (PATHEXT, `.cmd` shims, `taskkill`, Steam detection, browser discovery).
- `src/opencode.ts`: OpenCode executable/model resolution, native-vs-WSL transport, WSL paths and shell quoting; `src/runs.ts` translates OpenCode JSON events into the transcript schema.
- `src/dsh.ts`: DeepSeek Harness headless backend (`--agent dsh`): CLI/credential/model resolution, per-run model patch, `play.cmd`/`play.ps1`/`play.sh` wrappers, and the headless JSON event translator.
- `autorio_gym.py`, `autorio_types.py`, `autorio_trajectory.py`: duck-typed Gym-style `FactorioEnv` (reset/step/observe/close), typed observation dataclasses, and a SQLite episode/step trajectory store.
- `src/mcp-server.ts`: dependency-free MCP stdio server exposing observations and action jobs to MCP clients.
- `src/vision.ts`, `scripts/capture-window.ps1`: Windows game-window screenshot observation (`POST /api/agent/observe/visual`).
- `scripts/cluster.mjs`, `scripts/cluster-lib.mjs`: multi-instance evaluation cluster (isolated manager/RCON/game ports and data dirs, parallel benchmark runs, no Docker).

## Key paths
- `src/server.ts`: HTTP API + Factorio process management + RCON bridge; `observe-factory` aggregates power/fuel/entity status.
- `public/index.html`, `public/runs.js`: run launch controls, live progress, and run history.
- `public/run.html`, `public/run.js`: run details, activity, production graphs, results, and the per-run agent blueprint catalogue; `src/blueprints.ts` / `src/run-blueprints.ts` decode and store blueprint strings.
- `public/compare.html`, `public/compare.js`: comparisons of selected historical runs.
- `src/runtime.ts`: installation/configuration, isolated profiles, and map creation on macOS and Windows.
- `factorio-mod/autorio-control/control.lua`, `src/native-control.ts`: native character control, pathfinding, mining, polling and cancellation.
- `src/runs.ts`, `src/benchmarks.ts`: run lifecycle, Codex process, telemetry, science research milestones and scoring.
- `src/obs-client.ts`, `src/obs.ts`: authenticated localhost OBS v5 control and run-owned two-window capture.
- `native/timelapse.swift`, `src/timelapse.ts`: 5 fps → 30 fps silent MP4 conversion via AVFoundation (macOS) or FFmpeg (Windows).
- `src/run-labels.ts`: Pacific local run timestamps and combined model/thinking labels.
- `scripts/narrate.ps1`, run `thoughts.log`/`thoughts.txt`/`thoughts.digest.log`: Windows TTS narration of OpenCode reasoning for livestreams (`-Digest` reads the condensed digest stream).
- `src/token-usage.ts`: session-scoped Codex token-log fallback; counters may be last-reported rather than final.
- `public/production-chart.js`: production graphs and science research annotations in the dashboard.
- `src/run-cli.ts`, `autorio`: run CLI and Node discovery/build wrapper.
- `native/recording-window.swift`, `src/recording-window.ts`: standalone recording window (WKWebView via Swift on macOS, Chromium app mode on Windows) that watches run.json and closes two seconds after a terminal run state; no Accessibility permission or automatic window arrangement.
- `src/run-terminal.ts`, `src/terminal-view.ts`: Terminal (macOS) or a dedicated console window (Windows) running a direct viewer of native `codex exec` output, with no custom banner or interactive shell.
- `benchmarks/*.json`: versioned seed, task, inventory, limits and milestone definitions.
- `runs/run_template/{AGENTS.md,COOKBOOK.md}`: the run playbook (subtask loop, scoring, discipline) and the design cookbook (layouts, observation checklists, error-recovery matrix), copied into every run workspace and referenced by the agent prompt.
- `docs/architecture.md`, `CONTRIBUTING.md`, `CHANGELOG.md`: architecture, contribution workflow/quality gates, and release history.
- `.github/workflows/ci.yml`: CI matrix (Ubuntu Node 20, Windows Node 24) running build, Node/Python tests, repo hygiene and Prettier check.
- `src/logger.ts`, `src/health.ts`: structured JSONL logging + `GET /api/health`.
- `src/action-jobs.ts`: serialized action-job queue (statuses, progress, idempotency keys, one-hour retention, internal loopback dispatch) extracted from `server.ts`.
- `src/agents/opencode-events.ts`, `src/agents/codex-events.ts`: pure agent-JSONL → transcript translators and applier types (no fs/net); launch specifications live in `src/agents/*-launch.ts`.
- `src/validation.ts`: zero-dependency guards for RCON/Lua/HTTP/agent `unknown` payloads (`asRecord`, `parseJsonObject`, `arrayOf`, `invalidFields`, …); use these at dynamic boundaries instead of `: any`.
- `eslint.config.mjs`: type-aware ESLint config (`no-floating-promises`/`no-misused-promises` as errors, `no-explicit-any` as warning).
- `scripts/coverage-gate.mjs`, `scripts/release.mjs`, `scripts/install-hooks.mjs`, `.githooks/pre-commit`: coverage thresholds, semver/CHANGELOG/tag automation, and the fast pre-commit hook.
- `.github/workflows/live-selftest.yml`, `scripts/ci-live-selftest.ps1`: manual self-hosted Windows live selftest (Steam + real game required).
- `scripts/check-repo.mjs`, `scripts/package.mjs`: repository hygiene gate and reproducible release packaging.
- `public/icons/`: game-icons.net SVGs (CC BY 3.0) used as CSS masks by the recording window; keep `ATTRIBUTION.md` in sync when adding/removing icons.
- `public/recording.html`, `public/runs.css` + `public/styles/`: recording page and ordered styling modules (`tokens`/`base`/`recording`/`dashboard`/`recording-modern`); `public/recording.js`, `public/transcript-view-model.js` render the live transcript (collapsed reasoning summaries, action/result rows, loop badges, turn dividers, unread pill, filters/search, telemetry metrics/markers, `?overlay=1`), `public/codex-transcript.js` groups structured Codex events; `public/codex-output.js` supports older native logs.
- `.autorio/`: ignored baselines, profiles, saves, run results, logs, and credentials.
- Default game: Steam `factorio.app/Contents/MacOS/factorio` (macOS) or `...\steamapps\common\Factorio\bin\x64\factorio.exe` (Windows, auto-detected across Steam libraries).
- `dist/`: Build output (including `dist/server.js`, `dist/run-cli.js`).
- `RUN_REPORT.md`: Known issues / proposed improvements from an AI playthrough.

## Common commands
- `npm run dev`: Run the server in watch mode (tsx).
- `npm run build`: Compile TypeScript to `dist/`.
- `npm run verify`: Full local gate — build, Node tests, Python client tests, repository hygiene, Prettier and ESLint. Run this before committing (the coverage gate is a separate CI step).
- `npm test`: Build, Node lifecycle tests with fake processes, and Python client tests.
- `npm run test:node` / `npm run test:python`: Run one half of the suite.
- `npm run test:coverage`: Node's built-in coverage report for the Node tests.
- `npm run coverage`: coverage gate — fails below 82% lines / 78% branches / 84% functions (`scripts/coverage-gate.mjs`; `--lines/--branches/--functions` or `AUTORIO_COVERAGE_*` override).
- `npm run lint` / `npm run lint:fix`: type-aware ESLint across `src`, tests, scripts and browser JS; `no-explicit-any` is a warning until the dynamic boundaries are fully typed.
- `npm run hooks:install` / `npm run hooks:check`: install/verify the fast pre-commit gate (`.githooks/pre-commit` runs check:repo, format:check, typecheck; `AUTORIO_SKIP_HOOKS=1` bypasses).
- `npm run release -- <major|minor|patch|X.Y.Z>`: bump package + lock versions, move the CHANGELOG Unreleased section into a dated release, commit and create an annotated tag (`--dry-run` first; clean tree required).
- `npm run format` / `npm run format:check`: Prettier write/check over `src`, `public` JS/CSS, `tests`, `scripts`, package metadata and CI files (markdown/HTML/Lua are excluded).
- `npm run check:repo`: Zero-dependency repository hygiene gate (scripts/engines, strict TS, LF endings, no focused tests, no stray `console.log`, no tracked build artifacts/secrets).
- `npm run package`: Reproducible release artifacts (cumulative patch + `git archive` zip + sha256) into the repo parent directory; `--out`, `--base`, `--name` override the defaults.
- `npm run start`: Run compiled server (`dist/server.js`).
- `./autorio start smoke` (Windows: `autorio.cmd start smoke`): Build if needed, start manager, open graphical game, run Codex and watch progress.
- `./autorio start automation --model MODEL`: Run a factory task.
- `./autorio start smoke --manual --detach`: Prepare a game and telemetry without Codex.
- `./autorio list|show|watch|stop|compare`: Inspect or control runs (see `./autorio --help`).
- `npm run cluster -- <start|status|run|stop|logs>`: Manage isolated manager+game instances for parallel evaluation (see README "Parallel evaluation cluster").
- `npm run mcp`: Serve the gameplay API to MCP clients over stdio (build first).

## Environment/config
- `.env` is loaded if present; process environment wins. See `.env.example` and README.
- `FACTORIO_BIN`, `FACTORIO_DATA`: full game executable and data directory (platform defaults; override in `.env`).
- `AUTORIO_DATA_DIR` defaults to `.autorio`; `AUTORIO_PORT` defaults to 3000.
- RCON is localhost only; `RCON_PORT` defaults to 27015; password is generated/stored if omitted. `AUTORIO_GAME_PORT` defaults to 34197 and is set per cluster instance.
- `AUTORIO_LOG_LEVEL` (`debug|info|warn|error`, default `info`) selects the structured log level. Logs are JSONL in `<data-dir>/manager.log` with a human mirror on stderr; health polls are excluded from request logs. Never interpolate credentials into messages — add context objects and let the logger redact secret-looking keys.
- `AUTORIO_STATE_RESUME_GRACE_SECONDS` (default 120) grants a post-resume grace before an old plan blocks actions; `AUTORIO_STATE_NUDGE_RESTART_SECONDS` (default 0 = disabled) restarts the agent once with the same session to refresh a long-blocked plan. `AUTORIO_AUTO_RESUME=1` opts into resuming the newest interrupted run at manager startup. `AUTORIO_AUTO_CONTINUE_MAX` (default 3, 0 disables) controls automatic same-session continuation after a clean early agent exit; failed runs with a current checkpoint remain retryable, and exhausted continuations pause the run instead of failing it. `AUTORIO_STATE_SOFT_SECONDS`/`AUTORIO_STATE_HARD_SECONDS` control the STATE.md nudge/block deadlines.
- Agent runs open the web recording view in a standalone window (WKWebView on macOS, Edge/Chrome app mode on Windows) by default; `--terminal` or `AUTORIO_TERMINAL=1` opts into the Terminal viewer. `--detach` skips opening the browser; `--watch` follows operator logs.
- OpenCode is the default agent (`opencode run --format json --model provider/model --auto`); `AUTORIO_OPENCODE_MODEL`, `OPENCODE_BIN`, `AUTORIO_WSL_DISTRO`, and `AUTORIO_WSL_OPENCODE` configure it. On Windows without a native CLI, runs are launched through `wsl.exe`.
- `--agent codex` switches to Codex (`codex exec`); `CODEX_BIN` and `AUTORIO_CODEX_*` configure that path.
- `--agent dsh` runs the DeepSeek Harness headless profile (`dsh --profile headless --json`, task over stdin); `DSH_BIN`, `DSH_HOME`, `AUTORIO_DSH_PROFILE`, `AUTORIO_DSH_PROVIDER`, `AUTORIO_DSH_MODEL`, `AUTORIO_DSH_REASONING_EFFORT` configure it. Headless needs `DEEPSEEK_API_KEY` (environment/`.env`, or the plaintext `refs` entry in `$DSH_HOME/.credentials.yaml`). On Windows the agent shell is Windows PowerShell and gameplay goes through the generated `play.cmd` (Windows Python) with `play.ps1`/`play.sh` as the WSL fallback; the headless sandbox may deny `wsl.exe`, so keep the Windows Python path working. Do not edit the DSH profile to change models; autorio passes a `--patch` overlay.
- `FACTORIO_API_BASE` overrides the Python client API address.
- Steam must be running and signed in for graphical Steam builds.

## API + CLI surface (high level)
- Server endpoints include:
  - `GET /api/server/status`, `POST /api/server/start`, `POST /api/server/stop`
  - `GET /api/health`: 200 when all probes pass, 503 `degraded` with a `problems` list otherwise
  - `GET /api/saves`, `GET /api/server/logs`, `POST /api/rcon/command`
  - Agent endpoints under `/api/agent/...` for observe/actions (world, player, research, recipes, build, mine, rotate, set-recipe, craft, insert, extract, resources, entity-prototype).
  - Agent capability endpoints: `POST /api/agent/observe/production` (per-minute rates from the manager's independent sampler), `/observe/fluids`, `/observe/combat`, `/observe/area` (deconstruction planning), `/observe/copy-settings` (dry-run) and `/act/copy-settings` (synchronous reach-checked settings paste). The telemetry sampler runs every 5 s while RCON is connected and is independent of benchmark runs.
  - Map overview: `POST /api/agent/observe/map-overview` returns a compact downsampled ASCII map of player-charted chunks (`rows` + legend; radius ≤1024, cells ≤160). Python `observe_map_overview()` / CLI `observe-map-overview`.
  - Tool-usage stats: `GET /api/tool-calls` (active run) / `GET /api/runs/:id/tool-calls` return per-endpoint agent call counts; recorded run page/recording Tools buttons.
  - Run budget: `POST /api/runs/:id/extend` (`{"seconds": N}`) extends a paused run's wall-clock limit before resume.
  - Entity usage: `POST /api/agent/observe/entity-usage` returns curated one-way flow/placement/common-mistake rules plus prototype metadata; Python `entity_usage(name)` / CLI `entity-usage`.
  - Descriptions: `POST /api/agent/observe/description` resolves an entity/technology `localised_description` in the current game locale (raw LocalisedString + rendered text; missing translations are flagged). Python `describe(name, kind=...)` / CLI `describe`.
- CLI mirrors these as commands like `server-status`, `observe-world`, `act-build`, etc. See `python3 factorio.py --help` for commands. Client helpers include `observe_snapshot`, `observe_production/fluids/combat/area`, `copy_settings`, `build_blueprint`, `build_underground_belt_line`/`build_underground_pipe_line`, `deconstruct_area` (observe area -> native-mining batches) and the `build-*`/`deconstruct-area` CLI commands.

## Notes and known gaps
- `RUN_REPORT.md` is historical; many listed gaps have already been addressed.
- Milestones use polling (first-observed timestamps); production includes handcrafting and machines.
- Native `/sc` build commands take `{name, anchor, direction?}` per entity; `underground-belt` and
  `pipe-to-ground` additionally accept `underground_type: "input" | "output"`. The regular path uses
  the player cursor (`build_from_cursor`); the underground path validates reach/collision, creates
  the entity with the explicit subtype and consumes the place item (`create_entity` +
  `remove_item`). Pure builders live in `src/command-builders.ts`; keep the cursor path for
  normal entities so items/costs behave exactly like a player build.
- `factorio-mod/autorio-control` drives native walking/pathfinding and mining each tick. Keep action cancellation, a short heartbeat lease, neutral controls on save reload, sidestep avoidance, and tree/rock clearing when the character is blocked. No teleport or fixed-delay fallback.
- The API is a cooperative evaluation interface, not isolation against hostile agents.
- Quota-exhausted runs become paused and can resume manually from their checkpoint and Codex session. Segments retain separate saves/videos; active time and scoring accumulate, excluding quota waits and game loading. Forced interruptions are not automatically resumed. One active game/run at a time.
- Tests should verify lifecycle and scoring behavior, not require real Codex or Factorio launches.
- Thinking-window changes stay in `public/`: keep heuristics in the DOM-free `public/transcript-view-model.js` and test them with `node:test` (`tests/transcript-view-model.test.mjs`, `tests/recording-page.test.mjs`). Both the events mode and the legacy native log mode must keep rendering. The manager also writes `thoughts.digest.log` for TTS; raw `thoughts.log` must stay byte-identical.

## Local assumptions
- Windows support: process statistics use `Get-Process` via PowerShell; macOS uses `ps`. Keep platform branches in `src/platform.ts`.
- Windows tests run fake executables through `.cmd` shims; use `spawnExecutable`/`execExecutable` for spawned tools so shims work.
- Managed runs generate their own baseline saves; manual saves used by diagnostic API endpoints live under `.autorio/saves/`.
- Keep generated game profiles separate from personal Factorio configuration and saves.
- Prefer a compiled manager for recordings; watch-mode restarts stop active runs.
