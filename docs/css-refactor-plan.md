# CSS and browser-regression refactor plan

Goal: reduce `public/runs.css` to a maintainable layered stylesheet without changing
the current factory-log appearance, and guard the work with automated browser
checks.

## Baseline (v0.27.2)

- `public/runs.css`: **5,879 lines**, **1,127 rules**, **719 unique selectors**,
  **201 selectors declared more than once**.
- Largest duplicate selectors: `.status-meta` (12), `.status-telemetry .status-data`
  (11), `body.recording` (9), `.status-scores` (9), `.status-current` (8),
  `#codexOutput` (6), `.action-duration` (6), `.status-inner` (6),
  `.status-activity` (6), `.status-done` (6).
- The duplication comes from successive theme/design passes being appended over
  earlier rules. The current cascade is order- and specificity-sensitive.

## Invariants

- No intentional visual change. Captures must match the current factory-log
  screenshots in dark and light at 1280 and 390.
- All information, icons, keyboard behaviour (focus trap / Escape return), 30px
  hit areas, contrast and connection error state remain.
- `npm run verify` stays green; CI must not require a real Factorio game.

## Phase 1 — regression net first

Build a dependency-light browser check (Playwright preferred, system Edge/Chromium
allowed) against mocked manager responses so no game is needed:

- widths 1280 and 390;
- dark and light themes;
- normal transcript and map dialog;
- simulated `/api/runs*` failure;
- measurements: horizontal overflow, text contrast, target sizes, focus trap and
  focus return;
- pixel/screenshots stored under `.ui-review/` or `tests/visual/baseline/`.

The check must be runnable on Windows and CI. Until this exists, do not move CSS.

Implemented in `scripts/ui-regression.mjs` + `scripts/ui-regression-fixture.mjs`:

- serves the real recording page and mocked run/event/telemetry responses;
- runs system Edge/Chrome headless, no game or manager;
- asserts metric/radar geometry, contrast, 30px targets, icon scale,
  dialog focus trap/return, connection-alert state, no horizontal overflow;
- writes screenshots to ignored `.ui-review/ui-regression/`;
- `npm run test:ui`; CI runs it on Windows with `AUTORIO_UI_REQUIRED=1`.

## Phase 2 — extract modules

Replace the single file with ordered imports so the cascade stays equivalent:

- `public/styles/tokens.css` — type/color/spacing/icon tokens and theme variables;
- `public/styles/base.css` — document, typography, shared controls;
- `public/styles/dashboard.css` — index, run, compare pages;
- `public/styles/recording.css` — status header, readouts, toolbar, transcript,
  map dialog, connection notice, responsive rules;
- `public/runs.css` becomes the ordered entry point (`@import`).
- Keep each URL cacheable and included in packaging/release checks.

## Phase 3 — remove duplicates

Work selector groups in this order, re-running captures after each:

1. `body.recording` tokens/backgrounds;
2. status line/meta/current/done/scores/telemetry;
3. toolbar/chips/search;
4. transcript rows/badges/dialog/error;
5. responsive blocks.

Use one authoritative rule per property; retire earlier passes. Do not add new
`!important` rules. Keep theme overrides scoped by `html[data-theme="light"]`.

## Phase 4 — close

- Compare captures and measured invariants with Phase 1.
- Run `npm run verify` and the browser check.
- Update `docs/ui-skills-audit.md`, CHANGELOG, visual baseline notes.
- Release a patch version when the refactor is only structural.
