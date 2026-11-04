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

### Phase 2 progress (round 2)

- `public/runs.css` is now a 6-line ordered entry point; modules:
  `styles/tokens.css`, `styles/base.css`, `styles/recording.css`,
  `styles/dashboard.css`, `styles/recording-modern.css`.
- The split boundaries preserve the exact original source order. All six
  regression screenshots are byte-for-byte identical (0 pixels differ) before
  and after the split.
- `tokens.css` now owns the base `:root` design tokens; theme/recording token
  overrides still live in their modules until duplicate cleanup.
- Remaining: repeated selectors and legacy override passes (Phase 3).

### Phase 3 progress

- Removed **221 fully shadowed rules** (822 lines) across base/recording/modern:
  a rule was removed only when every declaration it set was re-declared later
  for the same selector and at-rule context.
- Totals: `public/styles/*.css` **5,889 → 5,067 lines**, rules **1,123 → 902**.
- Re-ran the full browser suite: all six screenshots still pixel-identical to the
  pre-split baseline.
- No fully-shadowed rules remain; further cleanup needs context-aware
  consolidation of the remaining repeated selectors/declarations.
- Removed the superseded **colour system v2** block (120 lines); pixel test
  remains byte-identical.
- Added **computed-style regression**: `tests/ui-style-baseline.json` records
  colors, backgrounds, borders, fonts, spacing and layout properties for 27
  main selectors + dialog/error surfaces per theme/width. It caught the tentative
  removal of the modern-v4 pass (e.g. section-kicker line-height, plan border
  colour). Update deliberately with
  `AUTORIO_UI_UPDATE_BASELINE=1 npm run test:ui`.

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

### Phase 3 progress (round 5)

- Consolidated the repeated status selector chains: removed earlier
  `status-current`, `status-scores`, `status-meta`, `status-data`, status icon
  and connection-notice declarations after moving the still-effective properties
  into the final rules.
- Stylesheet modules now **4,947 → 4,861 lines**, rules **902 → 871**; all six
  screenshots remain pixel-identical.
- Added `#statusCurrent .icon`, `#statusMeta` and `.status-readout` to the
  computed-style baseline after finding that the meta line's letter-spacing and
  icon margin were not covered by the previous fingerprint.

### Regression coverage (round 6)

- Added collapsed-status and overlay captures to the computed-style baseline
  (fonts, colors, borders, layout, ordering, overflow), so legacy cleanup cannot
  silently break compact/OBS states.
- Screenshot runs now use a `noaudit=1` fixture mode and blur transient focus,
  so artifacts capture the page rather than the end state of the keyboard/focus
  audit.
- Largest remaining legacy candidate: `base.css`'s old transcript block
  (~294 lines). A trial removal required moving several fallback properties to
  the final rules; it is deferred until the screenshot path itself is stable.

### Phase 3 progress (round 7)

- Retried the `base.css` legacy transcript cleanup now that screenshots run in a
  stable no-audit state. Removed **245 lines** of pre-recording transcript/filter/
  jump styling while preserving the dashboard `.run-info`, `.production-list`,
  `.chart-legend` and `.science-marker` blocks.
- Moved the still-needed fallbacks into the final rules: `white-space: pre-wrap`,
  `overflow-wrap: anywhere`, summary `white-space: normal` + `cursor: pointer`,
  and jump-pill `position: fixed`/`z-index`/`cursor`.
- All six screenshots are **pixel-identical** to the pre-removal stable capture.
- Stylesheet modules: **4,861 → 4,623 lines**.

### Phase 3 progress (round 8)

- Removed the obsolete modern-v4 light/panel/microcopy tail (28 lines) while
  retaining its header-layout rules, light stale-plan border, and the computed
  chip border sides.
- Initial whole-section removal was rejected because it changed header height and
  the error notice; the retained subset is the minimum effective part.
- Stable before/after screenshots remain **pixel-identical**. Stylesheet modules:
  **4,623 → 4,586 lines**.

### Phase 3 progress (round 9)

- Ran a declaration-level redundancy pass: for single-selector rules with the
  same at-rule context, removed declarations that a later identical selector
  re-declares (importance-aware). Removed **86 declarations / 5 whole rules**;
  preserved computed chip border roles where the old declaration was still the
  effective one.
- Stylesheet modules: **4,586 → 4,523 lines**. All six stable screenshots remain
  pixel-identical.

### Phase 3 progress (round 10)

- Extended declaration redundancy removal to grouped selectors: a declaration is
  dropped only when *every* selector in the group has a later same-property
  declaration in the same at-rule context. Removed another 21 declarations.
- Modules: **4,523 → 4,469 lines** after removing 21 declarations and internal
  blank lines left by declaration-level edits; six stable screenshots remain
  pixel-identical.
- An experimental whole-rule merge of repeated selectors was rejected: moving
  declarations changed cascade-sensitive chip/filter/layout results. Future
  consolidation must remain rule-local.
