# Contributing to autorio

Thanks for helping improve autorio. Read `docs/architecture.md` for how the code fits together,
`README.md` for the user manual, and `AGENTS.md` for the compact agent-facing summary.

## Before you start

- Open an issue for larger features or interface changes so the design can be
  agreed before code is written.
- Keep changes focused: one logical change per commit/PR; keep refactors separate
  from behavior changes.
- Don't commit generated state: `.autorio/`, `dist/`, `node_modules/`, `.env`,
  saves/videos, and `__pycache__/` are ignored and `npm run check:repo` enforces it.

## Prerequisites

- **Node.js 20+** (`engines.node` is `>=20`, `.nvmrc` pins 20; CI runs Node 20 on
  Linux and Node 24 on Windows, the real target for graphical runs). The
  README/launcher text recommends 22+, which is stricter than the minimum.
- **npm** — `npm ci` uses the committed `package-lock.json` — and **Python 3** for
  `factorio.py` and the Python tests (Windows scripts find `py -3` or `python`).
- Optional integration tools: the full Factorio game (Steam signed in; demo
  unsupported), a macOS/Windows desktop, OBS Studio 28+, FFmpeg on Windows, and an
  agent CLI — none needed by the tests.
- Graphical runs require macOS or Windows; Linux/WSL is fine for tests, CLI, and
  dashboard work but cannot open the game window.

## Setup

```bash
git clone https://github.com/ryanmadden/autorio.git
cd autorio
npm ci
npm run build
npm test
```

Optionally copy `.env.example` to `.env` and run `npm run doctor` to check the game, agent CLI,
Python, recording browser, and video prerequisites. `npm run dev` gives a watch-mode server (a
restart stops an active run); use a compiled manager for recordings.

## Quality gates

Run the full gate before every commit — `npm run verify` = build + Node tests + Python tests +
repository hygiene + Prettier check, exactly what CI runs.

| Command | What it checks |
| --- | --- |
| `npm run build` / `npm run typecheck` | TypeScript compiles to `dist/` (strict, NodeNext ESM); `typecheck` skips emit |
| `npm run test:node` | `node --test tests/*.test.mjs` — 270 Node tests (lifecycle, agent translators/launch specs, command builders, action jobs, HTTP/router/API handlers, telemetry sampler, area-edit, MCP tools, cluster, vision, observability, validation, UI helpers, …) |
| `npm run test:python` | `node scripts/run-python-tests.mjs` — unittest discovery, 111 Python client/env tests (blueprint codec/build incl. underground subtypes, planners, new observations, deconstruct-area, CLI) |
| `npm test` | Build, then `test:node`, then `test:python` |
| `npm run test:coverage` / `npm run coverage` | Builds, then runs the Node suite with Node's built-in coverage through `scripts/coverage-gate.mjs`; fails below 82 % lines / 78 % branches / 84 % functions (CLI/env overrides, `--json`; current suite ~85.8 % lines / 85.4 % branches / 87.7 % functions) |
| `npm run lint` / `npm run lint:fix` | Type-aware ESLint (`eslint.config.mjs`): `no-floating-promises`, `no-misused-promises`, unused vars and JS recommended rules as errors; `no-explicit-any` is a warning and is currently at **zero** — keep new dynamic boundaries typed through `src/validation.ts` |
| `npm run check:repo` | Zero-dependency hygiene gate: required scripts/engines, strict TS + NodeNext, required files (including `docs/architecture.md`, `CONTRIBUTING.md`, `CHANGELOG.md`), no tracked build artifacts/secrets/local state, LF endings, no focused tests (`.only(`), no stray `console.log` in `src/` (logger and run CLI excepted), reproducible package script |
| `npm run format` / `format:check` | Prettier over `src/**/*.ts`, `public/**/*.{js,css}`, `tests/**/*.mjs`, `scripts/**/*.mjs`, `package.json`, `tsconfig.json`, `.github/**/*.yml`; Markdown, HTML, Lua and generated dirs are excluded via `.prettierignore` |
| `npm run package` / `selftest` / `doctor` | Cumulative-patch + `git archive` source zip packaging with sha256; live read-only API check against a running game; environment diagnostics |

`verify` runs build + Node tests + Python tests + check:repo + format:check + lint. The
coverage gate is a separate CI step because it re-runs the Node suite with coverage.

### Git hooks

Install the fast pre-commit gate once per checkout:

```bash
npm run hooks:install
npm run hooks:check   # verify core.hooksPath points at .githooks
```

The hook runs `npm run check:repo`, `npm run format:check` and `npm run typecheck`
(the full suite stays in `npm run verify` and CI). Bypass a WIP commit with
`AUTORIO_SKIP_HOOKS=1 git commit ...`; the hook text explains the bypass after a
failure.

### Coverage gate

`npm run coverage` runs the Node suite with Node's built-in coverage (no external
coverage dependency) and fails below 82 % lines / 78 % branches / 84 % functions
on the `all files` row. Override per run with
`node scripts/coverage-gate.mjs --lines 85 --branches 80 --functions 88` or
`AUTORIO_COVERAGE_LINES` / `AUTORIO_COVERAGE_BRANCHES` /
`AUTORIO_COVERAGE_FUNCTIONS`; `--json` prints a machine-readable summary. `dist/`
must exist (`npm run build`) before the gate runs.

### Releases

```bash
node scripts/release.mjs patch --dry-run   # print the plan only
node scripts/release.mjs patch             # bump, changelog, commit, tag
```

Releases require a clean tracked tree on `main`/`master` (or `--allow-branch`),
refuse an existing tag, bump `package.json` + `package-lock.json`, move the
CHANGELOG `[Unreleased]` body into a dated section (keeping an empty Unreleased
section and rewriting compare links), commit `chore(release): vX.Y.Z` and create
an annotated tag. Use `--no-commit` to review the edits first and `--tag-prefix`
to change the tag prefix. Never rewrite a published release.

### Live selftest (self-hosted Windows)

`.github/workflows/live-selftest.yml` is a manual workflow for a
`[self-hosted, windows, factorio]` runner. It hosts a baseline save, unpauses the
game via RCON and runs the read-only `npm run selftest`, always stopping the
manager afterwards (logs uploaded as artifacts). The runner needs Steam signed in,
Factorio installed, Node 24 and a save under `.autorio/saves` (default
`clear-test.zip`, overridable via the `save` dispatch input). Uncomment the cron
and set the repository variable `AUTORIO_LIVE_SELFTEST=true` to run it nightly.

## Continuous integration

`.github/workflows/ci.yml` (workflow `CI`) runs on every push and pull request: job `test` matrix is
`CI / test (ubuntu-latest, 20)` (Node 20) and `CI / test (windows-latest, 24)` (Node 24). Steps:
`actions/checkout@v4` → `actions/setup-node@v4` (matrix Node, npm cache) → `npm ci` →
`npm run build` → `test:node` → `test:python` → `check:repo` → `format:check`, with a
`npm audit --omit=dev --audit-level=high` runtime-dependency audit right after `npm ci`.
No game/Steam is needed.

## Testing strategy

- **Node tests** live in `tests/*.test.mjs` and use `node:test`; suites importing the
  compiled manager need `npm run build`, and fake `.cmd` shims support Windows.
- **Python tests** live in `tests/test_*.py` and use `unittest`; they mock the
  client and never start a manager or game. Tests must verify lifecycle and
  scoring behavior without requiring real Factorio, OBS, or agent launches.
- **Integration is explicit:** `npm run selftest` (read-only API check),
  `./autorio start smoke --manual --detach` (no agent), or a full paid run. Don't make
  CI depend on these; state what you verified manually in the PR.

## Code style

- **Formatting:** Prettier is authoritative (`.prettierrc.json`: 110 columns, 2
  spaces, double quotes, trailing commas, LF); `npm run format` before committing.
- **TypeScript:** ESM (`"type": "module"`, NodeNext) with `.js` imports; strict mode is
  enforced and `check:repo` rejects loosening it. Avoid new `any` at JSON boundaries.
- **No new runtime npm dependencies by default** — the project has no `dependencies`
  and `check:repo` fails if one is added; use the standard library or vendor code.
- **Python:** standard library only, 4-space indentation; keep `factorio.py`'s
  duck-typed public API stable.
- **Docs:** update `README.md`, `AGENTS.md`, or `docs/` when an interface/workflow
  changes; add an `[Unreleased]` entry in `CHANGELOG.md` for user-visible changes.

## Commit conventions

- **One logical change per commit.** Separate refactors, behavior changes, and
  formatting-only churn; keep the tree passing (`npm run verify`).
- **Subject:** imperative mood, sentence case, no Conventional Commits prefix,
  roughly ≤ 72 characters (e.g. `Add native Windows support`).
- **Body:** explain *why* and what the change enables; include tests and docs.

## Common recipes

### Add a gameplay API endpoint

1. Add the Lua builder/route in `src/server.ts` following `json()`/`readJson()`
   conventions. Observations are read-only `POST`; state-changing endpoints must go
   through the action job queue (`JobAction`, `actionPaths`,
   `POST /api/agent/jobs`) instead of being directly callable.
2. Add the `factorio.py` method and CLI subcommand in `ParsedArgs`, cover it in
   `scripts/api-selftest.py`, and expose it as an MCP tool or Gym action where it
   belongs; update `README.md`/`AGENTS.md`.

### Add an MCP tool

Add a `ToolDefinition` to `TOOLS` in `src/mcp-server.ts` (`name`, `description`, `inputSchema`,
`request()` mapping) — use `jobRequest()` for game-changing actions and poll `job_status` from the
client. Only stderr may carry diagnostics; stdout is the MCP transport. Extend
`tests/mcp-server.test.mjs` (fake HTTP server) and update the tool list in `README.md`.

### Add an agent backend

1. Extend the `Run["agent"]` union in `src/runs.ts`, the CLI presets in
   `src/run-cli.ts`, and the dashboard model list in `public/index.html`.
2. Add a `checkAgent()` version/credential probe and a `launch*` method that translates
   the backend's output into the shared transcript events (`thread.started`,
   `item.completed`, `turn.completed`, `error`), handles token/context/quota/resume,
   and is covered by a fake-CLI lifecycle test (`tests/dsh.test.mjs` style). Document
   configuration in `README.md`, `AGENTS.md`, and `.env.example`.

## Questions

Use GitHub issues; for agent behavior see `AGENTS.md` and `runs/run_template/AGENTS.md`.
