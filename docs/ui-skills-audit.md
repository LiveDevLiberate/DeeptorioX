# External UI skills audit (ui-skills.com)

Reference: [ui-skills.com](https://www.ui-skills.com/) /
[ibelick/ui-skills](https://github.com/ibelick/ui-skills) (MIT license).

The registry provides agent skills as `SKILL.md` files plus a remote MCP
endpoint (`https://www.ui-skills.com/mcp`, tools `list_skills` / `get_skill`)
and an `npx ui-skills` CLI. The skill contents are guidance; only the parts that
fit this repository's stack are applied.

## Applicability to autorio

The skills assume React + Tailwind CSS + Base UI/Radix + `motion/react`. The
recording window is vanilla HTML/CSS/JS (`public/recording.*`), so framework
rules do not apply. The following constraints were audited and the transferable
ones were applied:

| Constraint | Status |
| --- | --- |
| Icon-only buttons need `aria-label` | Already present (`statusToggle`, search input) |
| Visible focus states | Already present (`:focus-visible` outline) |
| Respect `prefers-reduced-motion` | Already present |
| Use `dvh` for full-height layout | Already using `100dvh` |
| Tabular numerals for data | Applied to metrics table, status meta, durations, radar |
| `text-wrap: balance` / `pretty` | Applied to status lines and long transcript text |
| Empty states get one clear action | Applied: filter empty state has a **Show all / 显示全部** reset button |
| No gradients / one accent / no glow | Partially conflicts with the intentional cool-slate + multi-hue icon theme requested by the operator; not changed |
| No animation unless requested | No new animation added |
| Errors next to the action | Existing per-row error/warning styling retained |

## How to consume without installing

Individual skills can be fetched as raw markdown, for example:

- `https://raw.githubusercontent.com/ibelick/ui-skills/main/skills/baseline-ui/SKILL.md`
- `https://raw.githubusercontent.com/ibelick/ui-skills/main/skills/improve-ui/SKILL.md`

`improve-ui` is a read-only audit workflow (findings + plan under
`design-plans/`); it is not implemented as a runtime feature here. The remote
MCP endpoint can be registered in an agent host that supports MCP; this
repository does not depend on it and does not vendor the skill files.

## Structure pass (v0.21.0)

Applied the `baseline-ui`/`improve-ui` structure-oriented constraints to the
recording surface without removing any information or icon:

| Finding | Change |
| --- | --- |
| Status content was a flat column (state, plan, metrics, radar, scores) with no semantic groups | Wrapped it in `<header class="status-head">`, `<section class="status-plan">` and `<section class="status-telemetry">` with ARIA labels; wide layout uses a grid with plan left and telemetry right, stacking below 900px |
| Transcript toolbar had no labelled group and search was placeholder-only | Added `<main class="transcript-pane">`, `role="toolbar"`, a labelled `filter-group`, and a magnifying-glass icon inside a focusable search field; labels are localized |
| The global dashboard `section` card style leaked into the recording header | Scoped a reset for `#agentStatus section` |
| A stale plan replaced the current subtask/done-when information | Stale mode now shows `⚠ plan stale · current` plus the done-when line; duplicated plan-age text was removed from the meta line |
| Current/done text could be ellipsized away | Allowed wrapping while keeping the target icon and compact layout |

Before/after evidence was captured at 1200px and 600px widths; the structural
contract is covered by `tests/recording-structure.test.mjs`.

## Grid-system follow-up (v0.22.0)

After the first structure pass the telemetry band was right-flushed by a
`justify-self:end` and the status/toolbar/transcript bands used different max
widths (1080 vs 1000). Added a shared, recording-scoped 12-column grid:

- `--ui-max: 1080px`, `--ui-gutter: 22px`, `--ui-grid-gap: 24px`
- `.ui-grid-12` / `.ui-col-1-7` (plan) / `.ui-col-8-12` (telemetry)
- Telemetry starts at column 8 and is left-aligned inside its area instead of
  being flushed to the right edge.
- Toolbar and transcript padding now use the same `--ui-max`/`--ui-gutter` math.
- Below 900px the grid collapses to one column and both bands span `1 / -1`.

The responsive reset is declared after the explicit placements so the narrow
layout cannot fall back into implicit columns. `tests/recording-structure.test.mjs`
locks the HTML classes and CSS tokens.

## Map-settings dialog (v0.23.0)

Added a `地图 / Map` header button next to the stats toggle, using the existing
status control pattern. It opens a labelled modal dialog (`role="dialog"`,
Escape/backdrop close, focus return) with the benchmark seed, peaceful mode, an
autoplace Resource/Frequency/Size/Richness table, other map settings and raw
`map_gen` in a `<details>` block. Data comes from the run payload through the
DOM-free `mapSettingsView()` helper; the dialog only lists map-generation
overrides, with a note that unlisted resources use Factorio defaults. The icon is
`lorc/treasure-map` (CC BY 3.0, attributed), and `tests/recording-structure.test.mjs`
covers the button/dialog hooks.

## Theme + alignment pass (v0.24.0)

- Added a persisted light theme (`html[data-theme="light"]`) with a sun/moon
  toggle; the dark theme remains the default. The inline head bootstrap applies
  a saved/URL theme before CSS. Light overrides cover status, telemetry, radar,
  toolbar, transcript cards/badges, scrollbars and the map dialog.
- Fixed the shared page grid alignment: `.transcript-pane` no longer inherits
  the dashboard `main` margin/padding, and toolbar + transcript use the same
  `(100% - --ui-max) / 2 + --ui-gutter` inset as the status container. Measured
  at 1200px: status content, top bar buttons, filter group and card left edges
  are all x=67; status/search/right content edge x=1103.

## Modern recording refactor (v0.26.0)

Skills used: `arla6ka/ui-review` (findings and criteria), `ibelick/baseline-ui`
(transferable constraints) and `pbakaus/polish` (refinement order: functional,
states, hierarchy, visual, cleanup). The UI review report is
`.ui-review/2026-11-05-recording.md`.

- Grouped the three display controls into `.status-tools`; increased all header
  and filter hit areas to 30 px.
- Split the header into labelled **Plan** and **Live telemetry** cards on a
  6/6 grid; the token/context meta now aligns to the far edge.
- Replaced individual filter pills with a segmented group; kept every filter
  icon and label.
- Fixed light-theme stale-plan contrast (1.48:1 → 6.86:1), microcopy contrast in
  both themes (≥5.13:1), restored Done-when at 390 px, added a modal focus trap,
  and added an inline connection-lost banner with Retry.
- Verified at 1280 and 390 in dark/light; see `.ui-review/2026-11-05-modern/`.

## Factory-log redesign (v0.27.0)

Skill: `anthropics/frontend-design` (from MCP). The design brief: an operator
watching an autonomous Factorio run, at 1280 and 390, needing state, plan,
readouts and transcript without leaving the page.

Design direction: an **operator's factory log**, not a SaaS dashboard. Black
graphite with a faint drafting grid, safety amber, steel blue and semantic
green/red in dark; blueprint paper with ink and amber in light. Bahnschrift
display + Segoe UI body, tabular numerals, and mono only for commands. The plan
is the single bold moment; the rest is quiet.

Implemented: masthead (`Autorio / factory log`), full-width ruled work order,
full-width readouts strip, ledger transcript rows, underlined ledger tabs,
squared machine controls, and instrument-style elapsed/tokens/context readouts.
This supersedes the v0.26 card layout; the review fixes (contrast, 30px targets,
Done-when at 390, focus trap, connection banner) remain. Evidence:
`.ui-review/2026-11-05-anthropic/`.

### Design plan

- **Color:** graphite `#000`, ink `#E9E3D6`, muted `#9FA399`, safety amber
  `#E8A23C`, steel `#8AAEBE`, danger `#FF9D8E`. Light: blueprint paper
  `#E8EEF0`, ink `#18262C`, muted `#596D74`, amber `#8A4E0B`, steel `#2E6683`.
- **Type:** Bahnschrift display for the masthead/work order/readouts; Segoe UI
  body; tabular numerals for readouts; mono only for command text.
- **Layout:** masthead → ruled full-width work order (hero) → full-width
  readouts strip → underlined ledger tabs → ruled transcript rows.
- **Principles:** spend boldness on the plan line; use rules and grid to encode
  structure, not decoration; keep operational state legible at 390 px; remove
  the generic card kit rather than restyling it.

## Colour + icon pass (v0.27.1)

- Light muted text changed to `#50656c` (5.24:1 on blueprint paper). The stale
  plan now uses the danger colour for both the rule and the line (10.47:1 dark,
  5.6:1 light), so warning colour and warning rule agree.
- Icon scale: `--icon-sm: 12px` and `--icon-md: 14px` for the UI roles; the
  work-order icon is `1em` so it scales with its display text (21.8 px at 1280,
  18 px at 390). Decorative icons set `aria-hidden="true"`.
- Readout alignment: the metrics table and radar share a stretched CSS grid row
  and match exactly at 1280 (116.2 px tall, top y=208.5 / bottom y=324.7).
  `tr.metric` background and the global table margin were removed, so the table
  sits transparently on the blueprint/graphite surface.
- Captures and raw audit: `.ui-review/2026-11-05-anthropic/`
  (`factory-*.png`, `icon-color-audit.json`).
