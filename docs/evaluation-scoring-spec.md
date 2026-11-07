# Evaluation Scoring Spec (v2)

Status: implemented (`scoring.version = 2`). This document is the single reference for
how a benchmark run is scored, what is configurable, and what the operator UI shows.
It consolidates the scoring discussion; code references point at the implementing modules.

## 1. Goals and non-goals

**Goals**

- One **ranking metric** per benchmark that is time-normalised, monotonic, reproducible and
  comparable across runs/models.
- Keep **discipline/behaviour signals** (manual work, stale plans, blackouts, ignored alerts,
  refactor debt) visible to the operator **separately**, without mixing them into the ranking.
- Make every scoring parameter live in the versioned benchmark config, with provenance, so a
  ranking is always explainable and re-computable.
- Keep the whole evaluation **operator-only**: the agent never sees the score, its components,
  or the prompts that describe them.

**Non-goals**

- No per-run scoring overrides (one benchmark config = one scoring setup; runs stay comparable).
- No score-driven agent behaviour: gates (STATE / ALERTS / REFACTOR / BLUEPRINT) remain the only
  feedback mechanism that constrains actions.
- No hostile-agent isolation: the API is cooperative; the score is hidden from the documented
  agent surface, not protected by authentication.
- No automatic big reset: `big_reset_pending` stays a warning for the operator.

## 2. Concept model

```text
benchmarks/*.json                       telemetry (sample_seconds)
  milestones, completion                  production / research / rockets
  scoring: par, weights, ranked                  │
        │                                        ▼
        └──────────────► run lifecycle: recordSnapshot ──► run.evaluation
                                                         ├─ capability  (ranking, 0-1000)
                                                         ├─ discipline  (report only)
                                                         └─ computed_at
                                                              │
                        run.scoring (config snapshot) ────────┤
                                                              ▼
                       operator UI: run page / recording / SUMMARY.md
                       agent surface: not exposed (/api/agent/*, prompts)
```

Two scores, never added together:

| Output | Meaning | Used for |
| --- | --- | --- |
| `capability` | how fast/complete the agent achieved the benchmark objective | ranking, cross-run comparison |
| `discipline` | how cleanly it played (manual work, plan hygiene, power, alerts, refactor) | operator report, flags, qualitative review |

Legacy `run.automation` (v1 mixed `score = positive - penalty`) is retained in `run.json` for
historical comparison only and is labelled legacy. It is not used for ranking.

## 3. Benchmark configuration (L1: the only parameter entry point)

Every `benchmarks/<id>.json` gains a `scoring` block. Missing blocks are normalised to v1
defaults by the loader, so old benchmark files still load.

```json
"scoring": {
  "version": 2,
  "ranked": true,
  "completion_basis": "milestone_first_seen",
  "par_seconds": 641,
  "par_source": "median_completed:2026-11-08 (n=1, provisional)",
  "progress_weights": { "first-plate": 0.3, "twenty-plates": 0.7 }
}
```

| Field | Type | Semantics |
| --- | --- | --- |
| `version` | integer ≥1, default 1 | formula/config generation; bump when the formula or the scored set changes |
| `ranked` | boolean, default true | false = runs of this benchmark are not ranked (e.g. smoke is an API smoke test) |
| `completion_basis` | `"milestone_first_seen"` | completion time = first-observed milestone time; other values are rejected |
| `par_seconds` | number > 0, default `max_seconds/3` | reference completion time; finishing at par = 750 points |
| `par_source` | non-empty string, default `configured` / `fallback:max_seconds/3` | provenance, written by the calibration script |
| `progress_weights` | object, keys = tracked milestone ids, values > 0 | **explicit scored set**: unlisted milestones contribute nothing; weight sum need not be 1 |

Validation (performed by `normalizeScoring` in `src/benchmarks.ts`, invalid config throws
`Invalid benchmark: <file>` at load time):

- unknown milestone id → error;
- non-finite / non-positive weight → error;
- the benchmark `completion` milestone must be present and scored;
- `completion_basis` must be exactly `milestone_first_seen`;
- explicit weights are NOT rescaled: `progress = Σ(w·achieved) / Σ(w)` over listed keys.

Defaults when `scoring` is absent: `version=1`, `ranked=true`,
`completion_basis="milestone_first_seen"`, `par_seconds=max(1, round(max_seconds/3))`,
`par_source="fallback:max_seconds/3"`, `progress_weights = { every declared milestone: 1 }`
(declared milestones only — auto-tracked science-research milestones are not added).

## 4. Runtime data model (run.json)

```json
{
  "scoring": { ...resolved scoring config, fixed at run start... },
  "evaluation": {
    "capability": {
      "score": 750, "max": 1000, "completed": true,
      "progress": 1,
      "milestones": { "completed": 2, "total": 2 },
      "next_milestone": "…", "next_milestone_label": "…",
      "completion_seconds": 641.0,
      "par_seconds": 641, "par_source": "median_completed:…",
      "scoring_version": 2,
      "breakdown": [{ "id": "first-plate", "label": "…", "weight": 0.3, "achieved": 1 }]
    },
    "discipline": {
      "manual_mines": 12, "manual_crafts": 3,
      "blackouts": 0, "alert_penalty": 0,
      "state_due_seconds": 0, "state_blocked_seconds": 0,
      "refactor": { "debt_peak": 18, "invalid_count": 0, "cleanup_units": 7, "tier": "normal", "audits_with_debt": 2 },
      "flags": ["manual_work", "refactor_debt"]
    },
    "computed_at": "2026-11-08T…Z"
  },
  "state_metrics": { "due_seconds": 0, "blocked_seconds": 0 },
  "automation": { "...": "legacy v1 mixed score, not ranked" }
}
```

- `run.scoring` is copied from `benchmark.scoring` at run start and never changes afterwards, so a
  later benchmark edit cannot rewrite history.
- `run.evaluation` is recomputed on every telemetry snapshot (and therefore on pause/finish snapshots).
- `run.state_metrics` accumulates `due_seconds` / `blocked_seconds` from STATE.md status using the
  elapsed-active-time delta between samples.
- `refactor.debt_peak` records the highest invalid count seen by audits during the run.

## 5. Capability algorithm

Inputs: resolved scoring config, `run.milestones` (first-observed timing), latest/baseline game
snapshot, active-play seconds. Implemented in `src/evaluation-score.ts`.

### 5.1 Per-milestone achievement (0..1)

- recorded in `run.milestones` → `1`;
- `production` → `clamp01((latest.production[name] - baseline.production[name]) / count)`;
- `research` → `1` when `latest.research[name] === true` else `0`;
- `rockets` → `clamp01((latest.rockets - baseline.rockets) / count)`.

### 5.2 Weighted progress

```text
progress = Σ(wᵢ · achievedᵢ) / Σwᵢ     over the explicit scored milestone set
```

`progress` is monotonic non-decreasing. Display counts (`milestones.completed/total`,
`next_milestone`) are derived from the scored set, not from auto-tracked research milestones.

### 5.3 Score

```text
completed   : score = round(500 + 500·r/(1+r)),  r = par_seconds / max(1, completion_seconds)
              clamped to 500..1000
unfinished  : score = min(499, round(499 · progress))     → 0..499
```

Properties:

- completed runs always outrank unfinished ones (`≥500` vs `≤499`);
- among completed runs, faster completion ⇒ higher score (monotonic in time);
- `par` only sets the 750 anchor and the compression of the scale; it does not change the ranking
  of completed runs;
- `completion_seconds` = `run.milestones[benchmark.completion].wall_seconds` (active play time
  excluding pause/loading, sampled at `sample_seconds` granularity). Run-end time is never used.

Reference points: `t = par/4 → 900`, `t = par/2 → 833`, `t = par → 750`, `t = 2·par → 667`,
`t = 4·par → 600`, `t = 10·par → 545`.

## 6. Discipline metrics (reported, never ranked)

`computeDiscipline` produces:

- `manual_mines` / `manual_crafts` — from existing manual-work counters;
- `blackouts` — count of power-blackout transitions;
- `alert_penalty` — internal alert-ignore accounting (legacy v1 penalty value, kept as signal);
- `state_due_seconds` / `state_blocked_seconds` — accumulated from `run.state_metrics`;
- `refactor` — `debt_peak`, `invalid_count`, `cleanup_units`, `tier` (`escalation_tier`), `audits_with_debt`;
- `flags` — stable machine-readable labels: `manual_work`, `blackouts`, `alerts_ignored`,
  `state_blocked`, `state_stale`, `refactor_debt`.

No arithmetic combination of discipline values enters `capability.score`.

## 7. Calibration and versioning

`par_seconds` is the only score-affecting value that needs periodic calibration.
Method: **median completion time of completed runs** per benchmark (median run scores 750).

```bash
node scripts/calibrate-scoring.mjs --data-dir <runs-dir>
node scripts/calibrate-scoring.mjs --data-dir <runs-dir> --apply
```

- Dry run (default) prints per-benchmark: `completed`, `median`, provisional marker, suggested
  `par_seconds`, plus per-milestone median times (useful input for adjusting weights by hand).
- `--apply` writes `scoring.par_seconds` and
  `scoring.par_source = "median_completed:<YYYY-MM-DD> (n=<k>[, provisional])"` back into
  `benchmarks/<id>.json`.
- `n < 3` is marked **provisional**. A benchmark with zero completions keeps its fallback par
  (`max_seconds/3`) and stays provisional until a completion exists.
- Recalibrating par does not change ranking order of completed runs, only the absolute scale; still,
  record the change through `par_source` (and bump `scoring.version` when the formula or scored set
  changes) so cross-model comparisons remain interpretable.

## 8. UI specification (operator-only)

### 8.1 Recording window — readout table

The recording status area has two content panels: the **plan panel** (`#planPanel`, "Work order")
and the **telemetry panel** (`#telemetryPanel`, "Readouts"). Everything evaluation-related renders
inside the telemetry panel's readout table (`#statusMetrics`) built by `renderMetrics` in
`public/recording.js`, using the DOM-free helper `milestoneProgressView` in
`public/transcript-view-model.js`.

The table has a milestone row (only when `evaluation.capability` exists) with three columns:
`Milestones`/`里程碑` title → next milestone (`Next:`/`下一个:`) → progress bar/percent/count.

| Condition | Title (1st) | Next milestone (2nd) | Progress (3rd) |
| --- | --- | --- | --- |
| no `evaluation.capability` or `total <= 0` | row omitted | — | — |
| `total <= 6` | `Milestones` / `里程碑` | `Next: <localized target>` / `下一个: …` | dots + `3/6` |
| `total > 6` | `Milestones` / `里程碑` | `Next: <localized target>` / `下一个: …` | bar + `42%` + `3/7` |
| `completed` | `Milestones` / `里程碑` | `Completed` / `已完成` | bar + `100%` + `N/N` + `✓ MM:SS` |

`total`/`completed` are the scored-set counts; `next` is the first not-yet-achieved scored
milestone. Its label is localised: production milestones use the locale item name, research
milestones the technology name, rocket milestones the UI string, and the `next:` prefix follows the
run language. The row truncates on narrow widths. Below it the table continues
with the Research, Power and Discipline rows (research/power from telemetry samples; discipline
badges from `evaluation.discipline`).

The legacy v1 **Automation** and **Penalty** metric rows are no longer rendered in the recording
window (they only remain as `run.automation` in `run.json`, labelled legacy on the run page). In
their place, a single neutral **Discipline** badge row appears only when something is non-zero:
manual work (mines + crafts), blackouts and accumulated alert penalty. Each badge uses the
`icon + label + count` format (e.g. `⛏ Manual 13`, `⚡ Blackouts 2`, `🚨 Alerts 75`); badges are
counts, never signed scores, and capability stays on the run and comparison pages.

### 8.2 Run details page

`public/run.js` run information adds (operator view):

- `Capability` — `score / 1000`;
- `Capability detail` — `completed in <s>` or `progress <pct>%`;
- `Milestones (scored)` — `completed/total`;
- `Scoring` — `v2 · par <s> · <par_source>`;
- `Discipline flags` — comma-joined flags;
- legacy automation score relabelled `Automation score (legacy v1)`.

`SUMMARY.md` includes Capability, Milestones, Scoring (version/par/source) and Discipline flags.

The run page also renders a **Discipline panel** (`#disciplinePanel`), hidden when the run has no
`evaluation.discipline`:

| Field | Source |
| --- | --- |
| Manual mines / manual crafts | `discipline.manual_mines` / `manual_crafts` |
| Blackouts / alert penalty | `discipline.blackouts` / `alert_penalty` |
| STATE due / STATE blocked | `discipline.state_due_seconds` / `state_blocked_seconds` |
| Refactor debt peak / invalid now / cleanup units / tier / debt audits | `discipline.refactor.*` |
| Flags | `discipline.flags` (comma-joined, `none` when empty) |

The panel header summarises `capability <score>/<max> · scoring v<version> · par <par>s`.

### 8.3 Comparison page

`public/compare.js` (operator page for 2+ selected runs):

- columns are **ranked by capability** (descending; runs without an evaluation keep selection order
  after ranked runs) and the header shows `#1`, `#2`, … before the run link;
- rows: Agent, Result, Failure kind, **Capability** (`score / max · completed|progress%`),
  **Completion time** (`time (par Ns)` when completed), **Milestones (scored)** `c/t`,
  **Discipline flags**, manual mines/crafts, Blackouts, STATE blocked, Refactor debt peak,
  Automation score (legacy), Active play time, tokens, then per-milestone first-seen times;
- if the selected runs disagree on `scoring.version` or `par_seconds`, `#scoringNotice` shows
  "Different scoring configuration … capability scores are not directly comparable.".

### 8.4 Not yet migrated (open items)

- Optional evaluation dashboard (scatter capability vs completion time, filters by benchmark/model).

## 9. Edge cases

| Case | Behaviour |
| --- | --- |
| no completed run | `completed=false`, score = `499 × progress`; completion_seconds omitted |
| timed_out / failed / stopped | same as unfinished; progress frozen at last sample |
| run completed but completion milestone missing | impossible through normal flow (auto-finish is milestone-triggered); defensively treated as unfinished |
| resume after pause | milestones keep the original first-seen times; active seconds exclude pause; evaluation recomputed on the next snapshot |
| empty/degenerate snapshot | achievement falls back to 0, never negative; scoring does not throw |
| par missing/invalid | loader falls back to `max_seconds/3` with `par_source="fallback:max_seconds/3"` |
| invalid scoring config | manager startup/benchmark load fails loudly (`Invalid benchmark`) |
| agent visibility | evaluation fields are never returned by `/api/agent/*`; prompts/playbook do not mention them (cooperative boundary remains) |

## 10. Testing and acceptance

- `tests/evaluation-score.test.mjs` — achievement fractions, weighted progress, completed formula
  at par/fast/slow, research/rocket milestones, `normalizeScoring` defaults + validation, discipline flags.
- `tests/calibrate-scoring.test.mjs` — completion-time extraction, median suggestion, `--apply`
  round-trip, no-completion benchmarks.
- `tests/runs.test.mjs` — integration: run completes a milestone, `run.evaluation.capability`
  becomes completed with `completion_seconds`, `par_seconds` from the benchmark snapshot, and the
  legacy automation block is retained.
- Recording UI tests: `tests/transcript-view-model.test.mjs` (dots/bar/completed/null) and
  `tests/recording-page.test.mjs` (dots and bar fixtures, static structure).
- Acceptance: `npm run verify` green (build, Node tests, Python client tests, repo hygiene,
  Prettier, ESLint).

## 11. Current benchmark parameters (2026-11-08)

| Benchmark | ranked | par_seconds | par_source | progress_weights |
| --- | --- | --- | --- | --- |
| smoke | false | 15 | `median_completed:2026-11-08 (n=8)` | `first-gear: 1` |
| automation | true | 641 | `median_completed:2026-11-08 (n=1, provisional)` | `first-plate: 0.3, twenty-plates: 0.7` |
| rocket | true | 9600 | `fallback:max_seconds/3 (no completed runs)` | 7 milestones, sum 1.0: `first-plate .05`, `first-science .10`, `automation .10`, `logistic-science .15`, `chemical-science .20`, `rocket-silo .20`, `rocket-launched .20` |

Derivation data: 18 historical runs under `C:\Users\Roger\autorio-test\.autorio\runs`
(8 smoke completions median 15.1s; 1 automation completion 641.0s; 0 rocket completions).
Automation and rocket values are provisional; recalibrate after the next run batch.

## 12. Change log

- **v2** — capability (time-normalised, 0-1000) + discipline (report-only) split; benchmark
  `scoring` config; explicit progress weights; milestone-first-seen completion basis; calibration
  script; run config snapshot; recording adaptive milestone row; run page capability rows;
  legacy automation retained but unranked.
- **v1** (legacy) — single mixed `score = positive − penalty` from production/science/power/
  research/rockets/refactor minus manual/STATE/blackout/alert penalties. Kept in `run.json` for
  history only.
