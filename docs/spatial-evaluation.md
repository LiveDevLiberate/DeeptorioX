# Spatial / pipeline evaluation

These fixtures are part of the normal `npm test` / `unittest` regression gate.

| category | fixture | expected behavior |
|---|---|---|
| direction | `tests/test_spatial_eval.py::test_direction_convention_for_loaders` | inserter/loader direction is the pickup side; drop is opposite |
| pipeline ports | `tests/spatial-eval.test.mjs::pipeline graph finds ports...` | machine input/output inserters, recipe/status, belt segments |
| break detection | same Node fixture | `belt_no_input` / `belt_dead_end` become bottlenecks |
| bottleneck | same Node fixture + `tests/pipeline-graph.test.mjs` | critical factory and belt issues are prioritized |
| path | `tests/test_spatial_eval.py::test_path_finds_orthogonal_detour` | A* route stays on free cells and is orthogonal |
| collision | `tests/test_spatial_eval.py::test_collision_check_reports_overlap` | rotated footprints and overlaps are detected |

Live smoke test (requires a running game):

```bash
python3 factorio.py observe-pipeline --radius 40
python3 factorio.py observe-free-space --radius 25 --step 1
python3 factorio.py geometry-check --entity transport-belt,0,0
```

The 2026-11-06 checkpoint was used for a live smoke test: pipeline returned
machines/inserters/pipes/power nodes and bottlenecks, free-space returned a
buildable grid with components, and geometry-check returned `ok`.

## Operator view

Open `/pipeline.html` while the game is running to inspect the same graph used by the agent.

## Measured flow check

```bash
python3 factorio.py observe-pipeline --radius 40 --flow transport-belt@10,20=7.5
```

The matching belt/machine/segment reports `actual_flow: 7.5`; capacity and contained items remain independent.
