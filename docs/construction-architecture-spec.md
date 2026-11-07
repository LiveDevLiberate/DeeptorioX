# Construction Architecture Spec (v1)

Status: proposal. Scope: construction modes, plan authorization, audit boundaries,
and benchmark/scoring integration.

This spec separates two concerns that were previously mixed:

1. **What an agent is allowed to construct** (construction mode / plan gate).
2. **How an agent's run is scored** (benchmark variant + capability/discipline scoring).

The legacy free-build path remains available as an **evaluation mode**. It is not the
production path and it is not ranked together with plan-gated runs.

---

## 1. Goals and non-goals

### Goals

- Make the manager, not the prompt, the authority for construction changes.
- Cover every entity placement, mutation and cleanup action, not only power/pipe.
- Keep the agent free to choose *what* to build while forcing it through a validated
  planning step for *how* the change is executed.
- Keep `factory-audit` / `pipeline-audit` as read-only diagnosis and verification.
- Preserve the legacy free-build experience as a benchmark mode that measures raw
  agent capability.
- Record the construction mode in the run, benchmark and scoring identity so free and
  planned runs are never compared as if they were the same task.
- Make every plan explainable: targets, scope, audit revision, result and delta.

### Non-goals

- Full hostile-agent isolation. The API remains cooperative by default.
- Making plan-gated mode mandatory for every historical benchmark.
- Adding a construction bonus/penalty to the capability score. Mode is a **variant**,
  not a score multiplier.
- Automatic base reset or automatic working-block demolition.
- Replacing game mechanics or the existing STATE/ALERT gates.

---

## 2. Construction modes

A run has exactly one immutable mode, snapshotted at run start:

```ts
type ConstructionMode = "free" | "planned";
```

### 2.1 `free` — legacy / free-build evaluation mode

Purpose: measure what an agent can do when construction is unconstrained.

Characteristics:

- Direct `/api/agent/act/build` and the other legacy action endpoints are allowed.
- No plan token, no plan-scope validation, no refactor build gate.
- Audit runs are metrics-only: they record debt, topology and problems but do not
  block construction and do not award build credits.
- Existing STATE / ALERT gates and normal game/API limits still apply.
- The run records `construction.mode = "free"` and free-mode metrics.
- Free mode is a benchmark **variant**, not a fallback for planned mode.

Free mode is the compatibility mode for older benchmarks and for capability
evaluation where the question is "can the agent build a factory at all?".

### 2.2 `planned` — plan-gated construction mode

Purpose: evaluate controlled construction quality and make construction auditable.

Characteristics:

- Every entity placement requires a valid plan token.
- Every mutation (`rotate`, `set-recipe`, `copy-settings`) requires a token bound to
  the affected tiles.
- Every cleanup/removal of a player-owned entity requires a cleanup token.
- The manager authorizes scope from the current audit snapshot and refactor revision.
- The audit is read-only: it supplies `audit_revision`, `actions`, `clusters`, and
  post-plan verification data. It does not award credits or force demolition.
- Raw action endpoints reject requests without a token.

### 2.3 Invariants

```text
construction.mode is selected at run creation and never changes mid-run
run.construction.mode must be allowed by benchmark.construction.modes
run.scoring.construction_mode === construction.mode
run.evaluation.capability.variant includes the construction variant
```

A mode switch requires a new run (and normally a new benchmark variant).

---

## 3. Benchmark and scoring integration

The existing evaluation scoring v2 remains the ranking formula. Construction mode is
part of the **score identity**, not an additive score component.

### 3.1 Benchmark configuration

Each `benchmarks/<id>.json` may add:

```json
"construction": {
  "default_mode": "free",
  "modes": ["free", "planned"],
  "variant": "free-build-v1",
  "blueprints": {
    "enabled": true,
    "source": "agent",
    "catalog": "run"
  }
}
```

Fields:

| Field | Type | Meaning |
| --- | --- | --- |
| `default_mode` | `"free" \| "planned"` | mode used when the launcher does not specify one |
| `modes` | array | modes this benchmark may run in; first entry is the canonical variant |
| `variant` | string | stable benchmark variant name used for leaderboard grouping |
| `blueprints.enabled` | boolean | whether blueprint-assisted construction is allowed |
| `blueprints.source` | `"none" \| "agent" \| "preloaded"` | where blueprints may come from |
| `blueprints.catalog` | string | optional preloaded catalog id; `run` means agent-captured blueprints only |

Defaults for old configs:

```json
"construction": {
  "default_mode": "free",
  "modes": ["free"],
  "variant": "legacy-free"
}
```

This keeps historical benchmarks runnable and clearly identifies them as free-build.
This keeps historical benchmarks runnable and clearly identifies them as free-build.

Blueprint policy is part of the variant identity. A run using a preloaded blueprint
catalog is not comparable to an agent-authored-blueprint run, even when both use the
same construction mode.

If a benchmark wants both modes, it must define both variants explicitly, for example:

- `rocket-free-build` (mode `free`)
- `rocket-planned-build` (mode `planned`)

The run's mode is selected at launch, not by the agent.

### 3.2 Run snapshot

At run start:

```json
{
  "construction": {
    "mode": "free",
    "variant": "free-build-v1",
    "plan_required": false,
    "blueprints": {
      "enabled": true,
      "source": "agent",
      "catalog": "run",
      "catalog_hash": null
    }
  },
  "scoring": {
    "version": 2,
    "construction_mode": "free",
    "benchmark_variant": "free-build-v1",
    "blueprint_policy": "agent"
  }
}
```

At scoring time:

```json
"evaluation": {
  "capability": {
    "score": 812,
    "variant": "free-build-v1",
    "construction_mode": "free",
    "blueprint_policy": "agent",
    "...": "existing v2 fields"
  },
  "discipline": {
    "construction": {
      "mode": "free",
      "free_actions": 143,
      "planned_actions": 0,
      "unplanned_actions": 143,
      "plan_requests": 0,
      "plan_rejections": 0,
      "plan_ineffective": 0,
      "plan_regressions": 0,
      "cleanup_units": 12,
      "blueprints_used": 2,
      "blueprint_entities_planned": 48,
      "blueprint_entities_placed": 48,
      "blueprint_entities_failed": 0
    },
    "...": "existing discipline fields"
  }
}
```

### 3.3 Scoring rule

**Do not add a free/planned bonus to `capability.score`.**

- The v2 capability formula stays unchanged: milestone progression and time-normalized
  completion.
- Construction mode is encoded in the score variant and run snapshot.
- Leaderboards and comparisons group by:

```text
benchmark.id + ":" + benchmark.construction.variant
```

- A cross-variant comparison must be labelled as a comparison, never presented as the
  same ranking.
- The operator UI shows a `Free build` / `Planned build` badge next to the score.

This directly satisfies the requirement that **whether a run used the free-build mode
is part of its benchmark score record**, without changing the meaning of the score.

### 3.4 Discipline metrics

Construction signals stay in `discipline`, never in `capability`:

```text
construction mode
planned_actions
free_actions
unplanned_actions
plan_requests
plan_rejections
plan_ineffective
plan_regressions
cleanup_units
blueprints_used
blueprint_entities_planned
blueprint_entities_placed
blueprint_entities_failed
```

`unplanned_actions > 0` in planned mode is a discipline flag (`plan_bypass`). In free
mode it is expected and is not a violation.

Suggested flags:

```text
free_build
plan_bypass
plan_scope_violation
plan_ineffective
planned_cleanup
```

### 3.5 Free-build as evaluation mode

Free mode is useful for measuring:

- raw layout ability,
- planning ability without manager scaffolding,
- tool discovery and recovery from failure,
- whether an agent can build from observation alone.

It is **not** a substitute for plan-gated evaluation and must not share a leaderboard
with it. Both modes use the same capability milestones and par calibration method, but
their variants remain separate.

---

## 4. Planned-mode architecture

### 4.1 Component layout

```text
Agent / Python / CLI / MCP / Gym
        │
        ▼
Construction tools
build-line / build-power-network / blueprint / plan-build
        │
        ▼
Manager Plan Service
├── audit snapshot provider
├── planner / validator
├── scope policy
├── token store
└── revision guard
        │
        ▼
Action Executor
build / rotate / set-recipe / copy-settings / cleanup
        │
        ▼
Factorio RCON
        │
        ▼
Verifier
factory-audit / pipeline-audit / before-after delta
```

### 4.2 Audit layer

Responsibilities:

- Read-only factory diagnosis: `factory-audit`, `pipeline-audit`.
- Produce `audit_revision`, `actions`, `clusters`, topology summaries.
- Provide the baseline and post-plan snapshots for verification.
- Detect ineffective or regressing plans.

Not responsible for:

- awarding build credits,
- blocking ordinary local repairs,
- forcing demolition,
- serving as an agent-facing punishment score.

The existing `refactor` state may remain as operator telemetry and scope input, but its
credit and punitive-tier behavior is deprecated in planned mode.

### 4.3 Plan service

All construction actions begin with a plan request:

```http
POST /api/agent/plan
Content-Type: application/json

{
  "kind": "build",
  "intent": {
    "summary": "connect coal to boiler",
    "targets": [{"x": -24, "y": -40}]
  },
  "entities": [
    {"name": "pipe", "anchor": {"x": -24, "y": -39}}
  ],
  "window": {"x": -24, "y": -39, "radius": 20},
  "audit_revision": 42
}
```

The service:

1. Loads the current audit snapshot (or rejects if the requested revision is stale).
2. Validates the plan kind and target coverage.
3. Runs planner/geometry validation:
   - collision, reach, clearance for ordinary builds;
   - pole coverage/alignment for power plans;
   - pipe connectivity/underground policy for fluid plans;
   - cluster/working-block protection for cleanup plans.
4. Applies the scope policy.
5. Stores the plan and returns a single-use token.

### 4.4 Plan token

```ts
type ConstructionPlan = {
  plan_id: string;
  run_id: string;
  mode: "planned";

  kind: "build" | "mutation" | "cleanup" | "expansion" | "blueprint";
  scope: "local_repair" | "in_cluster" | "cleanup" | "expansion";

  created_at: number;
  expires_at: number;

  audit_revision: number;
  refactor_revision: number;

  targets_hash: string;
  bbox: { left: number; top: number; right: number; bottom: number };
  entities: Array<{ name: string; anchor: { x: number; y: number }; direction?: number }>;

  allowed_entity_names: string[];
  max_entities: number;

  single_use: true;
  status: "issued" | "consumed" | "expired" | "invalidated";
};
```

Persistence:

- Tokens live in the run directory (`construction-plans.jsonl` or `run.json`), not only
  in memory.
- Expired/consumed tokens are retained for audit.
- A manager restart invalidates issued-but-unconsumed tokens; the agent must re-plan.

### 4.5 Plan kinds and permissions

| Kind | Allowed operations | Scope rule |
| --- | --- | --- |
| `build` | place any entity | inside allowed cluster for repair; outside only as `expansion` |
| `blueprint` | place expanded blueprint entities | same as build; preserves plan hash |
| `mutation` | rotate / set-recipe / copy-settings | affected tiles must be in scope |
| `cleanup` | mine/deconstruct player-owned entities | only flagged/obsolete entities; never a working production block |
| `expansion` | place outside clusters | only when audit debt is below the clean target |

All entity prototypes are covered. There is no power/pipe-only allowlist.
| `expansion` | place outside clusters | only when audit debt is below the clean target |

All entity prototypes are covered. There is no power/pipe-only allowlist.

### 4.5.1 Blueprint integration

A blueprint is a **design**, not an authorization. In planned mode, placing a
blueprint is still a construction plan and goes through the same scope, validation,
execution and verification path as a hand-written entity list.

#### Blueprint sources

- `agent`: blueprint captured or authored by the agent in this run.
- `preloaded`: benchmark-provided catalog (documented and versioned).
- `none`: blueprint placement is disabled.

Capture and evaluation are read-only design operations and do not require a
construction plan. Only **building** from a blueprint is gated.

#### Plan request

The agent references a registered blueprint and supplies placement intent only:

```json
{
  "kind": "blueprint",
  "blueprint_id": "bp_01J...",
  "anchor": {"x": -24, "y": -40},
  "rotation": 0,
  "mirror": false,
  "window": {"x": -24, "y": -40, "radius": 40},
  "audit_revision": 42
}
```

The plan service, not the raw build endpoint, expands the blueprint:

1. decode/validate the blueprint string;
2. expand entities relative to anchor/rotation/mirror;
3. resolve recipes, filters, modules and underground subtypes;
4. compute footprint, required items and entity hash;
5. run the same collision/reach/scope policy as a normal plan;
6. store the canonical expanded entity list in the plan token;
7. return a `blueprint` plan token.

The execution payload is only:

```json
{ "plan_id": "pln_...", "action": "build-blueprint" }
```

The executor uses the token's stored entity list. The client must not re-expand or
substitute a different blueprint at execution time.

#### Token binding

`blueprint` plans extend the token with:

```ts
{
  source: "blueprint",
  blueprint_id: string,
  blueprint_hash: string,
  anchor: { x: number; y: number },
  rotation: 0 | 2 | 4 | 6,
  mirror: boolean,
  expanded_entities_hash: string,
  required_items: Record<string, number>
}
```

`targets_hash` is the hash of the expanded entity set including anchor, rotation and
mirror. A different blueprint, anchor or rotation returns `PLAN_TARGET_MISMATCH`.

#### Blueprint-specific validation

- **Material preflight**: missing items reject the plan before the job is queued
  (`BLUEPRINT_MATERIAL_SHORTAGE`). There is no implicit partial build unless the
  benchmark configuration explicitly permits it.
- **Placement**: every expanded entity must fit inside the plan window and scope.
- **Underground entities**: input/output subtypes are preserved from the blueprint;
  direction/rotation validation is mandatory.
- **Power/fluid**: the same planners and topology audit apply; a blueprint cannot
  bypass pole-coverage or pipe-topology validation.
- **Obstacles**: clearing trees/rocks is allowed; removing player-owned entities
  requires a separate `cleanup` plan. A blueprint plan never silently deletes a
  working production block.
- **Scope**: the full blueprint footprint must fit the allowed cluster or be classified
  as `expansion`.

#### Partial and chunked execution

Blueprints may exceed the per-job entity limit. The plan is executed in ordered
chunks under one token:

- the token is consumed when the job is accepted;
- per-entity results are recorded;
- a failed environment (blocked/reach) stops the remaining chunks unless the plan was
  issued with an explicit retry policy;
- retrying the failed subset requires a new plan for the remaining entities, with a
  new expanded hash;
- partial completion is reported to the verifier and the operator UI.

#### Verification

After execution:

```text
effective   : all planned entities placed, target issue fixed
neutral     : placed but no measurable improvement
ineffective : placement failed for a significant subset
regressed   : placement created new critical audit issues
```

Metrics recorded per blueprint:

```text
blueprint_id, blueprint_hash, source
entities_planned, entities_placed, entities_failed
required_items, missing_items
plan_id, verification result
```

These are discipline/telemetry, not capability score bonuses.

#### Free mode

In free mode, `/act/build-blueprint` remains directly callable, with the legacy
expansion path. The run still records blueprint metrics so free-build and planned
results remain explainable. Blueprint policy is still part of the benchmark variant.

#### Evaluation fairness

Preloaded blueprints can make a benchmark easier. Therefore:

- `construction.blueprints.source` is part of the benchmark variant;
- a preloaded catalog must be versioned and hashed into the variant identity;
- free and planned runs with different blueprint policies are not ranked together;
- agent-captured blueprints are part of the agent's capability, not a benchmark
  shortcut.

### 4.6 Scope policy

```text
local repair / in-cluster rebuild:
  allowed, no credits, audit revision required

expansion:
  allowed only when audit.invalid_count <= clean_target
  and the plan is classified as expansion

cleanup:
  cleanup=true targets only
  targets must be inside allowed_clusters
  working production entities are protected

working block:
  never a cleanup target
  any plan that would remove it requires operator confirmation
```

### 4.7 Executor

Action endpoints require a `plan_id` in the payload when mode is `planned`:

```json
{
  "plan_id": "pln_...",
  "entities": [ ... ]
}
```

Validation order:

1. run mode is `planned`;
2. token exists in the active run;
3. token kind matches the action;
4. token is unexpired and unconsumed;
5. payload targets hash equals `targets_hash`;
6. all targets are inside the token bbox;
7. `audit_revision` and `refactor_revision` are unchanged;
8. no protected entity is touched.

The token is consumed when the action job is accepted, not once per internal loopback.
Internal job dispatch carries the original token context and must not re-check it.

### 4.8 Verifier

After a plan's job finishes:

```text
before = audit snapshot captured at plan time
after  = fresh factory-audit / pipeline-audit
```

Classify:

```text
effective   : target issue removed, no new critical issue
neutral     : no measurable change
ineffective : target issue remains
regressed   : new critical issue or working-block damage
```

Store the result and emit a `construction.plan.verified` event. Repeated
`ineffective` plans for the same fingerprint must be rejected until a new plan is
submitted (anti-loop rule).

---

## 5. API changes

### 5.1 New endpoints

```text
POST /api/agent/plan
GET  /api/agent/plan/:id
POST /api/agent/plan/:id/cancel
```

`POST /api/agent/plan` is available only in `planned` mode. In `free` mode it returns
`CONSTRUCTION_MODE_FREE`.

### 5.2 Changed action endpoints

In `planned` mode, these require `plan_id`:

```text
/api/agent/act/build
/api/agent/act/build-blueprint
/api/agent/act/rotate
/api/agent/act/set-recipe
/api/agent/act/copy-settings
/api/agent/act/mine     (only when removing player-owned buildings)
```

`mine` of raw resources remains a normal action, but any `allow_buildings` target must
still carry `cleanup=true` and a cleanup plan.

### 5.3 Error codes

| Code | Meaning |
| --- | --- |
| `PLAN_REQUIRED` | action attempted without a plan token in planned mode |
| `PLAN_EXPIRED` | token expired |
| `PLAN_TARGET_MISMATCH` | payload differs from the planned entity/target hash |
| `PLAN_SCOPE_VIOLATION` | targets outside the plan scope/cluster |
| `PLAN_REVISION_CHANGED` | audit/refactor changed after planning |
| `PLAN_KIND_MISMATCH` | e.g. cleanup token used for build |
| `PLAN_ALREADY_CONSUMED` | token reused |
| `CONSTRUCTION_MODE_FREE` | plan endpoint called in free mode |
| `CONSTRUCTION_MODE_FREE` | plan endpoint called in free mode |
| `BLUEPRINT_INVALID` | malformed/unsupported blueprint |
| `BLUEPRINT_MATERIAL_SHORTAGE` | required items missing before execution |
| `BLUEPRINT_TARGET_MISMATCH` | blueprint/anchor/rotation differs from token |
| `BLUEPRINT_PARTIAL_FAILURE` | chunked placement stopped before the plan completed |

Every error includes:

```json
{
  "error": "PLAN_REQUIRED",
  "message": "Call POST /api/agent/plan with kind=build first.",
  "mode": "planned",
  "audit_revision": 42
}
```

---

## 6. Free mode behavior

Free mode is deliberately simple and legacy-compatible.

Enabled:

- direct build / direct blueprint build / mutations / cleanup,
- legacy planners that call raw action endpoints,
- existing STATE and ALERT gates,
- audit metrics collection.

Disabled:

- plan token requirement,
- plan-scope enforcement,
- refactor build gate and build credits,
- cleanup cluster restriction (unless benchmark config explicitly re-enables it).

Free mode records:

- `construction.free_actions`
- `construction.unplanned_actions`
- audit snapshots and discipline metrics,
- no plan tokens.

Free mode does **not** emit `PLAN_REQUIRED`; it is not a bypass, it is the selected
evaluation mode.

---

## 7. Events and telemetry

New events:

```text
construction.plan.requested
construction.plan.issued
construction.plan.rejected
construction.plan.consumed
construction.plan.verified
construction.plan.ineffective
construction.bypass_attempt
```

Append to `agent.events.jsonl` / `activity.log` with:

```json
{
  "type": "construction.plan.verified",
  "plan_id": "pln_...",
  "kind": "build",
  "mode": "planned",
  "result": "effective",
  "audit_before": 42,
  "audit_after": 18
}
```

`/api/tool-calls` continues to count raw endpoint calls. Planned mode additionally
counts rejected unplanned calls for the `plan_bypass` discipline flag.

---

## 8. Tooling and compatibility

### Python client / CLI

- `FactorioClient.plan(...)` creates a plan.
- `FactorioClient.plan_blueprint(...)` registers/loads the blueprint, requests a
  `kind=blueprint` plan and returns the token; the raw blueprint string is never sent
  directly to the planned build endpoint.
- Planning wrappers (`build_power_network`, `build_power_line`, `build_line`,
  `build_blueprint`, `plan_build`) automatically request a token and pass `plan_id`.
- Raw `c.build(...)` without a plan raises a structured error in planned mode.
- CLI `act-build` gains `--plan-id`; planner commands manage it automatically.

### MCP / Gym

- Same plan service; one shared capability registry.
- MCP tool `plan_build`/`build` must not bypass token validation.
- Gym actions carry the current plan context where supported.

### Legacy

- Existing free benchmarks continue to run in free mode by default.
- Existing direct `c.build` scripts only work in free mode.

---

## 9. Rollout plan

### Phase 0 — mode metadata

- Add `construction` benchmark/run fields.
- Default all existing configs to `free`.
- Snapshot mode into `run.scoring` and `evaluation.capability.variant`.
- Operator UI badge.

### Phase 1 — planned build gate

- Implement plan service + tokens.
- Require `plan_id` for all `/act/build` in planned mode.
- Update Python planners to acquire tokens.
- Add `PLAN_REQUIRED` tests.

### Phase 2 — mutations and cleanup

- Extend plan kinds to rotate/set-recipe/copy-settings.
- Move cleanup restrictions into cleanup plans.
- Add working-block protection.

### Phase 3 — verifier and discipline

- Post-plan audit.
- effective/ineffective classification.
- planning bypass/ineffective metrics.
- Remove build credits from planned mode.

### Phase 4 — service-generated layouts

- For power/pipe/belt routes, manager accepts intent and generates entity
  coordinates, so raw coordinates cannot be submitted at all.
- Keep general blueprints as validated entity plans.

### Phase 5 — leaderboard split

- Add `free-build` and `planned-build` variants to benchmark definitions.
- Separate ranking/leaderboard keys.
- Document how free-mode results are interpreted.

---

## 10. Acceptance criteria

1. In free mode, legacy direct build scripts still work and are scored under the
   free-build variant.
2. In planned mode, a direct build without `plan_id` returns `PLAN_REQUIRED`.
3. All entity prototypes are covered; there is no power/pipe-only exception.
4. A plan with changed targets returns `PLAN_TARGET_MISMATCH`.
5. An audit change after planning returns `PLAN_REVISION_CHANGED`.
6. Reusing a consumed token returns `PLAN_ALREADY_CONSUMED`.
7. Cleanup of a working production entity is rejected in planned mode.
7. Cleanup of a working production entity is rejected in planned mode.
8. In planned mode, direct `/act/build-blueprint` without a `blueprint` plan token
   returns `PLAN_REQUIRED`; a different blueprint/anchor/rotation returns
   `BLUEPRINT_TARGET_MISMATCH`.
9. A blueprint plan with missing materials is rejected before any entity is placed.
10. Blueprint partial failure is reported per entity and the operator UI shows the
    plan/blueprint verification result.
11. Free and planned runs are never ranked together; `evaluation.capability.variant`
   differs and the UI/leaderboard groups by variant.
12. Post-plan verification records `effective`/`ineffective` and blocks repeated
   ineffective plans.
13. Existing audit and pipeline-audit tests remain green; new plan-gate tests cover
    build, mutation, cleanup, blueprint and free-mode compatibility.

---

## 11. Open questions

- Should benchmark variant be a separate benchmark file or a `variant` dimension?
  This spec assumes a `variant` dimension with explicit leaderboard keys; separate
  files are also valid if the evaluator prefers immutable task identities.
- Should free-mode cleanup keep the working-block guard as a safety default? The
  default is no construction policy, but an evaluation configuration may opt in.
- Should plan tokens survive manager restarts? The default is no; re-plan is safer
  than executing a stale plan.
- When service-generated layouts land, should arbitrary entity lists remain available
  for blueprints? This spec keeps blueprints as validated plans: manager expansion and
  a bound entity hash, because a blueprint is a user-supplied design.
- Should preloaded blueprint catalogs be global or benchmark-scoped? Either is
  acceptable, but the catalog id and hash must be part of the variant identity.

---

## 12. Implementation status (current branch)

Implemented in this branch:

- benchmark/run construction mode snapshot and scoring variant metadata;
- `GET /api/agent/construction`, `POST /api/agent/plan`,
  `GET /api/agent/plan/:id`, `POST /api/agent/plan/:id/cancel`;
- single-use plan tokens with kind, target hash, bbox, audit revision and expiry;
- planned-mode gates on build, blueprint, mutation and cleanup actions;
- free mode as the legacy path, with refactor build/mine gates disabled;
- Python client auto-planning for build, mine-cleanup, rotate, set-recipe,
  copy-settings and blueprints;
- construction metrics in discipline and capability variant fields;
- manager-side blueprint decoding/expansion with prototype-size anchors and
  chunked blueprint plans;
- post-plan verifier classification (`effective`, `neutral`, `ineffective`,
  `regressed`) and repeated-ineffective plan blocking;
- manager-generated `power`, `pipe` and `belt` layout plans (straight/L power
  trunks, coverage grids, straight pipe/belt runs) with canonical entities;
- planned-mode working-block protection for cleanup targets (working production
  machines are rejected before the plan is consumed);
- manager-side blueprint material preflight against the player inventory;
- operator UI construction mode/variant labels and cross-variant comparison
  warnings;
- tests for modes, token consume/mismatch/expiry-by-audit, blueprint expansion,
  chunked plans, cleanup plans, verifier behavior, layouts and API route behavior.

Deferred to the next implementation phase:

- pathfinding-aware service layouts around lakes/cliffs (current manager layouts
  are straight or L and reject diagonal belt/pipe requests);
- a dedicated leaderboard view with server-side variant grouping (the current
  run/compare UI labels variants and warns on mixed comparisons);
- exact blueprint item contents/modules preflight (manager preflight uses one
  place item per expanded entity plus the client's detailed inventory check);
- broader working-block classification beyond active production machine statuses.
