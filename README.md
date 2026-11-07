# autorio

A macOS and Windows scaffold for running visible Factorio games, launching
OpenCode, Codex or DeepSeek Harness (DSH) agents through an importable Python
library, and recording comparable playthroughs.
The full game hosts a private local multiplayer session, providing both the player
character and RCON in one graphical process. No second computer or dedicated-server
installation is required. OBS can automatically capture run timelapses (see below).

## Contents

- [First run](#first-run)
- [Checking game state while a run is active](#checking-game-state-while-a-run-is-active)
- [Narrating agent thoughts (TTS)](#narrating-agent-thoughts-tts)
- [Benchmarks and results](#benchmarks-and-results)
- [Configuration](#configuration)
- [Parallel evaluation cluster](#parallel-evaluation-cluster)
- [Development and APIs](#development-and-apis)
- [Vanilla-compatible evaluation controls](#vanilla-compatible-evaluation-controls)
- [Coordinates](#coordinates)
- [Action jobs](#action-jobs)
- [MCP server](#mcp-server)
- [Visual observation (game-window screenshot)](#visual-observation-game-window-screenshot)
- [Gym-style environment and trajectory database](#gym-style-environment-and-trajectory-database)
- [Planning and observation](#planning-and-observation)
- [Token accounting and science research](#token-accounting-and-science-research)
- [Run names and thinking levels](#run-names-and-thinking-levels)
- [Automatic OBS timelapses](#automatic-obs-timelapses)
- [Pausing to change code or mods](#pausing-to-change-code-or-mods)
- [Context limit and session restart](#context-limit-and-session-restart)
- [Quota pauses and continuing a run](#quota-pauses-and-continuing-a-run)

## First run

Requirements: the full Factorio game (tested with Steam 2.0.77 on macOS and
2.1.24 on Windows), Node.js 20+, Python 3, and an OpenCode v2 CLI (or a
logged-in Codex CLI when using `--agent codex`, or a local DeepSeek Harness
install when using `--agent dsh`). Open Steam and sign in before
launching a game. The demo is not supported.

```bash
npm ci
npm run build
./autorio start smoke        # macOS/Linux
autorio.cmd start smoke      # Windows (PowerShell or cmd.exe)
```

`./autorio` (or `autorio.cmd` on Windows) finds Node on PATH, in standard
install locations, or in the bundled Codex runtime on this machine. On Windows,
`autorio.cmd` delegates to `autorio.ps1`, so no execution-policy change is needed.
It rebuilds changed TypeScript automatically. You can also use
`npm run run -- start smoke` after building. The manager starts automatically and
remains available after the run. `./autorio shutdown` stops an active run and
closes the manager; use it before restarting with changed code.

### Windows notes

- Run commands from PowerShell or `cmd.exe` as `autorio.cmd start smoke`
  (`.\autorio.cmd` also works in PowerShell). `npm run` and `python factorio.py`
  work unchanged. Run `npm run doctor` to check Factorio, the agent CLI, Python,
  the recording browser, and optional video prerequisites.
- Runs use OpenCode by default. On native Windows install OpenCode v2 (for
  example `scoop install opencode`) and make sure `opencode` is on PATH. If
  OpenCode lives in WSL, as recommended by its Windows docs, autorio calls it
  through `wsl.exe`; set `AUTORIO_WSL_DISTRO` and `AUTORIO_WSL_OPENCODE` if your
  distro or binary path differs. The default model is
  `opencode-go/deepseek-v4.1-flash`.
- `--agent codex` opts into Codex instead; install the Codex CLI, run
  `codex login` once, and set `CODEX_BIN` if it is not on PATH.
- The Steam, GOG, and standalone install locations under
  `C:\Program Files (x86)\Steam\steamapps\common\Factorio\bin\x64\factorio.exe`
  (and additional Steam library folders) are detected automatically. If your
  install is elsewhere, set `FACTORIO_BIN` in `.env`.
- The recording view opens in a Chromium app-mode window (Edge or Chrome) titled
  **Agent transcript**, isolated by its own browser profile. It closes two seconds
  after the run ends. Set `AUTORIO_BROWSER` to use a different Edge/Chrome build.
- `--terminal` opens a separate `cmd.exe` window running the same viewer; it
  closes when the run ends.
- Processes are stopped with `taskkill /T`, and a WSL OpenCode agent is also
  terminated inside its distro, so neither Factorio nor the agent survives a
  stopped run.
- Codex's Windows sandbox blocks all command execution; with `--agent codex`,
  use `AUTORIO_CODEX_SANDBOX=workspace-write` plus
  `windows.sandbox="unelevated"`, or `danger-full-access`. OpenCode runs with its
  own `--auto` permission mode.
- Windows Firewall can block loopback; allow Node.js/`factorio.exe` on private
  networks if RCON or the dashboard cannot connect.
- Automatic OBS timelapses work through OBS WebSocket with `window_capture`
  sources. Conversion to the 6× MP4 uses FFmpeg instead of AVFoundation:
  install it (`winget install Gyan.FFmpeg`) or set `FFMPEG_BIN`/`FFPROBE_BIN`.
  Without FFmpeg, `--video` runs fail at conversion; leave video off otherwise.
- Tests: `npm test` builds the TypeScript, runs the lifecycle tests (fake
  processes use `.cmd` shims on Windows), and discovers Python 3 through `py -3`
  or `python`. Python examples below use `python3`; on Windows use `python`.


The smoke benchmark asks the agent to craft one gear. It verifies the entire launch,
Python action, production recording, final-save, and shutdown path. For a real
factory task or the full game:

```bash
./autorio start automation --model YOUR_MODEL
./autorio start rocket --model YOUR_MODEL --seconds 28800
./autorio start smoke --manual --detach
./autorio list
./autorio watch RUN_ID
./autorio stop RUN_ID
./autorio compare RUN_ID RUN_ID
./autorio shutdown
```

Use an explicit model for comparisons. With no `--model`, OpenCode uses
`AUTORIO_OPENCODE_MODEL` (default `opencode-go/deepseek-v4.1-flash`). The runner
launches `opencode run --format json --model PROVIDER/MODEL --auto` in the run
workspace and translates its JSON events into the same transcript used by the
dashboard. Set `OPENCODE_BIN` to choose a native CLI; on Windows without a
native CLI, `AUTORIO_WSL_DISTRO`/`AUTORIO_WSL_OPENCODE` select the WSL CLI.
With `--agent codex`, the runner instead uses `codex exec` with
`--ignore-user-config` and the configured sandbox.

Agent runs open the web recording view by default. It shows agent messages and
reasoning as collapsed blocks with a one-line summary (only the newest two stay
expanded; identical consecutive thoughts collapse into a “repeated ×N” badge).
Commands are summarized as action rows (category badge, target and result, e.g.
`mine (129,-26) · 2/2 ok · mined 2 · +2 wood · 1.4s`), grouped with category counters
(`12 build · 3 mine · 1 failed`); repeated identical actions raise a “loop? ×N”
warning. Raw command and output stay behind an expandable row, and other tools
are shown as a label + detail instead of raw JSON. Turn separators, relative
timestamps for live events, and a floating “N new ↓” button (auto-follow pauses
when you scroll up) make long runs easier to follow. A toolbar filters by
Thinking/Actions/Messages/Errors/Decisions and searches the transcript; the
choice is remembered. The header also shows production rates from telemetry
(with a mini sparkline), power satisfaction (electric networks around the
player), research progress, the latest failure, elapsed time and
tokens, the current subtask with its done condition, and six subtask scores from
`STATE.md`. Labels switch between English and Simplified Chinese from the run's
language, and the header collapses for narrow windows. Icons in the transcript are from
[game-icons.net](https://game-icons.net/) (CC BY 3.0; see
`public/icons/ATTRIBUTION.md`). Add `&overlay=1` to the
recording URL for an OBS-friendly transparent/large-text overlay (hides the
filter bar, scores and raw rows).
The standalone recording window
automatically closes two seconds after completion, failure, stop, timeout, or interruption.
The manager opens a dedicated window containing the web recording view (a native
window on macOS, an Edge/Chrome app window on Windows), with no browser tabs or
address bar. Both dashboard and CLI launches use it. Its **Agent transcript** header also shows a compact live status: run state,
current activity (Thinking/Acting/Idle), elapsed time and tokens, the current
subtask with its done condition, and six subtask scores from `STATE.md`. Labels
switch between English and Simplified Chinese from the run's language, and the
header collapses for narrow windows.
Closing it manually does not stop the run. You can reopen saved output using
the dashboard’s Recording view link, which stays open in the browser.
`--detach` prints the URL without opening a window; `--watch` follows operator logs here.

Exact structured output is saved in `agent.events.jsonl`; separate
`agent.stdout.log` and `agent.stderr.log` files are also retained. Older saved runs
keep their original display. Closing the view does not stop the benchmark.
Use `./autorio stop RUN_ID` to stop it.

Use `--terminal` (or `AUTORIO_TERMINAL=1`) for the optional terminal viewer.
This CLI-only mode uses native human output,
saved verbatim in `codex.log`. That viewer runs directly without an
interactive shell and closes two seconds after the run ends. Default Terminal
settings and other windows are unaffected.

Ctrl-C while watching in the invoking terminal requests a stop and final save.
`--detach` leaves the run active. `--manual` prepares the same game and telemetry
without launching an agent; use `factorio.py` against the manager for debugging. A run ends when its
objective is independently observed, its time limit expires, the operator stops
it, or the agent/game/telemetry fails. An agent's success claim or zero exit code
alone does not count as completion. Runs do not automatically resume after a
manager restart; unfinished records become `interrupted`. Stop any surviving game
with `python3 factorio.py server-stop` (or `python factorio.py server-stop` on
Windows) before starting a replacement run.

Open [the runs dashboard](http://127.0.0.1:3000/) to launch runs and monitor the
current run's progress. Click a run in the history to open its Run Details page:
configuration, token counts, milestones, production graph, and live activity.
Select multiple history rows to compare runs on a separate page. Recording view
remains a compact, separate display. Old `/runs.html` bookmarks redirect to the
appropriate page. Position the game and recording window for OBS yourself.

Before launching a run, open **Map configuration** in the launch form to
customise map generation for the new run: seed, peaceful mode, starting area and
per-resource frequency/size/richness overrides. `Default` keeps Factorio's map
generation defaults and **Reset to benchmark** restores the selected benchmark's
values. The effective settings are sent as `map_gen` in `POST /api/runs`,
validated by the manager, stored with the run and used for baseline map
creation; the recording window's Map dialog shows the actual seed/resource
configuration.

## Checking game state while a run is active

The manager exposes the same read-only gameplay API the agent uses. Observations
are safe while a run is active, so there is no need to wait for the agent:

```bash
cd autorio
export FACTORIO_API_BASE=http://127.0.0.1:3000
python3 scripts/game-status.py        # run state, player, inventory, research, nearby buildings
python3 factorio.py observe-player
python3 factorio.py observe-research
python3 factorio.py observe-world --window-x 0 --window-y 0 --radius 45 --include entities
python3 factorio.py observe-resources --window-x 0 --window-y 0 --radius 60
python3 factorio.py observe-entity --target 10,12
curl -s http://127.0.0.1:3000/api/runs
```

On Windows the manager is reached through WSL's mirrored `127.0.0.1`. The
dashboard at `http://127.0.0.1:3000/` shows milestones, production graphs and
live activity.

## Narrating agent thoughts (TTS)

OpenCode is launched with `--thinking`, so its reasoning is saved as a plain
stream in the run directory:

```text
.autorio/runs/<run-id>/thoughts.log          # one reasoning text per line
.autorio/runs/<run-id>/thoughts.txt          # latest thought, useful for an OBS text source
.autorio/runs/<run-id>/thoughts.digest.log   # one condensed line per reasoning chunk (TTS-friendly)
.autorio/runs/<run-id>/thoughts.digest.txt   # latest digest line
```

Windows can speak those lines with the built-in System.Speech voices:

```powershell
cd C:\Users\Roger\autorio
.\scripts\narrate.ps1 -ListVoices
.\scripts\narrate.ps1                                # newest run, new thoughts only
.\scripts\narrate.ps1 -Digest                         # condensed decision-oriented lines
.\scripts\narrate.ps1 -Digest -MinChars 8             # short CJK digests
.\scripts\narrate.ps1 -RunId RUN_ID -Voice "Microsoft Zira Desktop"
.\scripts\narrate.ps1 -IncludeMessages                 # also speak agent messages
.\scripts\narrate.ps1 -FromStart -DryRun -Once          # test without audio
```

`-Digest` follows `thoughts.digest.log`: the manager emits one summarized line per
reasoning chunk (preferring plan/decision sentences, capped at 200 chars, skipping
consecutive duplicates). `-Dedupe` is on by default and skips repeated lines; use
`-NoDedupe` on hosts that cannot bind `-Dedupe:$false`. Older runs recorded before
the digest stream need the default raw mode.

The narrated text is also written to `narration.txt` for a subtitle overlay. If
agents write Chinese messages but reason in English, use
`-MessagesOnly -Voice "Microsoft Huihui Desktop"` to narrate the Chinese
messages only.
For OBS, add a **Text** source that reads `thoughts.txt` or `narration.txt`.
`Ctrl-C` stops narration without touching the game. Reasoning is in the model's
own language (DeepSeek V4.1 Flash currently thinks in English); select a voice
that matches, or add a translation step before TTS if you want Chinese audio.

## Benchmarks and results

`benchmarks/*.json` defines tasks, map generation settings and seed, explicit
starting items, daylight policy, time limits, sampling intervals, and milestones.
The initial profiles use base Factorio only (Space Age, Quality, and Elevated
Rails disabled), enemy-base generation disabled (peaceful mode retained as a
fallback), seed 424242, and permanent daylight set to noon. `smoke` is an
integration check; `automation` requires twenty new iron plates; `rocket` requires
an actual rocket launch. Production thresholds prove output, rather than a
particular factory design or sustained throughput.

The manager caches a baseline ZIP keyed by game version and map settings, then
copies it for each run. Startup is excluded from scoring. Wall-clock time begins
when the configured game is ready and the agent is launched. Both agent thinking
and API execution time count. Game ticks are recorded separately; the game runs
at speed 1. Milestone times are first-observed times, with precision bounded by
the benchmark's polling interval. Human input can affect a run: leave the game
alone while comparing agents. Pauses and performance changes remain visible in
the wall-clock/game-tick measurements.

Everything generated is ignored by Git under `.autorio/`:

```text
.autorio/
  baselines/<hash>/baseline.zip
  manager.log
  runs/<run-id>/
    run.json                  # state, result, versions, hashes, milestone/action counts
    SUMMARY.md                # readable independently verified result
    benchmark.json            # resolved task definition
    game.zip                  # untouched starting map
    final.zip                 # final checkpoint, when saving succeeds
    telemetry.jsonl           # ticks, production/consumption, rates, research, rockets
    jobs.jsonl                # submitted/completed actions and partial failures
    activity.log              # readable runner + agent activity
    codex.log                 # agent transcript (native Codex or OpenCode text)
    agent.stdout.log
    agent.stderr.log
    agent-launch.json         # exact arguments used
    profile/                  # isolated game config, mods, saves, diagnostics
    workspace/                # frozen Python client, instructions, TASK, agent scripts
```

Production rates are sample deltas per game minute. Statistics include
handcrafting as well as machines. Starting inventory does not count toward
production milestones. Comparisons show milestone times in seconds and ticks,
and warn when benchmark, baseline-save, or Python-client hashes differ. The
result also records a hash of the harness sources. Native session IDs are retained when
Codex prints them. Any printed token usage remains in the raw log; no dollar-cost
estimate is inferred.

## Configuration

Optional `.env` settings (process environment takes precedence):

| Setting | Default / purpose |
| --- | --- |
| `FACTORIO_BIN` | macOS: Steam's `factorio.app/Contents/MacOS/factorio`. Windows: `...\steamapps\common\Factorio\bin\x64\factorio.exe` (Steam, GOG, or standalone, auto-detected). |
| `FACTORIO_DATA` | The install's `data` directory, derived from the executable (`Contents/data` on macOS, `<install>\data` on Windows). |
| `AUTORIO_DATA_DIR` | `.autorio` in this repository |
| `AUTORIO_PORT` | `3000`; HTTP is bound to localhost |
| `AUTORIO_LOG_LEVEL` | `info`; structured log level (`debug`, `info`, `warn`, `error`) |
| `RCON_PORT` | `27015`; RCON is bound to localhost |
| `AUTORIO_GAME_PORT` | `34197`; Factorio multiplayer host port, set per cluster instance |
| `RCON_PASSWORD` | Generated and retained in `.autorio/rcon-password` if omitted |
| `FACTORIO_WINDOW_SIZE` | `1000x760` |
| `FACTORIO_DISABLE_AUDIO` | Set to `1` for silent runs |
| `AUTORIO_STARTUP_SECONDS` | `180`; maximum graphical readiness wait |
| `AUTORIO_CONTEXT_LIMIT` | Optional agent context limit in tokens; when reached, the agent session is restarted (game/workspace preserved) |
| `FACTORIO_API_BASE` | Override the manager URL used by the Python client; `factorio.py tools --local` works without a manager |
| `AUTORIO_MAP_CACHE_MS` | `2000`; short cache for identical map-overview scans (0 disables) |
| `AUTORIO_MAX_WAIT_SECONDS` | `5`; cap for blocking `wait_for_*` calls and idle waits |
| `AUTORIO_ALERT_GATE_GRACE_SECONDS` | `30`; critical alarms block mutating actions after this age until acked |
| `AUTORIO_ALERT_PENALTY_GRACE_SECONDS` | `300`; grace before unresolved critical alerts accrue score penalty |
| `AUTORIO_ALERT_PENALTY_INTERVAL_SECONDS` | `300`; penalty interval while critical alerts remain unresolved |
| `AUTORIO_ALERT_PENALTY_POINTS` | `25`; points per interval per critical alert |
| `AUTORIO_MANUAL_PENALTY_GRACE_SECONDS` | `1800`; manual mining/crafting penalties are ignored for this opening active-play window |
| `AUTORIO_STATE_RESUME_GRACE_SECONDS` | `120`; grace before a stale plan blocks actions after resume |
| `AUTORIO_STATE_NUDGE_RESTART_SECONDS` | `0`; when >0, restart the agent once with a plan-refresh prompt after this long blocked |
| `AUTORIO_AUTO_RESUME` | `0`; set to `1` to resume the newest interrupted run with a current checkpoint when the manager starts |
| `AUTORIO_AUTO_CONTINUE_MAX` | `3`; automatic same-session continuations after a clean early agent exit (0 disables). When exhausted the run becomes paused/resumable instead of failed |
| `AUTORIO_STATE_SOFT_SECONDS` / `AUTORIO_STATE_HARD_SECONDS` | `300` / `600`; STATE.md reminder and action-block deadlines |
| `AUTORIO_MAX_MOVE_TILES` | `64`; the Python client rejects longer single moves so callers use waypoints and observe the route |
| `AUTORIO_TERMINAL` | Set to `1` to use the optional terminal viewer instead of web recording view |
| `AUTORIO_AGENT_LANGUAGE` | Optional language for agent messages/reasoning summaries and the game locale, e.g. `Chinese` → game `zh-CN`; code and commands stay unchanged |
| `AUTORIO_BROWSER` | Windows/macOS: optional path to the Edge/Chrome executable used for the recording window |
| `AUTORIO_OPENCODE_MODEL` | Default OpenCode model, `opencode-go/deepseek-v4.1-flash` |
| `OPENCODE_BIN` | Optional native OpenCode executable; otherwise `opencode` on PATH |
| `AUTORIO_WSL_DISTRO` | Windows fallback distro for OpenCode, default `Ubuntu-24.04` |
| `AUTORIO_WSL_OPENCODE` | Windows fallback WSL binary, default `$HOME/.opencode/bin/opencode` |
| `CODEX_BIN` | Optional Codex CLI for `--agent codex` |
| `DSH_BIN` | Optional DSH CLI for `--agent dsh`; defaults to `dsh` on PATH |
| `DSH_HOME` | DSH harness home (`~/.dsh`); used to find `.credentials.yaml` for the DSH API key |
| `AUTORIO_DSH_PROFILE` | DSH profile for agent runs, default `headless` |
| `AUTORIO_DSH_PROVIDER` / `AUTORIO_DSH_MODEL` | Default DSH provider/model, `deepseek-official` / `deepseek-flash` |
| `AUTORIO_DSH_REASONING_EFFORT` | Optional default DSH reasoning effort (`low`, `high`, `max`, ...) |
| `FFMPEG_BIN` / `FFPROBE_BIN` | Windows: FFmpeg tools used for 5 fps → 30 fps timelapse conversion; found on PATH by default |
| `OBS_BIN` | Windows: optional path to `obs64.exe` if OBS is not in its default install directory |
| `FACTORIO_API_BASE` | Python/CLI connection override; normally `http://127.0.0.1:3000` |
| `NODE_BIN` | Optional Node path for `./autorio` / `autorio.cmd` |

The installation directory and personal saves/configuration are not modified.
Graphical startup may take tens of seconds. A first-launch Steam/login dialog or
incompatible save/mod version can prevent readiness; inspect `factorio.log` and
the game window. Keep the manager in a normal desktop execution context: a restricted
host sandbox or Windows service session can prevent Steam, graphics, process
inspection, or loopback access.

The game bridge is a cooperative evaluation interface, not a security boundary
against a hostile agent. The manager retains raw RCON and management tools for
the operator. Run workspaces instruct agents to use only the Python gameplay API.
Walking and mining use the bundled **Autorio native character control** mod.
The Python API is unchanged: move/build/interact requests walk the actual
character along Factorio pathfinder routes, with normal collision and animation.
Routes prefer straight legs, including native diagonal walking, and are computed
fresh so new buildings are taken into account. A blocked character first tries a
short perpendicular or backward sidestep (alternating sides), then mines nearby
trees/rocks in front of it when the sidestep cannot free it. Repeated failures
return `blocked`; `avoid_count` and `clear_count` report attempts and cleared
obstacles.
Building pre-clears its footprint: before placement the bridge mines reachable
trees and rocks that overlap the requested entity, reports them under
`clearing.cleared`/`clearing.skipped`, and retries once on `cannot_build`.
Player buildings, cliffs, water, and resources are never removed by this pass.
Disable it per request with `clear=False` or `--no-clear`.

Mining uses native mining state, game mining times and speed bonuses. One mining
request per resource target extracts one cycle; a rock/tree/building is removed
only when its real mining cycle finishes. Results include actual item drops,
travel distance, game ticks and elapsed action time. Crafting queues work while
the agent plans and issues other actions.

The mod is installed only into managed profiles, alongside base Factorio; no
personal mods or installation files are changed. Map caches include the control
mod's content fingerprint. Existing saves can load the mod through normal mod
configuration changes; no benchmark IDs or benchmark versions were changed.

Unreachable targets return `no_path`/`blocked`. Cancellation, run cleanup and
pause handling stop native controls, and a five-second game-time heartbeat lease
stops abandoned actions if the manager disconnects. Saved controller requests are
never replayed after loading. Fluids that cannot be hand-mined are rejected.
Nearby building avoids unnecessary walking; rejected rotations, locked recipes
and rejected crafting requests report failure instead of false success.

## Parallel evaluation cluster

`scripts/cluster.mjs` runs several isolated manager + game instances on one
machine so benchmark runs can be evaluated in parallel. It is the no-Docker
counterpart of a research evaluation cluster: the manager still controls the
installed graphical game, keeping native character animation, the visible game
window and OBS capture available.

```bash
npm run build
npm run cluster start -- --instances 2          # managers on :3000 and :3001
npm run cluster status
npm run cluster run -- --benchmark automation --model opencode-go/deepseek-v4.1-flash#low
npm run cluster stop
```

Each instance gets its own HTTP port, RCON port, Factorio multiplayer host port
and `AUTORIO_DATA_DIR` (`--data-dir`, default `.autorio/cluster/instance-N`), so
saves, profiles, RCON passwords, runs and telemetry never collide. `start`
waits until every manager answers, then writes `cluster.json`; `status` probes
every instance and shows game/RCON/active-run state; `run` submits one benchmark
run per instance through `POST /api/runs` and prints recording URLs (limit with
`--instances-list 1,2`); `stop` shuts the games and managers down. `--save
<name.zip>` seeds a save from `.autorio/saves/` into every instance and hosts it
after start, which is handy for manual multi-instance debugging.

Notes: every graphical instance needs its own memory and GPU budget, so keep
`--instances` at 2-3 on a normal desktop; Steam must stay running. Cluster runs
open no recording window by default (`--no-recording`); use the printed URLs.

## Development and APIs

```bash
npm run dev
npm run verify        # build + Node/Python tests + repo hygiene + Prettier + ESLint
npm run lint          # type-aware ESLint for src/, scripts, tests and browser JS
npm run coverage      # Node suite with built-in coverage; fails below the thresholds
npm run selftest      # read-only 2.1 API check against a live game
npm run release -- patch --dry-run   # preview a version bump + CHANGELOG + tag
```

`npm test` builds TypeScript, exercises run lifecycle/independent scoring with
fake game/agent processes, and runs the Python client tests. Actual graphical
integration requires the installed game and Steam. `npm run dev` restarts on edits,
which stops an active run; use a compiled manager for recordings.

Formatting, hooks and releases:

- `npm run format` / `npm run format:check` — Prettier for `src`, browser JS/CSS, tests, scripts and CI/config files (Markdown, HTML and Lua are excluded).
- `npm run check:repo` — zero-dependency hygiene gate (scripts/engines, strict TS, LF endings, no focused tests, no stray `console.log`, no tracked build artifacts/secrets).
- `npm run hooks:install` — point `core.hooksPath` at the versioned `.githooks/pre-commit`, which runs check:repo, format:check and typecheck on every commit; bypass a WIP commit with `AUTORIO_SKIP_HOOKS=1`. `npm run hooks:check` verifies the setup.
- `npm run coverage` — Node's built-in coverage across the Node suite; the gate fails below 82% lines / 78% branches / 84% functions (override with `--lines/--branches/--functions` on `scripts/coverage-gate.mjs` or `AUTORIO_COVERAGE_*` env vars).
- `npm run release -- <major|minor|patch|X.Y.Z>` — bumps `package.json`/`package-lock.json`, moves the CHANGELOG `[Unreleased]` section into a dated release (rewriting compare links), commits and creates an annotated tag. Use `--dry-run` first; the tree must be clean on `main`/`master`.

Live selftest (self-hosted Windows): `.github/workflows/live-selftest.yml` is a
manual workflow for a `[self-hosted, windows, factorio]` runner. It starts the
compiled manager, hosts a save from `.autorio/saves` (default `clear-test.zip`,
overridable via the `save` dispatch input), unpauses the game through RCON and runs
`npm run selftest`, always stopping the manager afterwards; the runner needs Steam
signed in, the game installed and Node 24. Logs are uploaded as workflow artifacts.

Agent observation endpoints include `/api/agent/observe/factory` (power/fuel/status summary),
`/observe/production` (per-minute mined/produced/consumed rates from the manager's 5 s sampler,
independent of runs), `/observe/fluids` (tank/pipe/refinery fluid amounts), `/observe/combat`
(enemy nests/units, turret ammo, player health), `/observe/area` (deconstruct-planning entity list)
and `/observe/copy-settings` + `/act/copy-settings` (dry-run/reach-checked settings paste). The
Python client adds `preview_path` (native pathfinder preview without walking; helps route around water/cliffs), `observe_snapshot`, `wait_for_production`, blueprint support
(`build_blueprint`/`decode_blueprint_string`, underground input/output subtypes preserved) and
construction planners (pipe lines, power networks, inserter pairs, mining outposts, defense lines,
underground belt/pipe runs). It also adds `deconstruct_area` (observe an area, then remove the
targets with the normal native miner in <=50-target jobs; `dry_run` returns the plan first) and the
matching `deconstruct-area` CLI. Buildings can be repaired in place: `rotate(targets, direction=4)`
(or `act-rotate --direction 4`) turns an entity to a final facing (0/4/8/12) in one call, `mine`
removes a single building/resource, and `deconstruct_area(..., player_only=False)` batches cleanup
(manager-created entities may not have a `last_user`). Build requests may carry
`underground_type: "input"|"output"` for `underground-belt`/`pipe-to-ground`; the manager creates
the explicit subtype and consumes the item.

Run endpoints:

- `GET /api/benchmarks`
- `POST /api/runs` with `{ "benchmark": "smoke", "model": "...", "agent": "codex" }`
- `GET /api/runs`, `GET /api/runs/:id`
- `GET /api/runs/:id/log?offset=0` (byte cursor)
- `POST /api/runs/:id/stop`

Manager health and logs:

- `GET /api/health` — liveness/state probe: HTTP `200` when every probe succeeds, `503` when one fails (`status: "degraded"`, failed probe names in `problems`). An idle manager with no game running is healthy.
- Structured logs: `<data-dir>/manager.log` is JSONL (`level`, `ts`, `msg` plus redacted context); each record is also mirrored as a human line on stderr (cluster instances capture it in `manager.err.log`). `AUTORIO_LOG_LEVEL` selects `debug|info|warn|error` (default `info`), and HTTP requests are logged with method, path, status and duration (health polls excluded).

The JSON gameplay API remains schema version 2. Python is the supported agent
interface, available as both a library and command-line program. Import without
spawning a subprocess:

```python
from factorio import FactorioClient, action_job_ok, data_value

client = FactorioClient()
player = data_value(client.observe_player())["player"]
job = client.move([{"x": player["x"] + 1, "y": player["y"]}])
assert action_job_ok(job)
```

Actions wait for completion by default. Pass `detach=True` and optionally an
`idempotency_key` to use the job API asynchronously. Managed runs handle map
creation, game startup, final saving, and shutdown automatically. Manual game
lifecycle endpoints remain available through the Python client for diagnostics.

Launch a ready rocket silo through the same job interface:

```python
silo = data_value(client.observe_entity([{"x": 10, "y": 12}]))["results"][0]
if silo["rocket"]["ready"]:
    job = client.launch_rocket([{"x": 10, "y": 12}])
    assert action_job_ok(job)
```

The CLI equivalent is `python3 factorio.py act-launch-rocket --target 10,12`.
The character walks into reach, and Factorio checks the launch conditions.
Silo observations include `rocket.parts`, `parts_required`, `silo_status`, `ready`,
and the force's `rockets_launched`. `ready` means the silo has reached the
`rocket_ready` animation state; the launch action can still reject the request
if other game conditions prevent launch. Success returns `launch_initiated: true`;
the rocket benchmark completes only when the game's recorded launch count rises.

## Vanilla-compatible evaluation controls

`observe-map` exposes only chunks charted by the player's force:

```bash
python3 factorio.py observe-map --center-x 0 --center-y 0 --radius 96
```

The server uses only vanilla RCON commands, so unmodded clients can spectate.
Movement remains a time-accounted abstraction because vanilla RCON has no
persistent per-tick input hook; placement uses the real player cursor/build API.

## Coordinates

Build coordinates are explicit top-left tile anchors. `act-build-belt --from x,y
--to x,y` lays a straight belt run with automatic directions; `act-build-loader`
places an inserter between two tiles two apart. `build_belt_line()` and
`build_loader()` do the same from Python. For example:

```bash
python3 factorio.py act-build --entity boiler,-14,-50,4
```

Build and placement responses distinguish `requested_anchor`, `intended_center`,
`actual_center`, and `occupied_tiles`. Entity observations similarly distinguish
the queried tile from the entity center. Prototype observations report tile size
and whether an entity center aligns to integer or half-tile coordinates.

## Action jobs

All state-changing agent operations are serialized through jobs. The CLI creates
a job and polls it by default:

```bash
python3 factorio.py act-mine --target 10,12 --resource iron-ore
```

Use `--detach` to return the job immediately, then inspect or cancel it:

```bash
python3 factorio.py act-build --detach --idempotency-key build-smelters-1 \
  --entity stone-furnace,10,10,0
python3 factorio.py job-status --job-id <id>
python3 factorio.py job-cancel --job-id <id>
```

Craft jobs verify handcraftability, output space, ingredients and queue acceptance;
the Python client then waits until the expected products appear (use
`--no-wait`/`detach` for asynchronous queueing). Jobs are in-memory, retained
for one hour, and run one at a time so concurrent
clients cannot race the player character. Cancellation takes effect between
atomic actions; an action already executing in Factorio is not rolled back.

Direct calls to `/api/agent/act/*` are rejected. Submit `{action, payload}` to
`POST /api/agent/jobs`, poll `GET /api/agent/jobs/:id`, and request cancellation
with `POST /api/agent/jobs/:id/cancel`.

## MCP server

`src/mcp-server.ts` exposes the gameplay API to MCP clients (Claude Desktop,
Cursor, etc.) over the stdio transport, with no extra dependencies. Build once,
keep the manager running, then connect the compiled server:

```bash
npm run build
node dist/mcp-server.js     # or: npm run mcp
```

The server reads `AUTORIO_API_BASE` (falling back to `FACTORIO_API_BASE`,
default `http://127.0.0.1:3000`). Observation tools (`observe_*`,
`server_status`, `list_runs`, `list_benchmarks`, `job_status`) are read-only.
Game-changing tools (`build`, `mine`, `move`, `rotate`, `set_recipe`, `craft`,
`insert`, `extract`, `research`, `launch_rocket`) submit a serialized action job
and return its `job_id`; poll `job_status` until it leaves `queued`/`running`,
and use `cancel_job` to request cancellation. Coordinates are map tiles and build
anchors are top-left tile positions. Only stderr carries diagnostics, so stdout
stays protocol-clean.

Claude Desktop (`claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "autorio": {
      "command": "node",
      "args": ["/absolute/path/to/autorio/dist/mcp-server.js"],
      "env": { "AUTORIO_API_BASE": "http://127.0.0.1:3000" }
    }
  }
}
```

## Visual observation (game-window screenshot)

`POST /api/agent/observe/visual` returns one PNG frame of the visible Factorio
window so an agent can *look* at the factory, not just read RCON data:

```bash
curl -sS -X POST http://127.0.0.1:3000/api/agent/observe/visual \
  -H 'Content-Type: application/json' -d '{}' \
  | jq -r '.data.base64' | base64 -d > factory.png
```

Response: `{"ok":true,"data":{"format":"png","base64":"…","width":1920,"height":1080,"source":"window"}}`.
Optional body `{"title":"Factorio"}` overrides the case-insensitive window-title
match. Windows only and interactive desktop only: the game window must be
visible, not minimized, at least 64×64, and the desktop unlocked (otherwise 500
`visual_capture_unsupported_platform` / `game_window_not_found` /
`game_window_minimized` / `game_window_occluded`). Capture only reads the
desktop: it never clicks, types, moves, or focuses the game, so it cannot steal
keyboard focus from native control. A covered window is rendered with
`PrintWindow` first; foregrounding is never forced. `source` is `"window"`
(`"obs"` is reserved for a future OBS-backed source). A 1080p frame is roughly
1-4 MB PNG, 2-6 MB as base64; concurrent captures are not serialized.

## Gym-style environment and trajectory database

`autorio_gym.py` wraps the manager in a duck-typed Gym-style environment for
batch evaluation code; it uses only the standard library and the repo's
`factorio.py` client (no `gymnasium` dependency):

```python
from autorio_gym import FactorioEnv

env = FactorioEnv(
    save="smoke.zip",
    max_steps=500,
    trajectory_path=".autorio/trajectories/smoke.db",
)
observation = env.reset()                       # typed autorio_types.Observation
terminated = truncated = False
while not (terminated or truncated):
    observation, reward, terminated, truncated, info = env.step(
        {"type": "observe"}
    )
    print(observation.game.tick,
          observation.player.inventory["iron-plate"],
          observation.factory.power.get("satisfaction"))
env.close()
```

`reset(options)` takes `save`, `name`, observation bounds (`x`, `y`, `radius`,
`include`, ...) and hook overrides; it starts the configured save only when the
manager has no game running. `step(action)` accepts `observe`, `noop`, `build`,
`mine`, `move`, `rotate`, `craft`, `set_recipe`, `research`, `insert`, `extract`
and `launch_rocket` actions, dispatches them through the normal job API, and
returns `(Observation, reward, terminated, truncated, info)`. Rewards come from
an optional `reward_fn(action, result, observation)`; a `task_verifier` marks
the episode terminated, and `max_steps` (or a failed/cancelled job) truncates it.
Because the manager exposes uptime rather than an in-game tick, `GameInfo.tick`
is derived from uptime and is approximate while the game is paused.

When `trajectory_path` is set, every reset/step/finish is recorded to SQLite
(WAL journal mode) by `autorio_trajectory.TrajectoryStore`: an `episodes` table
(`id`, `name`, `started_at`, `ended_at`, `config_json`, `total_reward`,
`step_count`, `status`) and a `steps` table (`id`, `episode_id`, `step_index`,
`action_json`, `observation_json`, `reward`, `terminated`, `truncated`,
`info_json`, `created_at`). Observations are stored as the typed
`Observation.to_dict()` and stay JSON-serializable. `list_episodes()` and
`get_steps(episode_id)` provide read access; writes assume a single writer, so
inspect a live database read-only from another process.

## Planning and observation

- `observe-placement` performs a read-only placement check and returns footprint,
  reach, terrain, possible blockers, and nearby valid anchors.
- `observe-entity-prototype` reports Factorio 2.x prototype geometry, placement
  alignment, energy source, and directional fluid connection definitions.
- `observe-entity` reports semantic, deduplicated inventories and absolute fluid
  connection and target positions.
- `observe-research` includes science packs, unit count/time, prerequisites,
  missing prerequisites, and available, locked, queued, current, and completed
  technologies.
- `observe-world` returns charted terrain as run-length encoded rows.
- `observe-resources` returns charted connected-component patches, nearest-patch
  summaries, and shoreline candidates instead of individual resource entities.
- Condition waits (`wait_for_item`, `wait_for_research`, `wait_for_factory`) return as
soon as the target is reached instead of sleeping a fixed time. `observe-factory`
returns a compact power/fuel/status summary: entity counts by
  status, lists of blocked or unfueled buildings, coal in fuel slots, electric
  network satisfaction when available, and human-readable `alerts`.

## Token accounting and science research

Runs capture input, cached-input, and output token counts. OpenCode reports
tokens in its `step_finish` events, so counts are final when the agent completes.
With Codex, completed turns supply final usage; when the runner stops Codex
early, it recovers the latest cumulative counters from that run's local session
log. Those are labelled `last_reported`, not final: an interrupted request may
not have reported usage yet. Missing counts stay unavailable rather than
becoming zero. Counts appear in `run.json`, `SUMMARY.md`, and the dashboard.

Every new run tracks research completion for automation, logistic, military,
chemical, production, utility, and space science packs, independent of producing
those items. Milestones include wall seconds, game ticks, and observation time in
`run.json` and `milestones.jsonl`. Research already complete in the starting save
is marked `initial` at time zero. Detection uses the benchmark's telemetry sample
interval; timestamps are first observations, not exact engine event timestamps.

The Run Details production graph supports cumulative production or production per
game minute, and either active play time or game time on the x-axis. Select one
item, **All items combined** for a summed total, or **All items separately** for
individual colored lines. Combined production counts every item output, including
intermediate products; it excludes fluids and is not an inventory or net-production
measure.
Numbered science-research markers have matching labels below the graph. Download
telemetry to export its samples, baseline, token counters, and milestones as JSON.
This graph lives in the operator dashboard; recording view remains compact.

## Run names and thinking levels

Run names and directory IDs use Pacific local time (`America/Los_Angeles`), with
`PDT` or `PST` according to daylight saving time. For example,
`2026-10-16 13:02:39 PDT · smoke`; IDs use filesystem-safe separators and a short
random suffix. Internal timestamps remain UTC and sorting uses those timestamps.

The dashboard model dropdown offers DeepSeek V4.1 Flash (default) and DeepSeek
V4 Pro through OpenCode. For another model, use the CLI with an OpenCode
`provider/model` id:

```bash
./autorio start rocket --model opencode-go/deepseek-v4.1-flash
```

`--thinking` applies to Codex runs and is passed as `model_reasoning_effort`;
OpenCode takes reasoning settings from its model/provider configuration. Run
metadata saves `model` (and `reasoning_effort` for Codex), while the dashboard,
comparisons, CLI, and summary show a combined label.

### OpenCode models and transports

OpenCode selects a model as `provider/model`; a bare name such as
`deepseek-v4.1-flash` is treated as `opencode-go/deepseek-v4.1-flash`. Set
`AUTORIO_OPENCODE_MODEL` to change the default. On Windows, autorio uses a
native `opencode` when it is on PATH; otherwise it runs the CLI inside WSL using
`AUTORIO_WSL_DISTRO` and `AUTORIO_WSL_OPENCODE`.

```bash
./autorio start smoke --model opencode-go/deepseek-v4-flash#low
```

OpenCode model variants use `#low`, `#high`, or `#max`. `#low` usually produces
faster turns (less reasoning latency); `#high`/`#max` spend more time thinking.

### Output language

Set `AUTORIO_AGENT_LANGUAGE=Chinese` (or pass `--language Chinese`) to ask the
agent to write its messages and reasoning summaries in that language. Code,
commands, paths, and identifiers remain unchanged. The model may still reason in
English; for TTS, choose a voice matching the produced text or add a translation
step.

The same setting also selects the **game locale**: the manager writes the
matching Factorio `locale` into each run's isolated profile (`zh-CN` for Chinese,
`zh-TW` for Traditional Chinese, `en` for English, and the closest installed
locale for other languages). It is applied when the game starts and again when a
paused run is resumed, so the in-game UI/text matches the run language. Factorio
has no voice-over track; this affects text/UI only (the Windows TTS narration has
its own voice selection in `scripts/narrate.ps1`).

### Codex as an optional agent

`--agent codex` uses Codex instead of OpenCode. To point Codex at an
OpenAI-compatible provider, set these in `.env` (or the process environment):

```ini
AUTORIO_CODEX_PROVIDER=opencode-go
AUTORIO_CODEX_BASE_URL=https://opencode.ai/inference/go/openai/v1
AUTORIO_CODEX_ENV_KEY=OPENCODE_API_KEY
OPENCODE_API_KEY=...
# Optional
AUTORIO_CODEX_WIRE_API=responses
AUTORIO_CODEX_CONTEXT_WINDOW=1000000
AUTORIO_CODEX_SANDBOX=workspace-write
```

The provider table is passed to `codex exec` as `-c` overrides, so personal Codex
configuration is still ignored. The Codex login check is skipped because the key
comes from the environment. Example with OpenCode Go's DeepSeek model:

```bash
./autorio start smoke --agent codex --model deepseek-v4.1-flash --thinking low
```

`AUTORIO_CODEX_SANDBOX` defaults to `workspace-write`, except on Windows where
Codex's sandbox currently rejects every agent command; there it defaults to
`danger-full-access`. Set the variable explicitly to override either default.

### DSH (DeepSeek Harness) as the agent

`--agent dsh` runs the local [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)
headless profile (`dsh --profile headless --json`) and translates its event
stream into the same transcript the OpenCode runs use. This is the natural
backend when the same machine already runs the DSH desktop app and you want the
benchmark to use that harness and its stored DeepSeek credentials.

```bash
./autorio start smoke --agent dsh --model deepseek-flash#low
```

Requirements and behavior:

- `dsh` must be on PATH (Windows: the launcher installed by the app), or set
  `DSH_BIN`. Check with `dsh --version`; the run records the version.
- The headless profile deliberately ignores the desktop credential store, so an
  API key is required: `DEEPSEEK_API_KEY` from the process environment, this
  repo's `.env`, or (fallback) the plaintext `refs` block of
  `$DSH_HOME/.credentials.yaml` that the DSH Models page writes. The key is only
  passed to the child process, never logged.
- The model is chosen with `provider/model#effort` or a bare model id; autorio
  writes a per-run `agent-default-model` patch overlay (`dsh-model.patch.yml`)
  so the profile itself is not modified. `AUTORIO_DSH_PROVIDER`,
  `AUTORIO_DSH_MODEL`, and `AUTORIO_DSH_REASONING_EFFORT` set the defaults.
- On Windows the DSH agent's shell tool is Windows PowerShell. The run workspace
  gets a `play.cmd` wrapper that runs the same stdlib client with the Windows
  Python (`FACTORIO_API_BASE`, `PYTHONPATH`, short-sleep guard included), and
  `play.ps1`/`play.sh` remain as a WSL fallback for machines without Windows
  Python; the prompt points the agent at `.\play.cmd factorio.py ...`. The DSH
  headless sandbox may deny `wsl.exe`, which is why Windows Python is preferred.
- Reasoning/media: `thinking` events become transcript reasoning, `text` events
  become agent messages, `tool_call`/`tool_result` pairs render as command
  items, and step usage (`inputTokens`, `outputTokens`, cache reads) feeds the
  run token counters and the context-limit restart. The codex-shaped terminal
  viewer is not used; DSH runs always render the web transcript.
- The headless profile opens no ports and exits after the task; `--session-id`
  resumes a persisted DSH session when a paused run continues in the same
  workspace.

## Automatic OBS timelapses

OBS Studio 28+ includes WebSocket control; no OBS CLI or MCP plugin is required.
Enable **Tools → WebSocket Server Settings → Enable WebSocket server**, keep
**Enable Authentication** on, and allow OBS screen-capture permission when prompted
(macOS Screen Recording; Windows graphics capture needs no extra permission). The manager reads the existing password from OBS's local configuration
without exposing it to the agent. `OBS_WEBSOCKET_URL` (localhost only) and
`OBS_WEBSOCKET_PASSWORD` can override connection settings.

Use the dashboard's **Record 6× timelapse with OBS** checkbox, or:

```bash
./autorio obs-status
./autorio start smoke --model gpt-6.1-sol --thinking low --video
```

`AUTORIO_OBS=1` enables recording by default; `--no-video` disables it for one run.
The local `.autorio/obs-settings.json` can also contain `{"enabled": true}`. Manual
(non-agent) tests do not record. Video capture opens the agent transcript window even
with `--detach`, since that window is needed as a recording source. The optional
Terminal viewer requires `--no-video`.

The runner uses its own **Autorio Timelapse** profile and **Autorio Runs** scene.
It selects exactly one Factorio window and the current run's agent transcript window
by its native window ID (the visible title is simply **Agent transcript**), then composes them at 1920×1080: game left two-thirds, log right
third. This does not move windows or capture the desktop. Capture runs at **5 fps**
and all audio inputs are muted for recording; previous profile, scene, and mute
states are restored afterwards. The runner refuses to take over an active OBS
recording, stream, virtual camera, or replay buffer.

Recording starts before agent timing, stops before the game closes, and is saved
under `.autorio/runs/<id>/video/`. The original capture remains available. macOS
AVFoundation (or FFmpeg on Windows) converts every captured frame into a silent
**30 fps H.264 MP4**, so playback is **6×** faster. Windows requires FFmpeg on PATH
or `FFMPEG_BIN`; macOS needs no extra install. Conversion runs in the
background after the benchmark, and its status/playback/download appear on Run
Details. `video/timelapse.json` records verified frame count, FPS, and duration.
Do not minimize either captured window while recording.

If OBS access, window selection, or startup fails, the run fails before launching
the paid agent. Recording/rendering errors are retained in the run's video status
and warnings. A hard manager crash can leave OBS recording; stop that recording
manually before another captured run. Existing unrelated OBS outputs are never
stopped automatically.

## Pausing to change code or mods

`pause` saves a checkpoint, stops the agent and game, and leaves the run in the
resumable `paused` state:

```bash
./autorio pause RUN_ID
# update code/mods, then
./autorio resume RUN_ID
```

Resume keeps the same run ID, game save, workspace (including agent-written
scripts and notes), and agent session. It also re-copies the managed profile, so
control-mod changes take effect. A normal `stop` is terminal; use `pause` when
you want to restart the game and continue the same run.

The dashboard and run-details pages expose the same controls: **Pause & save**
while a run is active and **Resume** (plus the saved checkpoint/segment info) for
a paused run. Pause also stops Factorio and the recording window; resume reopens
the game, starts a new run segment, and closes the recording window only after the
run reaches a terminal state. A paused run survives a manager restart.

## Context limit and session restart

Set `AUTORIO_CONTEXT_LIMIT=300000` (or another token count) to bound agent context.
When the latest step's input + cached input tokens reach the limit, autorio stops
that agent process, writes a fresh `RESUME.md` with the current milestone and game
snapshot, clears the agent session ID, and starts a new session in the same
workspace. The game, run ID, workspace, scripts, `STATE.md`, and cumulative token
counters continue; `session_resets` records how many times this happened.

A restart is in-place: Factorio is not stopped, so there is no save/load pause.
The new session must re-read `AGENTS.md`, `STATE.md`, and `RESUME.md` before acting.
The limit is disabled when unset or `0`.

## Quota pauses and continuing a run

When the agent reports an exhausted account usage quota, the runner immediately
freezes the game, stops the agent, cancels pending actions, saves a checkpoint,
and stops Factorio and the current OBS recording. The run becomes **paused**.
Temporary request throttling/network errors and text printed by agent tools do
not count as account quota exhaustion.

Once your quota has reset, open the run from history and click **Resume run**, or:

```bash
./autorio resume RUN_ID
```

Resume is manual. The runner does not assume that the reset is five hours after
it detected the limit, and does not spend requests polling your quota. Resuming
before the quota resets will simply pause again when Codex reports the limit.
A paused run remains resumable after restarting the manager. Missing, changed,
or unsaved checkpoints are not silently replaced with the starting map.

The same run ID, fixed-map game, inventory/factory, agent workspace and Codex
session continue. Codex resumes its recorded session by ID when available; if the
limit occurred before a session ID was emitted, it starts a new conversation with
the saved workspace and an explicit game-state summary. Startup never resets a
resumed game's inventory, production baseline, or research milestones.

Elapsed time, the benchmark time limit, production graphs, research markers,
action counts and token usage accumulate across segments. Quota waiting and
Factorio startup/loading are excluded from active play time. Tokens recovered
from interrupted turns are still labeled as last reported, so an interrupted
request can leave a small accounting gap.

`run.json` records the checkpoint path, SHA-256, save time, quota error, and segment
boundaries. Each segment keeps its checkpoint in `segments/NNN/checkpoint.zip`.
The first recording remains in `video/`; later recordings live under
`segments/NNN/video/`. Run Details lists separate downloads for all finished
segments. Resume waits for the previous recording to finish rendering. If the
manager exits during conversion, it recovers a completed video on restart or marks
that conversion interrupted while retaining the original capture; this does not
block resuming a successfully saved game. Keep your
Codex session files and the run's workspace intact to retain conversation context.

This handles reported quota exhaustion with a clean shutdown; a power loss or
forced manager kill still appears as **interrupted**, rather than promising a
checkpoint that was never saved. Resuming requires the same Factorio version.

## Acknowledgements

Portions of the blueprint analysis stack (`blueprint_analysis/`) are adapted
from the MIT-licensed
[factorio-blueprint-tools](https://github.com/chrisjmendoza/factorio-blueprint-tools)
by Christopher J. Mendoza: footprint/inserter geometry, belt tracing,
lane-level flow, supply checks, linting and blueprint diffing. The bundled
recipe/footprint data originates from that project and must be regenerated from
the local Factorio install for exact current-version results.

The seed map preview approach is adapted from the MIT-licensed
[FactorioPreviewToolkit](https://github.com/AntiElitz/FactorioPreviewToolkit) by
AntiElitz (independent profile + Factorio `--generate-map-preview`, and the
pan/zoom viewer pattern).

Factorio is a trademark of Wube Software. This project is not affiliated with
Wube Software.
