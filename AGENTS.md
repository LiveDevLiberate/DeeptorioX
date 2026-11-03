# AGENTS.md

## Project summary
- Node/TypeScript service (macOS and Windows) that launches the full graphical Factorio game as a local multiplayer host, exposes a JSON gameplay API, and manages benchmark runs.
- Agents use the importable Python client (`factorio.py`). `./autorio` (or `autorio.cmd` on Windows) launches and monitors OpenCode runs (Codex remains available with `--agent codex`).
- `src/platform.ts`: cross-platform executable/process/path helpers (PATHEXT, `.cmd` shims, `taskkill`, Steam detection, browser discovery).
- `src/opencode.ts`: OpenCode executable/model resolution, native-vs-WSL transport, WSL paths and shell quoting; `src/runs.ts` translates OpenCode JSON events into the transcript schema.

## Key paths
- `src/server.ts`: HTTP API + Factorio process management + RCON bridge.
- `public/index.html`, `public/runs.js`: run launch controls, live progress, and run history.
- `public/run.html`, `public/run.js`: run details, activity, production graphs, and results.
- `public/compare.html`, `public/compare.js`: comparisons of selected historical runs.
- `src/runtime.ts`: installation/configuration, isolated profiles, and map creation on macOS and Windows.
- `factorio-mod/autorio-control/control.lua`, `src/native-control.ts`: native character control, pathfinding, mining, polling and cancellation.
- `src/runs.ts`, `src/benchmarks.ts`: run lifecycle, Codex process, telemetry, science research milestones and scoring.
- `src/obs-client.ts`, `src/obs.ts`: authenticated localhost OBS v5 control and run-owned two-window capture.
- `native/timelapse.swift`, `src/timelapse.ts`: 5 fps → 30 fps silent MP4 conversion via AVFoundation (macOS) or FFmpeg (Windows).
- `src/run-labels.ts`: Pacific local run timestamps and combined model/thinking labels.
- `scripts/narrate.ps1`, run `thoughts.log`/`thoughts.txt`: Windows TTS narration of OpenCode reasoning for livestreams.
- `src/token-usage.ts`: session-scoped Codex token-log fallback; counters may be last-reported rather than final.
- `public/production-chart.js`: production graphs and science research annotations in the dashboard.
- `src/run-cli.ts`, `autorio`: run CLI and Node discovery/build wrapper.
- `native/recording-window.swift`, `src/recording-window.ts`: standalone recording window (WKWebView via Swift on macOS, Chromium app mode on Windows) that watches run.json and closes two seconds after a terminal run state; no Accessibility permission or automatic window arrangement.
- `src/run-terminal.ts`, `src/terminal-view.ts`: Terminal (macOS) or a dedicated console window (Windows) running a direct viewer of native `codex exec` output, with no custom banner or interactive shell.
- `benchmarks/*.json`: versioned seed, task, inventory, limits and milestone definitions.
- `public/recording.html`, `public/runs.css`: recording page and shared styling; `public/recording.js`, `public/codex-transcript.js` render structured Codex events as messages and collapsed command groups; `public/codex-output.js` supports older native logs.
- `.autorio/`: ignored baselines, profiles, saves, run results, logs, and credentials.
- Default game: Steam `factorio.app/Contents/MacOS/factorio` (macOS) or `...\steamapps\common\Factorio\bin\x64\factorio.exe` (Windows, auto-detected across Steam libraries).
- `dist/`: Build output (including `dist/server.js`, `dist/run-cli.js`).
- `RUN_REPORT.md`: Known issues / proposed improvements from an AI playthrough.

## Common commands
- `npm run dev`: Run the server in watch mode (tsx).
- `npm run build`: Compile TypeScript to `dist/`.
- `npm run start`: Run compiled server (`dist/server.js`).
- `./autorio start smoke` (Windows: `autorio.cmd start smoke`): Build if needed, start manager, open graphical game, run Codex and watch progress.
- `./autorio start automation --model MODEL`: Run a factory task.
- `./autorio start smoke --manual --detach`: Prepare a game and telemetry without Codex.
- `./autorio list|show|watch|stop|compare`: Inspect or control runs (see `./autorio --help`).
- `npm test`: Build, Node lifecycle tests with fake processes, and Python client tests.

## Environment/config
- `.env` is loaded if present; process environment wins. See `.env.example` and README.
- `FACTORIO_BIN`, `FACTORIO_DATA`: full game executable and data directory (platform defaults; override in `.env`).
- `AUTORIO_DATA_DIR` defaults to `.autorio`; `AUTORIO_PORT` defaults to 3000.
- RCON is localhost only; `RCON_PORT` defaults to 27015; password is generated/stored if omitted.
- Agent runs open the web recording view in a standalone window (WKWebView on macOS, Edge/Chrome app mode on Windows) by default; `--terminal` or `AUTORIO_TERMINAL=1` opts into the Terminal viewer. `--detach` skips opening the browser; `--watch` follows operator logs.
- OpenCode is the default agent (`opencode run --format json --model provider/model --auto`); `AUTORIO_OPENCODE_MODEL`, `OPENCODE_BIN`, `AUTORIO_WSL_DISTRO`, and `AUTORIO_WSL_OPENCODE` configure it. On Windows without a native CLI, runs are launched through `wsl.exe`.
- `--agent codex` switches to Codex (`codex exec`); `CODEX_BIN` and `AUTORIO_CODEX_*` configure that path.
- `FACTORIO_API_BASE` overrides the Python client API address.
- Steam must be running and signed in for graphical Steam builds.

## API + CLI surface (high level)
- Server endpoints include:
  - `GET /api/server/status`, `POST /api/server/start`, `POST /api/server/stop`
  - `GET /api/saves`, `GET /api/server/logs`, `POST /api/rcon/command`
  - Agent endpoints under `/api/agent/...` for observe/actions (world, player, research, recipes, build, mine, rotate, set-recipe, craft, insert, extract, resources, entity-prototype).
- CLI mirrors these as commands like `server-status`, `observe-world`, `act-build`, etc. See `python3 factorio.py --help` for commands.

## Notes and known gaps
- `RUN_REPORT.md` is historical; many listed gaps have already been addressed.
- Milestones use polling (first-observed timestamps); production includes handcrafting and machines.
- `factorio-mod/autorio-control` drives native walking/pathfinding and mining each tick. Keep action cancellation, a short heartbeat lease, neutral controls on save reload, sidestep avoidance, and tree/rock clearing when the character is blocked. No teleport or fixed-delay fallback.
- The API is a cooperative evaluation interface, not isolation against hostile agents.
- Quota-exhausted runs become paused and can resume manually from their checkpoint and Codex session. Segments retain separate saves/videos; active time and scoring accumulate, excluding quota waits and game loading. Forced interruptions are not automatically resumed. One active game/run at a time.
- Tests should verify lifecycle and scoring behavior, not require real Codex or Factorio launches.

## Local assumptions
- Windows support: process statistics use `Get-Process` via PowerShell; macOS uses `ps`. Keep platform branches in `src/platform.ts`.
- Windows tests run fake executables through `.cmd` shims; use `spawnExecutable`/`execExecutable` for spawned tools so shims work.
- Managed runs generate their own baseline saves; manual saves used by diagnostic API endpoints live under `.autorio/saves/`.
- Keep generated game profiles separate from personal Factorio configuration and saves.
- Prefer a compiled manager for recordings; watch-mode restarts stop active runs.
