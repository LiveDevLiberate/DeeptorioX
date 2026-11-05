# Changelog

All notable changes to autorio are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project aims to follow [Semantic Versioning](https://semver.org/). Released
versions are tracked by annotated git tags; history before commit `9e4e677` predates
this file.

## [Unreleased]

### Changed

- **Stylesheet split without visual change.** `public/runs.css` is now an
  ordered entry point for `styles/tokens.css`, `styles/base.css`,
  `styles/recording.css`, `styles/dashboard.css` and
  `styles/recording-modern.css`. The modules preserve the original source order;
  all six browser-regression screenshots are pixel-identical before/after.
  Base `:root` tokens now live in `tokens.css`. Removed 221 fully-shadowed
  legacy rules (822 lines) whose declarations were all re-declared later for the
  same selector/context; the browser screenshots remain pixel-identical.
  Also removed the superseded 120-line colour-system-v2 pass and consolidated
  the repeated status/meta/readout/connection-notice selector chains into their
  final rules (4,947 → 4,861 lines; screenshots still pixel-identical).
  Removed the pre-recording legacy transcript/filter/jump block from `base.css`
  (245 lines) while keeping dashboard run/chart primitives; stylesheet modules
  are now 4,623 lines and screenshots remain pixel-identical. Round 8 removed
  the obsolete modern-v4 light/panel/microcopy tail (28 lines) while retaining
  its effective header layout and light chip/plan rules; modules now total
  4,586 lines with pixel-identical stable screenshots. A declaration-level
  redundancy pass then removed 86 shadowed declarations and 5 empty rules,
  bringing modules to 4,523 lines with identical screenshots. Extending the same
  importance-aware pass to grouped selectors removed another 21 declarations,
  and internal blank lines left by the edits were compacted, for a final
  4,469 lines with identical stable screenshots. Removed the obsolete score-bar
  UI rules (the page uses the radar now) and orphaned grouped selectors, bringing
  modules to 4,377 lines with pixel-identical screenshots. Removed obsolete base
  telemetry wrappers, unused icon-sprite rules and unused custom properties,
  bringing the modules to 4,288 lines while keeping stable screenshots identical.

### Added

- **Automatic same-session continuation.** When an agent exits cleanly before the
  objective is verified, the manager reloads the same session with a resume
  prompt, up to `AUTORIO_AUTO_CONTINUE_MAX` (default 3). Exhausting the budget
  pauses the run with a valid checkpoint instead of marking it an unrecoverable
  failure; failed/interrupted runs with a current checkpoint can be retried from
  the run page. Runs now record `failure_kind` and `auto_continues`.
- **STATE.md nudge artifact.** While the plan is due/blocked, the manager writes
  `workspace/PLAN_REMINDER.md` with the exact state-write instruction and removes
  it when STATE.md is refreshed.
- **Agent model in the recording header.** The live recording status line now
  shows `model <model_label>` (shortened with ellipsis at narrow widths) with the
  full label in the tooltip; the run page already exposes the model in Run
  information. This makes it visible which model is driving the current game.
- **Resilient tool discovery.** `factorio.py tools` now falls back to local
  introspection when the manager endpoint is unavailable, marks the manifest as
  `source: local|manager`, compares the manager's `sources.factorio.py` hash with
  the workspace client and sets `client_outdated`/`client_update_hint` when the
  workspace is stale. Manifests carry `manifest_version` and `client_sha256`.
- **Blueprint catalogue management.** Run details can rename or delete a
  blueprint (`PATCH`/`DELETE /api/runs/:id/blueprints/:id`); the store removes
  the raw wire file when the last reference is deleted. CLI preview and
  list/save remain available.
- **Blueprint CLI and preview.** `blueprint-list` / `blueprint-save` make the
  per-run catalogue usable without writing Python; paid upload of a designed
  string does not build it. Blueprint details in the run page and recording
  window now include an SVG layout preview (entity positions, rough prototype
  sizes and category colors) alongside the decoded JSON.
- **Blackout scoring UI.** The recording penalty row now shows the blackout
  count with a bolt icon alongside manual mining/crafting and STATE penalties;
  the tooltip spells out the blackout count. The run/comparison pages already
  surface the count and −500-per-event penalty.
- **Blackout scoring.** Once any electric network has produced positive
  capacity, each transition into a full blackout (demand > 0 and power
  satisfaction ≤ 0.5%) deducts 500 points. Outage state persists across
  telemetry samples and restarts so one continuous outage counts once; the
  run page and comparison show the blackout count/penalty.
- **Build-payload validation.** `act-build --entities-json` now normalizes the
  canonical `{name, anchor:{x,y}}` schema and the `x`/`y` shorthand, rejects
  malformed entities with a clear error, and the manager returns 400 when a
  non-empty request yields zero valid build entities. This fixes the silent
  `ok:true / results:[]` build that occurred when an agent passed `x`/`y`
  instead of `anchor`.
- **Map PNG output and scan cache.** The map-overview endpoint now also returns
  `format=svg` or `format=png` (`png_base64` / `svg`), and identical center/radius/
  size requests are served from a short cache (`AUTORIO_MAP_CACHE_MS`, default
  2000 ms) to avoid repeated Lua/RCon scans. The agent prompt and COOKBOOK point
  at `observe_map_overview` as a charted-area planning aid.
- **CSS rule-local hygiene guard.** Added a dependency-free stylesheet parser
  test that fails on duplicate declarations or same-context fully shadowed
  rules; the audit found no safe remaining removals (the responsive
  `.status-line` pair is intentional).
- **Run-page visual regression.** The browser regression suite now loads the real
  run page against the fixture API, checks the header/blueprint/map controls and
  model label, and stores a deterministic screenshot artifact.
- **Optional startup recovery.** `AUTORIO_AUTO_RESUME=1` resumes the newest
  interrupted run with a current checkpoint when the manager starts; otherwise
  interrupted runs remain manually retryable from the run page.
- **Failure/partial-progress diagnostics.** Run pages show failure kind,
  auto-continues, automation score and milestone completion; run history and
  comparison add the same partial-progress columns so failed runs remain
  comparable.
- **SVG map overview output.** `POST /api/agent/observe/map-overview` accepts
  `format: "svg"` and returns compact same-color SVG runs alongside window
  metadata; Python/CLI expose `observe_map_overview(..., format="svg")` /
  `--format svg`.
- **Run page map thumbnail.** Run details now has a Map toggle that paints the same
  charted overview canvas for the active run, alongside the recording Map dialog.
- **Recording map thumbnail.** The recording Map dialog now loads the
  map-overview endpoint and paints the charted ASCII rows as a pixel canvas,
  with glyph colors, legend and charted/radius metadata; the existing map
  settings remain below it.
- **Map-overview thumbnail API.** `POST /api/agent/observe/map-overview`
  downsamples player-charted chunks into compact ASCII rows with a legend for
  uncharted/water/land/player-force entities/resources/player. Supports radius
  up to 1024 tiles and 160 grid cells, with Python `observe_map_overview()` and
  CLI `observe-map-overview`.
- **Per-run blueprint catalogue.** Agents can persist blueprints for the current
  game through `POST /api/blueprints` (active run) or
  `POST /api/runs/:id/blueprints`; the API returns the run's available blueprints
  with decoded label/dimensions/entity counts, and a detail endpoint returns the
  wire string plus payload. The run page and the live recording window have Blueprints buttons/counts and
  summary lists with on-demand decoded detail. Python clients get
  `save_blueprint()` / `list_blueprints()`, and `build_blueprint()` auto-registers
  when the launched agent carries `AUTORIO_RUN_ID`.
- Dependency-free browser UI regression (`npm run test:ui`): serves the real
  recording page with mocked run/event/telemetry responses, runs system
  Edge/Chrome headless and asserts metrics/radar geometry, contrast, 30px
  targets, icon scale, map-dialog focus trap/return, no overflow and the
  connection-error state. Screenshots land in ignored `.ui-review/ui-regression/`.
  A committed computed-style baseline (`tests/ui-style-baseline.json`) covers
  colors, borders, fonts, spacing and layout for main/dialog/error surfaces;
  regenerate deliberately with `AUTORIO_UI_UPDATE_BASELINE=1 npm run test:ui`.
  The status line, its icon/readouts and the error notice are included after
  catching a meta letter-spacing/icon-margin drift during consolidation.
  Collapsed-status and overlay states are covered too; screenshot artifacts use
  a no-audit fixture mode so transient focus/dialog state cannot mask layout.
  Windows CI requires the check.

## [0.27.2] - 2026-11-04

### Fixed

- Resumed runs now refresh the bundled workspace `factorio.py`, `AGENTS.md` and
  `COOKBOOK.md` (and record the new hashes) instead of keeping the client copied
  at run start. This fixes agents on older runs seeing `Unknown command 'tools'`
  and missing newer client methods such as blueprint registration.

- **Readout alignment and hero-icon scale.** The metrics table and radar now
  share a stretched grid row and match exactly at 1280 (both 116.2 px tall,
  top y=208.5, bottom y=324.7). The table is transparent again: the old
  `tr.metric` fill and global table margin were removed. The work-order icon
  now scales with the display type (`1em`, 21.8 px at 1280) and uses the safety
  colour, or danger when the plan is stale, matching its text.

## [0.27.1] - 2026-11-04

### Changed

- **Palette and icon polish.** Light muted text darkened to `#50656c`
  (5.24:1); stale-plan warning uses danger for both rule and text (10.47:1 dark,
  5.6:1 light). One 12 / 14 px icon scale for chips, actions, metrics, event and
  jump icons; decorative masks got `aria-hidden="true"`.

## [0.27.0] - 2026-11-04

### Changed

- **Factory-log redesign (Anthropic frontend-design skill).** Replaced the
  dashboard card kit with an industrial operator's surface: an Autorio masthead,
  a full-width ruled **work order** with the current plan as the hero, a
  full-width **readouts** strip, ledger-style transcript rows, ledger tabs, and
  an amber/steel palette on black graphite (dark) or blueprint paper (light).
  Type is Bahnschrift display + Segoe UI body with tabular numerals; mono is
  reserved for commands. The design keeps all information, icons, themes,
  focus trap, connection alert and 30 px controls.

### Fixed

- The map dialog now returns focus to the map trigger when it was opened from a
  programmatic/body focus context.

## [0.26.0] - 2026-11-04

### Changed

- **Modern recording-window refactor.** Guided by the ui-skills `arla6ka/ui-review`
  findings, `ibelick/baseline-ui` constraints and `pbakaus/polish` pass: display
  controls are grouped, the header is split into labelled **Plan** and
  **Live telemetry** cards, the filter bar is a segmented control, and the
  transcript rhythm is tightened. Information, icons, dark/light themes and the
  12-column grid are preserved.
- **Review findings addressed:** light-theme stale-plan text now 6.86:1
  (was 1.48:1); `.msg-time`/map-note contrast now ≥5.13:1 in both themes;
  header/filter hit areas are 30 px; Done-when remains visible at 390 px; the
  map dialog traps focus and restores it on Escape; API failures show an inline
  connection banner with Retry instead of looking like an empty run.

### Added

- `#connectionNotice` alert with retry and localized messaging.

## [0.25.2] - 2026-11-04

### Fixed

- Regenerated `public/tool-manifest.json` after adding `/api/map-config`, so the
  generated tool-discovery manifest and its freshness test are current again.
- Removed unused telemetry imports from the recording bundle and made the
  automation-score resource-name extraction type-safe; ESLint is clean again.

## [0.25.1] - 2026-11-04

### Changed

- **Dark theme now uses a true black page background (`#000`).** The recording
  page, status header and transcript toolbar are pure black (the previous
  green/blue radial gradients are removed); the dashboard page background is
  black too. Card/panel surfaces keep their dark-grey hierarchy, and the light
  theme is unchanged.

## [0.25.0] - 2026-11-05
## [0.25.0] - 2026-11-04

### Added

- **Launch-time map configuration.** The launch form now has a collapsible
  **Map configuration** section for new runs:
  - seed (integer), peaceful mode and starting area;
  - per-resource frequency / size / richness overrides for iron, copper, coal,
    stone, crude oil, uranium, water, trees, rocks and enemy bases, with
    None/Very low/Low/Normal/High/Very high/Extreme presets and an explicit
    "Default" that keeps Factorio's generation defaults;
  - "Reset to benchmark" restores the selected benchmark's map_gen values.

  The effective config is sent as `map_gen` in `POST /api/runs`, validated by
  `src/map-config.ts` (unknown fields/resources and out-of-range values are
  rejected), stored on the run's benchmark and used for baseline map creation;
  the recording window's Map dialog then shows the actual seed/resources.
  `GET /api/map-config` exposes the resource list and presets to the form.
  Tests cover normalization, launch integration and the static launch form.

## [0.24.0] - 2026-11-05
## [0.24.0] - 2026-11-04

### Added

- **Light theme + theme toggle.** The recording page now supports a light
  palette alongside the default dark theme. A `浅色 / 深色` button (sun/moon
  icon, localized, hidden-label on narrow screens) toggles the theme, persists
  the choice in `localStorage` (`autorio.theme`), updates `aria-pressed` and can
  be deep-linked with `?theme=light` / `?theme=dark`. The inline head bootstrap
  applies the saved/URL theme before CSS loads to avoid a flash. Light covers
  the status header, badges, metrics/sparks/radar, toolbar/chips/search,
  reasoning/commands/messages/action badges, scrollbars and the map dialog.

### Fixed

- **Grid alignment across the three page bands.** The recording `main` was
  inheriting the dashboard manager's `10px` margins and `28px` padding while the
  status header used its own 1080px container, and the transcript used a
  different inset formula (missing the `22px` gutter). Added a shared inset:
  header content, toolbar content and transcript cards now share the same left
  edge (measured x=67 at 1200px) and the same right content edge (x=1103 for
  header/search). The generic `main` margin/padding is reset for
  `.transcript-pane`, and the toolbar background now spans the full width.

## [0.23.0] - 2026-11-05
## [0.23.0] - 2026-11-04

### Added

- **Map settings button in the recording header.** A `地图 / Map` button (next
  to the stats toggle, with a treasure-map icon) opens an accessible dialog
  (`role="dialog"`, Escape/backdrop close, focus return) showing:
  - the benchmark `map_gen.seed` (e.g. `424242`),
  - peaceful mode,
  - every `autoplace_controls` override in a Resource / Frequency / Size /
    Richness table,
  - other map settings and a collapsible raw `map_gen` JSON block.

  The dialog is populated from the run payload via the DOM-free
  `mapSettingsView()` helper; labels follow the run language and the panel can
  be opened directly with `?map=1`. Only overrides are listed; unlisted
  resources and blank fields use Factorio defaults. Added
  `public/icons/map.svg` (lorc/treasure-map, CC BY 3.0) and a structure test for
  the button/dialog.

## [0.22.0] - 2026-11-05
## [0.22.0] - 2026-11-04

### Changed

- **Shared 12-column grid for the recording window.** The wide layout now uses
  `--ui-max: 1080px`, `--ui-gutter: 22px` and `.ui-grid-12` with
  `.ui-col-1-7` (plan) / `.ui-col-8-12` (metrics + radar). Telemetry starts at
  column 8 and is left-aligned inside its area instead of being flushed to the
  right edge; toolbar and transcript padding use the same container math. The
  grid collapses to one column at 900px with a late responsive reset so narrow
  layouts cannot inherit implicit grid columns. Structure test covers the HTML
  grid classes and CSS tokens.

## [0.21.0] - 2026-11-05
## [0.21.0] - 2026-11-04

### Changed

- **Recording UI structure pass (ui-skills `baseline-ui`/`improve-ui`).**
  - The status header now has semantic `<header>`/`<section>` groups with ARIA
    labels: run status, current plan, live telemetry. On wide screens the plan
    sits left and the metrics/radar right; both stack below 900px.
  - The transcript lives in a `<main class="transcript-pane">`; the toolbar is a
    labelled `role="toolbar"` with a `filter-group` and a focusable search field
    containing a magnifying-glass icon (new `public/icons/search.svg`, attributed).
  - Fixed the dashboard `section` card style leaking into the status header.
  - Stale plans no longer erase the current subtask/done-when: they show
    `⚠ plan stale · current` + done-when, while the duplicated plan-age text is
    removed from the meta line. Plan/done text wraps instead of ellipsizing.
  - All existing information, IDs and icons are retained; structural contract is
    covered by `tests/recording-structure.test.mjs`, plus before/after screenshots
    at 1200px and 600px.

## [0.20.0] - 2026-11-05
## [0.20.0] - 2026-11-04

### Added

- **Path preview before walking.** New `path` action / `preview_path(x, y)` /
  CLI `path-preview --target x,y` asks the native pathfinder for a route without
  moving the character; returns `path` waypoints on success or
  `ok=false,error=no_path` for water/cliff/building barriers. Agent guidance now
  requires checking it before long or unseen-terrain moves instead of retrying
  the same blocked goal.

### Fixed

- **Movement no longer oscillates in front of impassable terrain.** A pathfinder
  `no_path` answer now only allows one local sidestep/clear attempt before
  returning `no_path` (previously it looped up to 8 alternating avoidances, so
  the character zig-zagged against cliffs/water). Unreachable coarse waypoints
  are skipped once, tolerance was raised to 0.30 tiles and the stuck window to
  60 ticks, which also removes most open-ground jitter. The audit of the current
  rocket run showed 229/499 moves ending in `no_path` and 227 moves with
  `avoid_count=9` — the exact oscillation pattern this addresses.

## [0.19.2] - 2026-11-05
## [0.19.2] - 2026-11-04

### Fixed

- Added the missing `docs/ui-skills-audit.md` referenced by the v0.19.1 UI-skills
  polish note (the documented applicability matrix and fetch instructions).

## [0.19.1] - 2026-11-04

### Changed

- **Applied transferable [ui-skills](https://www.ui-skills.com/) baseline rules.**
  The registry's React/Tailwind/MCP stack does not fit this vanilla CSS/JS
  recording window, but its baseline checklist did: data uses tabular numerals
  (metrics table, status meta, durations, radar), status/long transcript text
  uses `text-wrap: balance`/`pretty`, and the filter empty state now has a clear
  **显示全部 / Show all** reset action. Existing `:focus-visible`,
  `prefers-reduced-motion`, `100dvh`, and icon-button labels already satisfied
  the relevant constraints. Audit notes are in `docs/ui-skills-audit.md`.

## [0.19.0] - 2026-11-05
## [0.19.0] - 2026-11-04

### Added

- **Generated tool-discovery manifest.** `GET /api/agent/tools` (and
  `factorio.py tools [--json] [--local] [--query TEXT]`,
  `client.tools(query=...)`) returns a JSON manifest of every agent-facing
  client method (signature, parameters, docstring), CLI command usage and manager
  endpoint. `?q=` filters it and treats hyphens/underscores as spaces
  (`build-mining-outpost` also finds `build_mining_outpost`). The manifest is
  generated from `factorio.py` plus `src/api/agent.ts`/`src/api/*.ts` by
  `scripts/generate-tool-manifest.py`; `npm run tools:manifest` regenerates it
  and the Python test suite fails if `public/tool-manifest.json` is stale.
  The task prompt and playbook now tell the agent to consult the manifest instead
  of reading `factorio.py` source, so discovery cannot silently drift.

## [0.18.0] - 2026-11-05
## [0.18.0] - 2026-11-04

### Changed

- **STATE.md score tendencies use a compact radar chart.** The six horizontal
  score bars were replaced by a 96 px hexagonal SVG radar (production, logistics,
  mining, research, defense, exploration) placed beside the metrics table, so the
  status header does not grow taller. Labels follow the run language, the active
  subtask's axis is highlighted, each point has a score tooltip, and the polygon
  is clamped to 0–100. Geometry is a DOM-free `radarGeometry()` helper covered by
  tests.

## [0.17.0] - 2026-11-05
## [0.17.0] - 2026-11-04

### Added

- **Stale-plan feedback loop.** Three additions on top of the STATE.md gate:
  - when STATE.md crosses the soft/hard deadline (and when it is refreshed) the
    manager appends an `event_marker` to the transcript, so the recording window
    shows “计划需要更新” / “计划超时” / “计划恢复” markers;
  - a stale STATE.md adds a visible penalty to the automation score
    (`25` for the soft deadline, `100` for the hard deadline, shown as a clock
    item in the 惩罚 row); it clears as soon as the state is written;
  - the status line shows a live `计划 m:ss` countdown to the hard deadline
    (amber when due, red “需更新计划” when blocked), driven by
    `run.state_status`.

## [0.16.0] - 2026-11-05
## [0.16.0] - 2026-11-04

### Added

- **STATE.md update API and enforcement.** `POST /api/agent/state` accepts
  structured plan fields (`current`, `scores`, `objective`, `done_when`, `next`,
  `timebox`, `progress`, `notes`, or a raw `markdown` override), writes the
  canonical `workspace/STATE.md` atomically and refreshes the update deadline;
  `GET /api/agent/state` returns `age_seconds` / `due` / `blocked` / interval
  details. Python: `client.write_state(...)` and `client.state()`; CLI:
  `state-write` / `state-show`.
- Mutating agent jobs are refused with `409 STATE_UPDATE_REQUIRED` once STATE.md
  is older than the hard interval (default 600 s, soft reminder at 300 s,
  missing-state grace 120 s; configurable via `AUTORIO_STATE_*_SECONDS`).
  Observations remain available; `observe_factory()` and `plan` include the
  `state` block, and `act-mine`/`act-craft` responses carry it too. The prompt,
  playbook and cookbook now require refreshing STATE.md every 5 minutes, so the
  operator view cannot drift for long.

## [0.15.0] - 2026-11-05
## [0.15.0] - 2026-11-04

### Added

- **Automation score with manual-work penalty.** The manager now records every
  finished mine/craft job: hand-mined natural-resource units (ores, stone, wood,
  trees/rocks) cost 1 point and hand-crafted items cost 2 points; deconstructing
  placed buildings is not penalised. A positive score is derived from telemetry
  (weighted cumulative automated output since the baseline, science packs, power
  satisfaction, research progress, rockets). `run.json`/`telemetry.jsonl` carry the
  `automation` block (score, positive, penalty, counts, breakdown), the recording
  window shows `自动化`/`惩罚` table rows, and old runs are recounted from
  `jobs.jsonl` when the manager loads them.
- Agent feedback: `observe_factory().plan.automation` carries the block, and
  `act-mine`/`act-craft` responses include it immediately; the playbook,
  cookbook and task prompt tell the agent to prefer drills/furnaces/assemblers
  over hand work and to check the score after each subtask.

## [0.14.1] - 2026-11-05
## [0.14.1] - 2026-11-04

### Changed

- **Status-details control is now a left-aligned stats button.** The right-side
  `▾/▸` arrow was replaced by a chip at the start of the status line with the
  game-icons.net `chart` glyph (new `public/icons/stats.svg`, attributed) and the
  localized label `详细统计` / `Detailed stats`; it toggles the compact header
  using `aria-expanded` and still collapses all detail rows (plan, metrics,
  scores). Layout/CSS keeps it left-aligned on narrow windows too.

## [0.14.0] - 2026-11-04
## [0.14.0] - 2026-11-04

### Changed

- **Status metrics are a compact table now.** Production, research and power are
  rendered as aligned `label | value | trend` rows instead of a loose row of
  pills; the production trend keeps the sparkline, shows a `stable`/`+N%`/`-N%`
  delta and explains itself on hover. The sparkline samples the last 8 telemetry
  readings and is normalized per item (a flat series renders mid-height, a
  changing series amplifies its shape); it is a relative trend, not cumulative
  output. Added `telemetryResearchDetail`, `telemetryPowerSatisfaction` and
  `sparkTrend` helpers plus tests for the new sparkline semantics.
- **The plan line uses a target icon instead of `▶`.** The game-icons.net
  `on-target` glyph (new `public/icons/target.svg`, attributed) is coloured cyan
  and precedes the current subtask; `▶` is gone.
- **Recording UI text localization extended.** Action badge and command-group
  labels (`build`/`建造`, `cmd`/`命令`, …), metric labels, the document title,
  `stale`/`failed`/`running`/`ran N commands`, loading placeholder and the metrics
  table headers now follow the run language; identifiers (item names, tech names,
  paths) stay unchanged.

## [0.13.0] - 2026-11-04
## [0.13.0] - 2026-11-04

### Added

- **The game starts in the run's language.** A new `src/locale.ts` maps the
  agent language to an installed Factorio locale (`Chinese`→`zh-CN`,
  `Traditional Chinese`→`zh-TW`, `English`→`en`, `Deutsch`→`de`,
  `日本語`→`ja`, …) and the manager writes `locale=<id>` into the run profile's
  `config.ini` before launching the game. It is re-applied on resume, so a
  paused Chinese run restarts with a Chinese in-game UI. Unknown languages fall
  back to English; explicit IDs such as `zh-CN` pass through unchanged.
  Factorio has no voice track — this controls text/UI language only.
- `tests/locale.test.mjs` covers the language→locale mapping and config safety;
  the DSH run test asserts a Chinese run starts the game with `locale=zh-CN`.

## [0.12.3] - 2026-11-04
## [0.12.3] - 2026-11-04

### Added

- **Save & resume from the web UI.** The dashboard and run-details pages now have
  a **Pause & save** button for active runs and a **Resume** button for paused,
  resumable runs (with checkpoint/segment info on the run page); **Stop** is back
  to being the terminal action. `pause` saves a checkpoint, stops the agent/game
  and keeps the run resumable across a manager restart; `resume` reloads the same
  save, workspace and agent session as a new segment. Verified live on the rocket
  run: paused at 125m40s, manager restarted, resumed in segment 2, and the
  continuation prompt created STATE.md (Chinese plan/scores) immediately.

## [0.12.2] - 2026-11-04
## [0.12.2] - 2026-11-04

### Changed

- **Icons now have distinct hues instead of one shared tint.** Filter chips get
  their own colour (all=blue, thinking=amber, actions=green, messages=cyan,
  errors=red, decisions=violet); telemetry pills colour their glyphs by metric
  (production=green, research=violet, power=amber, error=red, muted=gray); card
  headers use amber brain / blue terminal / green wrench / cyan flag; action
  badges and command-group header icons are tinted by their action category
  (the group glyph now follows the dominant category instead of always being the
  blue laptop). Icon colour is purely a `color` value on the CSS mask, so the
  neutral surfaces stay unchanged.

## [0.12.1] - 2026-11-04
## [0.12.1] - 2026-11-04

### Fixed

- **DSH final answers now reach the transcript and the Messages filter.**
  `dsh --json` emits the final answer as a separate `final` event; the manager
  only wrote it to `codex.log`, so the recording window never showed it and the
  Messages filter could stay empty after a run finished. Final text is now
  emitted as an `agent_message` item (deduplicated against the last streamed
  text message) and covered by the fake-DSH run test.
- Double-checked every filter against a live run with instrumented DOM state:
  All (turn + messages + command groups + reasoning), Thinking (reasoning only),
  Actions (command groups only), Decisions (decision reasoning only), Messages
  (agent messages only, empty-state note when none), Errors (empty-state note
  when no failures). Filters are re-applied after every poll, so newly arriving
  items are filtered too, and `[hidden]` now wins over author display rules.

## [0.12.0] - 2026-11-04
## [0.12.0] - 2026-11-04

### Added

- **Rotate to an exact facing and remove old buildings safely.** `rotate` targets
  may now carry an optional `direction` (0=north, 4=east, 8=south, 12=west):
  the API/Lua rotates the entity up to four steps until it faces that direction
  and reports the resulting direction and step count. Supported from the Python
  client (`rotate(targets, direction=4)`), CLI (`act-rotate --direction 4`),
  action jobs and the MCP `rotate` tool. `mine` removes a single existing
  building and `deconstruct_area(..., player_only=False, types=[...])` batches
  cleanup; the playbook, cookbook and task prompt now explicitly allow/models
  rotating, removing and rebuilding your own layouts instead of building around
  a mistake.

## [0.11.1] - 2026-11-04

### Fixed

- **Status-collapse button now has a clear job.** It used to hide only the
  score/done rows, which are empty in runs without `STATE.md`, so it looked
  dead. It now collapses every detail row (current plan, done-when, metrics,
  scores) and leaves a one-line compact header for recording/OBS; the preference
  is persisted, the header defaults to collapsed in `?overlay=1`, tooltip/aria
  labels follow the UI language, and `?status=collapsed|expanded` overrides it
  for screenshots/tests.

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

[Unreleased]: https://github.com/ryanmadden/autorio/compare/v0.27.2...HEAD
[0.27.2]: https://github.com/ryanmadden/autorio/compare/v0.27.1...v0.27.2
[0.27.1]: https://github.com/ryanmadden/autorio/compare/v0.27.0...v0.27.1
[0.27.0]: https://github.com/ryanmadden/autorio/compare/v0.26.0...v0.27.0
[0.26.0]: https://github.com/ryanmadden/autorio/compare/v0.25.2...v0.26.0
[0.25.2]: https://github.com/ryanmadden/autorio/compare/v0.25.1...v0.25.2
[0.25.1]: https://github.com/ryanmadden/autorio/compare/v0.25.0...v0.25.1
[0.25.0]: https://github.com/ryanmadden/autorio/compare/v0.24.0...v0.25.0
[0.24.0]: https://github.com/ryanmadden/autorio/compare/v0.23.0...v0.24.0
[0.23.0]: https://github.com/ryanmadden/autorio/compare/v0.22.0...v0.23.0
[0.22.0]: https://github.com/ryanmadden/autorio/compare/v0.21.0...v0.22.0
[0.21.0]: https://github.com/ryanmadden/autorio/compare/v0.20.0...v0.21.0
[0.20.0]: https://github.com/ryanmadden/autorio/compare/v0.19.2...v0.20.0
[0.19.2]: https://github.com/ryanmadden/autorio/compare/v0.19.1...v0.19.2
[0.19.1]: https://github.com/ryanmadden/autorio/compare/v0.19.0...v0.19.1
[0.19.0]: https://github.com/ryanmadden/autorio/compare/v0.18.0...v0.19.0
[0.18.0]: https://github.com/ryanmadden/autorio/compare/v0.17.0...v0.18.0
[0.17.0]: https://github.com/ryanmadden/autorio/compare/v0.16.0...v0.17.0
[0.16.0]: https://github.com/ryanmadden/autorio/compare/v0.15.0...v0.16.0
[0.15.0]: https://github.com/ryanmadden/autorio/compare/v0.14.1...v0.15.0
[0.14.1]: https://github.com/ryanmadden/autorio/compare/v0.14.0...v0.14.1
[0.14.0]: https://github.com/ryanmadden/autorio/compare/v0.13.0...v0.14.0
[0.13.0]: https://github.com/ryanmadden/autorio/compare/v0.12.3...v0.13.0
[0.12.3]: https://github.com/ryanmadden/autorio/compare/v0.12.2...v0.12.3
[0.12.2]: https://github.com/ryanmadden/autorio/compare/v0.12.1...v0.12.2
[0.12.1]: https://github.com/ryanmadden/autorio/compare/v0.12.0...v0.12.1
[0.12.0]: https://github.com/ryanmadden/autorio/compare/v0.11.1...v0.12.0
[0.11.1]: https://github.com/ryanmadden/autorio/compare/v0.11.0...v0.11.1
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
