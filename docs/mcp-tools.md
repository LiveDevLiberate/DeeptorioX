# MCP tools

`src/mcp-server.ts` is a dependency-free [Model Context Protocol](https://modelcontextprotocol.io)
stdio server for the autorio manager. It speaks newline-delimited JSON-RPC 2.0 on stdin/stdout and
proxies the local manager HTTP API (diagnostics go to stderr only, so stdout stays protocol-clean).

Build first, keep the manager running (`npm run dev` or `npm start`), then let an MCP client launch
`node dist/mcp-server.js` (or `npm run mcp`). `AUTORIO_API_BASE` sets the manager address (default
`http://127.0.0.1:3000`; `FACTORIO_API_BASE` is accepted as a fallback). Tools return the manager's
JSON body as pretty-printed text plus `structuredContent` when the body is an object.

Coordinates are map tiles and build anchors are top-left tile positions. `observe_*` tools are
read-only. Game-changing tools queue a serialized action job and return immediately with a
`job_id`; poll `job_status` until the status is `completed`, `failed`, or `cancelled`, and use
`cancel_job` to request cancellation. `copy_settings` is the one exception: it mutates
synchronously (see below).

## Observation tools (read-only)

| Tool                 | Endpoint                             | Arguments                                                       |
| -------------------- | ------------------------------------ | --------------------------------------------------------------- |
| `observe_world`      | `POST /api/agent/observe/world`      | `x?`, `y?`, `radius?`, `include?` (`terrain`/`entities`)        |
| `observe_map`        | `POST /api/agent/observe/map`        | `x?`, `y?`, `radius?`                                           |
| `observe_player`     | `POST /api/agent/observe/player`     | `inventory_slots?`, `equipment_slots?`                          |
| `observe_research`   | `POST /api/agent/observe/research`   | `available?`, `locked?`, `completed?`                           |
| `observe_recipes`    | `POST /api/agent/observe/recipes`    | `recipes?`, `unlocked_only?`                                    |
| `observe_factory`    | `POST /api/agent/observe/factory`    | `x?`, `y?`, `radius?`                                           |
| `observe_layout`     | `POST /api/agent/observe/layout`     | `x?`, `y?`, `radius?`, `step?`                                  |
| `observe_connections`| `POST /api/agent/observe/connections`| `x?`, `y?`, `radius?`                                           |
| `observe_placement`  | `POST /api/agent/observe/placement`  | `placements` (required)                                         |
| `observe_resources`  | `POST /api/agent/observe/resources`  | `x?`, `y?`, `radius?`                                           |
| `observe_production` | `POST /api/agent/observe/production` | none (manager sampler window; 409 until a live sample exists)   |
| `observe_fluids`     | `POST /api/agent/observe/fluids`     | `x?`, `y?`, `radius?` (default 32, max 128)                     |
| `observe_combat`     | `POST /api/agent/observe/combat`     | `x?`, `y?`, `radius?` (default 64, max 256)                     |
| `observe_area`       | `POST /api/agent/observe/area`       | `x?`, `y?`, `radius?`, `limit?`, `types?`, `filters?`, `player_only?` |

`copy_settings_check` (`POST /api/agent/observe/copy-settings`) is a read-only dry-run: pass
`targets` as `[{ "source": {"x","y"}, "target": {"x","y"} }]` (up to 50 pairs) to get per-pair
reach/compatibility results without mutating anything. Use it before `copy_settings`, and move
first so both entities are within the character's reach.

`server_status`, `list_runs`, and `list_benchmarks` are read-only GET tools.

## Action tools (asynchronous jobs)

`build`, `mine`, `move`, `rotate`, `set_recipe`, `craft`, `insert`, `extract`, `research`, and
`launch_rocket` submit `{action, payload}` to `POST /api/agent/jobs`; each accepts an optional
`idempotency_key`. Use `job_status` (`GET /api/agent/jobs/:id`) to poll and `cancel_job`
(`POST /api/agent/jobs/:id/cancel`) to request cancellation.

`copy_settings` (`POST /api/agent/act/copy-settings`) is different: it is **not** queued. It
copies settings (recipe, filters, splitter priority, combinator) from each `source` entity onto the
matching `target` and returns per-target results immediately; unreachable or incompatible pairs are
reported and never mutated. Both entities must be reachable, so move first. It accepts the same
`targets` shape as `copy_settings_check` plus an optional `dry_run` preview flag.

## Follow-ups

- A `build_blueprint` MCP tool needs Node-side blueprint-string decode/expansion (the Python
  client already has `decode_blueprint_string` / `expand_blueprint`); it is not exposed here yet.
- Telemetry tools depend on the manager's 5 s sampler; call `observe_production` after the game is
  running to warm the window.
