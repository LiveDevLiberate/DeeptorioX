#!/usr/bin/env python3
"""Python client for the autorio Factorio JSON API.

Provides both an importable client and a command-line interface for agents.
"""

from __future__ import annotations

import base64
import hashlib
import json
import math
import os
import sys
import time
import zlib
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Callable
from urllib.error import HTTPError
from urllib.parse import quote
from urllib.request import Request, urlopen


DEFAULT_BASE = os.environ.get("FACTORIO_API_BASE", "http://localhost:3000")
API_SCHEMA_VERSION = 2
POLL_INTERVAL_SECONDS = 0.25
MISSING = object()

# Factorio blueprint strings are a one-character format version ("0"), then
# base64(zlib(JSON)). Older and third-party strings omit either wrapper, so the
# decoder tolerates a missing prefix and an in-payload version byte as well.
BLUEPRINT_VERSION_PREFIX = "0"
BLUEPRINT_MAX_ENTITIES_PER_JOB = 50
BLUEPRINT_MAX_DECOMPRESSED_BYTES = 32 * 1024 * 1024
BLUEPRINT_BASE64_ALPHABET = frozenset(
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/="
)

__all__ = [
    "FactorioClient",
    "action_job_ok",
    "blueprint_entities_count",
    "blueprint_required_items",
    "compact",
    "data_value",
    "decode_blueprint_string",
    "encode_blueprint_string",
    "expand_blueprint",
    "http_request",
    "parse_copy_targets",
    "parse_entities",
    "parse_targets",
    "plan_defense_line",
    "plan_inserter_pairs",
    "plan_mining_outpost",
    "plan_pipe_line",
    "plan_power_network",
    "plan_underground_belt_line",
    "plan_underground_pipe_line",
    "submit_action_job",
    "belt_line_entities",
    "loader_entity",
]


GLOBAL_USAGE = """factorio.py <command> [options]

Commands:
  server-status
  server-start --save <name>.zip
  server-stop
  server-saves
  observe-world --window-x <n> --window-y <n> --radius <n> --include terrain,entities
  observe-map --center-x <n> --center-y <n> --radius <n>
  observe-map-overview --center-x <n> --center-y <n> --radius <n> --size <n> [--format svg]
  observe-player --limit-inventory <n> --limit-equipment <n>
  observe-research --limit-available <n> --limit-locked <n> --limit-completed <n>
  observe-recipes --limit-recipes <n> [--unlocked-only]
  observe-entity --target x,y [--target ...] [--targets-json <json>]
  factory-audit [--center-x n --center-y n --radius n] [--scope belts,power,pipes,machines,containers,rail] [--include-rail]
  observe-pipeline [--center-x n --center-y n --radius n]
  pipeline-audit [--center-x n --center-y n --radius n]
  observe-free-space [--center-x n --center-y n --radius n] [--step n]
  geometry-check (--entity name,x,y[,dir] [--entity ...] | --entities-json <json>)
  plan-route --from x,y --to x,y [--kind belt|pipe|wall|power] [--width n] [--spacing n] [--radius n]
  observe-container --target x,y
  belt-contents --target x,y
  fluid-contents --target x,y
  recover-debris [--center-x n --center-y n --radius n]
  observe-resources --window-x <n> --window-y <n> --radius <n>
  tools [--json] [--local] [--query <text>]
  blueprint-list [--run-id <id>]
  blueprint-save (--blueprint-file <path>|--blueprint <string>) [--label <text>] [--description <text>] [--source saved|built] [--run-id <id>]
  blueprint-capture [--center-x n --center-y n --radius n] [--label <text>] [--description <text>]
  blueprint-evaluate (--blueprint-file <path>|--blueprint <string>|--id <id>) [--output item=rate] [--power-kw n] [--build-seconds n]
  blueprint-analyze (--blueprint-file <path>|--blueprint <string>|--id <id>)
  blueprint-diff (--before-file <path>|--before <string>|--before-id <id>) (--after-file <path>|--after <string>|--after-id <id>)
  blueprint-gamedata [--dump-file <path>]
  map-preview-exchange (--string-file <path>|--string <exchange string>) [--size n] [--planets nauvis,vulcanus]
  state-show
  state-write --current <text> [--done-when <text>] [--next <text>] [--scores k=v,...] [--objective <text>] [--timebox <text>] [--progress <text>] [--notes <text>] [--markdown <text>]
  observe-factory --center-x <n> --center-y <n> --radius <n>
  observe-layout --center-x <n> --center-y <n> --radius <n> --step <n>
  observe-connections --center-x <n> --center-y <n> --radius <n>
  observe-entity-prototype --name <entity-name>
  describe (--kind entity|technology) --name <name>
  entity-usage --name <entity-name>
  knowledge [--topic inserters|pipes|trains|power|chemistry|defense|production|blueprints]
  alerts [--ack]
  entity-usage-catalog
  observe-placement --entity name,anchor-x,anchor-y,dir [--entity ...]
  observe-production
  observe-fluids --center-x <n> --center-y <n> --radius <n>
  observe-combat --center-x <n> --center-y <n> --radius <n>
  observe-area --center-x <n> --center-y <n> --radius <n> [--limit <n>] [--types a,b] [--filters a,b] [--player-only] [--order name|near]
  observe-snapshot --center-x <n> --center-y <n> --radius <n>
  observe-copy-settings --target sx,sy,tx,ty [--target ...]
  act-build --entity name,anchor-x,anchor-y,dir [--entity ...] [--no-clear]
  act-build-belt --from x,y --to x,y [--name transport-belt] [--no-clear]
  act-build-loader --from x,y --to x,y [--name inserter] [--no-clear]
  act-build-blueprint (--blueprint-file <path>|--blueprint <string>) [--anchor x,y] [--dry-run] [--no-clear]
  act-copy-settings --target sx,sy,tx,ty [--target ...] [--dry-run]
  deconstruct-area --center-x <n> --center-y <n> --radius <n> [--limit <n>] [--types a,b] [--filters a,b] [--scope belts,power,pipes,machines,containers,rail] [--include-all] [--max-per-job <n>] [--order nearest|scan] [--start x,y] [--max-distance n] [--dry-run]
  build-pipe-line --from x,y --to x,y [--name pipe] [--no-clear]
  build-underground-belt --from x,y --to x,y [--name transport-belt] [--max-distance n] [--no-clear]
  build-underground-pipe --from x,y --to x,y [--max-distance n] [--no-clear]
  build-pipe-route --from x,y --to x,y [--name pipe] [--surface-pipes] [--no-clear]
  build-line --kind pipe|belt|wall|pole|underground-pipe|underground-belt --from x,y --to x,y [--name entity] [--route auto|straight] [--spacing n] [--surface-pipes] [--no-clear]
  relayout-belts --center-x n --center-y n --radius n [--dry-run]
  build-power-network (--target x,y[,w,h] [--target ...] | --area x,y,radius) [--pole name] [--big-pole-every n] [--no-clear]
  build-power-line --from x,y --to x,y [--pole name] [--spacing n] [--no-clear]
  build-inserter-pairs --entity x,y[,w,h] [--entity ...] [--direction east|west|north|south] [--no-clear]
  build-mining-outpost (--ore x,y [--ore ...] | --area x,y,radius) [--drill name] [--drill-size w,h] [--output name] [--no-clear]
  build-defense-line --from x,y --to x,y [--turret name] [--wall name|--no-wall] [--spacing n] [--ammo-chest name] [--no-clear]
  act-mine --target x,y [--target ...] [--resource [name]] [--count n|all] [--allow-buildings] [--targets-json <json>]
  act-rotate --target x,y [--target ...] [--direction 0|4|8|12] [--targets-json <json>]
  act-move --target x,y [--target ...] [--targets-json <json>]
  unstick [--max-removals n]
  path-preview --target x,y [--target ...] [--targets-json <json>]
  act-launch-rocket --target x,y [--target ...] [--targets-json <json>]
  act-set-recipe --target x,y,recipe [--target ...] [--targets-json <json>]
  act-research --technology <name>
  act-craft --item <name> --count <n> [--no-wait]
  act-insert --entity x,y --item <name> --count <n>
  act-extract --entity x,y --item <name> --count <n|all>
  container-transfer --from x,y --to x,y [--item name] [--count n|all]
  wait-for-item --item <name> --count <n> --timeout <s>
  wait-for-research --technology <name> --timeout <s>
  job-status --job-id <id>
  job-cancel --job-id <id>

Notes:
  - Agents use this API without GUI input; the local Factorio game runs with graphics.
  - Actions that require the player to be near a target (build/mine/rotate/insert/extract/set-recipe/launch-rocket)
    are NOT instant. The character walks through the game world, respecting obstacles and reach. Mining uses native mining cycles.

Global options:
  --base <url> (default: FACTORIO_API_BASE or http://localhost:3000)
  --detach (return immediately after creating an action job)
  --idempotency-key <key> (safely retry action submission)
  --help

More help:
  Run: factorio.py <command> --help
"""


COMMAND_USAGE = {
    "server-status": "server-status: Show whether the server is running and RCON is connected.\nUsage: factorio.py server-status\n",
    "server-start": "server-start: Launch the graphical local host with the given save.\nUsage: factorio.py server-start --save <name>.zip\n",
    "server-stop": "server-stop: Stop the running server (saves and exits).\nUsage: factorio.py server-stop\n",
    "server-saves": "server-saves: List available save files on the server.\nUsage: factorio.py server-saves\n",
    "observe-world": "observe-world: Fetch compact RLE terrain and entities in a charted window.\nUsage: factorio.py observe-world --window-x <n> --window-y <n> --radius <n> --include terrain,entities\n",
    "observe-map": "observe-map: Read a player-charted map window; uncharted chunks are masked.\nUsage: factorio.py observe-map --center-x <n> --center-y <n> --radius <n>\n",
    "observe-map-overview": "observe-map-overview: Compact downsampled charted map thumbnail with uncharted/water/land/entity/resource/player glyphs.\nUsage: factorio.py observe-map-overview --center-x <n> --center-y <n> --radius <n> --size <n> [--format svg]\nRadius is clamped to 1024 tiles and size to 160 cells; only charted chunks are revealed.",
    "observe-player": "observe-player: Inspect player position, health, inventories, and equipment.\nUsage: factorio.py observe-player --limit-inventory <n> --limit-equipment <n>\n",
    "observe-research": "observe-research: Get current, queued, available, locked, and completed technologies with costs.\nUsage: factorio.py observe-research --limit-available <n> --limit-locked <n> --limit-completed <n>\n",
    "observe-recipes": "observe-recipes: List available recipes and their ingredients/products.\nUsage: factorio.py observe-recipes --limit-recipes <n> [--unlocked-only]\n",
    "observe-entity": "observe-entity: Inspect entity status, fuel, fluids, recipe, inventory.\nUsage: factorio.py observe-entity --target x,y [--target ...]\n   or: factorio.py observe-entity --targets-json <json>\n",
    "observe-resources": "observe-resources: Scan for resource patches in a radius.\nUsage: factorio.py observe-resources --window-x <n> --window-y <n> --radius <n>\n",
    "observe-factory": "observe-factory: Summarize power, fuel, and entity status counts in a window.\nUsage: factorio.py observe-factory --center-x <n> --center-y <n> --radius <n>\n",
    "tools": "tools: Fetch the generated tool manifest (client methods, parameters, CLI usage, manager endpoints).\nUsage: factorio.py tools [--json] [--local] [--query <text>]\n--json prints the manifest as JSON; --local introspects factorio.py without the manager; --query filters matching commands/methods/endpoints. (The manager also serves GET /api/agent/tools?q=...)\n",
    "blueprint-capture": "blueprint-capture: Capture the player-built layout in an area into the run blueprint registry.\nUsage: factorio.py blueprint-capture [--center-x n --center-y n --radius n] [--label text] [--description text]\nCapture after the layout passes factory-audit/observe-connections; reuse and iterate on saved blueprints.\n",
    "blueprint-analyze": "blueprint-analyze: Static geometry, lane flow, supply check, lint and lane-mix analysis.\nUsage: factorio.py blueprint-analyze (--blueprint-file path|--blueprint string|--id id)\nPorted from factorio-blueprint-tools (MIT): no throughput/fluid analysis.\n",
    "blueprint-diff": "blueprint-diff: Compare entity/recipe geometry, check, lint and lane-mix between two blueprints.\nUsage: factorio.py blueprint-diff (--before-file path|--before string|--before-id id) (--after-file path|--after string|--after-id id)\n",
    "blueprint-gamedata": "blueprint-gamedata: Regenerate blueprint recipe/footprint data from a local data-raw-dump.json.\nUsage: factorio.py blueprint-gamedata [--dump-file path]\nRun `factorio --dump-data` first; writes blueprint_analysis/data/gamedata.json.\n",
    "map-preview-exchange": "map-preview-exchange: Decode a >>>eN...<<< map exchange string and render planet previews.\nUsage: factorio.py map-preview-exchange (--string-file path|--string s) [--size n] [--planets nauvis,vulcanus]\nUses the vendored FactorioPreviewToolkit dummy-save/Lua pipeline; previews all planets by default.\n",
    "blueprint-evaluate": "blueprint-evaluate: Report structural and optional dynamic efficiency for a blueprint.\nUsage: factorio.py blueprint-evaluate (--blueprint-file path|--blueprint string|--id id) [--output item=rate] [--power-kw n] [--build-seconds n]\nStatic: footprint/entity/machine/belt/inserter density. Dynamic requires built-cell output rates, power and build time.\n",
    "blueprint-list": "blueprint-list: List blueprints recorded for a run (active run by default).\nUsage: factorio.py blueprint-list [--run-id <id>]\n",
    "blueprint-save": "blueprint-save: Persist a designed blueprint string for the active run without building it.\nUsage: factorio.py blueprint-save --blueprint-file <path> [--label <text>] [--description <text>] [--source saved|built] [--run-id <id>]\n   or: factorio.py blueprint-save --blueprint <string> [--label <text>]\n",
    "state-show": "state-show: Read the active run's STATE.md freshness/status.\nUsage: factorio.py state-show\n",
    "state-write": "state-write: Write/refresh STATE.md (resets the update deadline gate).\nUsage: factorio.py state-write --current <text> [--done-when <text>] [--next <text>] [--scores production=50,logistics=40,...] [--objective <text>] [--timebox <text>] [--progress <text>] [--notes <text>] [--markdown <text>]\nMutating actions are refused with STATE_UPDATE_REQUIRED once STATE.md is too old; call this to continue.\n",
    "observe-layout": "observe-layout: Render a region as an ASCII map (belts, inserters, machines, terrain).\nUsage: factorio.py observe-layout --center-x <n> --center-y <n> --radius <n> --step <n>\n",
    "observe-connections": "observe-connections: Audit inserter/belt/machine links and report dead ends or reversed links.\nUsage: factorio.py observe-connections --center-x <n> --center-y <n> --radius <n>\n",
    "describe": "describe: Resolve an entity or technology localised description in the current game language.\nUsage: factorio.py describe --name <name> [--kind entity|technology]\n",
    "alerts": "alerts: Read current critical/warning alerts, or acknowledge them after fixing.\nUsage: factorio.py alerts [--ack]\nCritical alerts block mutating actions with ALERTS_PENDING until ack; observations/state/alerts remain allowed.\n",
    "knowledge": "knowledge: Concise engineering knowledge for inserters, pipes, trains, power, chemistry, defense, production optimization and blueprints.\nUsage: factorio.py knowledge [--topic inserters|pipes|trains|power|chemistry|defense|production|blueprints]\n",
    "entity-usage-catalog": "entity-usage-catalog: List all curated entity behavior, flow, placement rules and common mistakes (no game call required).\nUsage: factorio.py entity-usage-catalog\n",
    "entity-usage": "entity-usage: Curated behavior/placement rules plus prototype metadata for one entity.\nUsage: factorio.py entity-usage --name <entity-name>\n",
    "observe-entity-prototype": "observe-entity-prototype: Look up entity dimensions, fluid connections, energy info.\nUsage: factorio.py observe-entity-prototype --name <entity-name>\n",
    "observe-placement": "observe-placement: Analyze buildability without consuming an item.\nUsage: factorio.py observe-placement --entity name,anchor-x,anchor-y,dir [--entity ...]\n",
    "observe-production": "observe-production: Read per-minute production/consumption rates from the manager's telemetry sampler.\nUsage: factorio.py observe-production\n",
    "observe-fluids": "observe-fluids: List fluid networks, levels and capacities around a window.\nUsage: factorio.py observe-fluids --center-x <n> --center-y <n> --radius <n>\nDefaults: player position, radius 32.\n",
    "observe-combat": "observe-combat: Read enemy nests/units, own turrets (ammo/health) and player health.\nUsage: factorio.py observe-combat --center-x <n> --center-y <n> --radius <n>\nDefaults: player position, radius 64. Recent damage is not derivable; compare player.health across calls.\n",
    "observe-area": "observe-area: List entities for deconstruction planning in an area (name/type/position/status).\nUsage: factorio.py observe-area --center-x <n> --center-y <n> --radius <n> [--limit <n>] [--types a,b] [--filters a,b] [--player-only] [--order name|near]\n",
    "observe-snapshot": "observe-snapshot: One call returning player, factory, research and production observations.\nUsage: factorio.py observe-snapshot --center-x <n> --center-y <n> --radius <n>\nNote: sequential requests; saves round trips and prompt tokens versus four separate calls.\n",
    "observe-copy-settings": "observe-copy-settings: Dry-run source/target compatibility and reach report for settings copy.\nUsage: factorio.py observe-copy-settings --target source-x,source-y,target-x,target-y [--target ...]\n   or: factorio.py observe-copy-settings --targets-json <json>\nNote: The character must be in reach of both entities; move first.\n",
    "act-build": "act-build: Place entities using the top-left occupied tile as the anchor.\nUsage: factorio.py act-build --entity name,anchor-x,anchor-y,dir [--entity ...] [--no-clear]\n   or: factorio.py act-build --entities-json <json> [--no-clear]\nJSON shape: [{\"name\":\"transport-belt\",\"anchor\":{\"x\":10,\"y\":20},\"direction\":4}] (x,y shorthand accepted).\nDirection: 0=north (up), 4=east (right), 8=south (down), 12=west (left).\nNote: The character walks into reach using native pathfinding. Trees and rocks in the\nfootprint are mined before placement unless --no-clear is given.\n",
    "act-build-blueprint": "act-build-blueprint: Expand a Factorio blueprint string and build it in batches of at most 50 entities.\nUsage: factorio.py act-build-blueprint --blueprint-file <path> [--anchor x,y] [--dry-run] [--no-clear]\n   or: factorio.py act-build-blueprint --blueprint <string> [--anchor x,y] [--dry-run] [--no-clear]\nPosition: blueprint positions are map coordinates; --anchor moves the whole plan so its top-left tile lands there.\nDirections: 0=north (up), 4=east (right), 8=south (down), 12=west (left).\nUnderground: underground-belt/pipe-to-ground input/output subtypes are preserved as underground_type.\nDry run: prints the expanded entities, placement analysis, and missing items without building.\nNote: Recipes, filters and module settings inside the blueprint are NOT applied; set them with\nact-set-recipe afterwards. The character walks between entities, so a large plan takes many minutes.\n",
    "act-copy-settings": "act-copy-settings: Copy settings from source to target entities (synchronous, reach-checked).\nUsage: factorio.py act-copy-settings --target source-x,source-y,target-x,target-y [--target ...] [--dry-run]\n   or: factorio.py act-copy-settings --targets-json <json> [--dry-run]\nNote: Not a walking job; move the character into reach of every source and target first.\nUnreachable or incompatible pairs are reported and never mutated.\n",
    "deconstruct-area": "deconstruct-area: Observe an area and remove the entities with native mining (chunked, nearest-first).\nUsage: factorio.py deconstruct-area --center-x <n> --center-y <n> --radius <n> [--limit <n>] [--types a,b] [--filters a,b] [--include-all] [--max-per-job <n>] [--order nearest|scan] [--start x,y] [--max-distance n] [--dry-run]\nDefaults: radius 64, limit server default (300), player_only=true (last_user heuristic).\n--include-all sets player_only=false; add --types tree,simple-entity for passability or --types resource for ore.\nRemoval is the normal native miner: the character walks, mining takes real time, and unreachable targets\nfail per entity. Targets are ordered nearest-first from the player/center (--order scan to disable; --start x,y; --max-distance avoids cross-map trips), then chunks of at most 50. --dry-run plans only.\n",
    "build-pipe-line": "build-pipe-line: Lay an L-shaped surface pipe line (x first, then y).\nUsage: factorio.py build-pipe-line --from x,y --to x,y [--name pipe] [--no-clear]\nNote: surface pipes only; for straight runs under obstacles use build-underground-pipe.\n",
    "build-underground-belt": "build-underground-belt: Lay a straight underground-belt line (input/output pairs + surface belt connectors).\nUsage: factorio.py build-underground-belt --from x,y --to x,y [--name transport-belt] [--max-distance n] [--no-clear]\nName: transport-belt/fast-transport-belt/express-transport-belt (default distance 4/6/8); pass --max-distance to override.\nPair layout: input at the segment start, output at start+distance facing the same flow direction, one surface belt\nconnector after each pair, surface belts for tails shorter than a pair. Straight horizontal/vertical only.\n",
    "build-underground-pipe": "build-underground-pipe: Lay a straight pipe-to-ground line (input/output pairs + surface pipe connectors).\nUsage: factorio.py build-underground-pipe --from x,y --to x,y [--max-distance n] [--no-clear]\nPair layout: input at the segment start, output at start+distance facing the same flow direction, one surface pipe\nconnector after each pair, surface pipes for tails shorter than a pair (default distance 10). Straight only.\n",
    "build-line": "build-line: Unified linear builder for pipes/belts/walls/poles, with auto pathfinding around lakes/cliffs or a straight L plan.\nUsage: factorio.py build-line --kind pipe|belt|wall|pole|underground-pipe|underground-belt --from x,y --to x,y [--name entity] [--route auto|straight] [--spacing n] [--no-clear]\nroute=auto uses path-preview and lays an orthogonal route; pipe defaults to mostly underground pipe-to-ground (surface only at ends/corners), pass --surface-pipes to override; underground belt variants are straight-only.\n",
    "relayout-belts": "relayout-belts: Recycle every belt in an area after repeated failed belt-link attempts; dry-run first to inspect.\nUsage: factorio.py relayout-belts --center-x n --center-y n --radius n [--dry-run]\nThen re-observe and plan a fresh route; do not patch the failed layout further.\n",
    "build-pipe-route": "build-pipe-route: Ask the native pathfinder for a walkable route and lay connected orthogonal pipes around lakes/cliffs.\nUsage: factorio.py build-pipe-route --from x,y --to x,y [--name pipe] [--no-clear]\nDefaults to underground pipe-to-ground with surface connectors only at ends/corners; --surface-pipes forces the old surface route. Fails with no_path if unreachable.\n",
    "build-power-network": "build-power-network: Place a pole grid covering entity targets or a scan area.\nUsage: factorio.py build-power-network --target x,y[,w,h] [--target ...] [--pole name] [--big-pole-every n] [--no-clear]\n   or: factorio.py build-power-network --area x,y,radius [--pole name] [--big-pole-every n] [--no-clear]\nCoverage: small/medium poles 5x5 (5-tile grid), substations 18x18 (18-tile grid); big poles are for straight transmission trunks (30-tile reach) and have only a 4x4 supply area. Use build-power-line for trunks.\n",
    "build-power-line": "build-power-line: Place a straight horizontal/vertical pole trunk with wire-reach spacing.\nUsage: factorio.py build-power-line --from x,y --to x,y [--pole name] [--spacing n] [--no-clear]\nUse big-electric-pole for long runs (30 reach); use build-power-network with substations for area coverage.\n",
    "build-inserter-pairs": "build-inserter-pairs: Place input+output inserters around rows of machines.\nUsage: factorio.py build-inserter-pairs --entity x,y[,w,h] [--entity ...] [--direction east|west|north|south] [--name inserter] [--no-clear]\n   or: factorio.py build-inserter-pairs --entities-json <json> [--direction ...] [--no-clear]\nFootprints default to 3x3; pass w,h for other machine sizes. Shared machine-to-machine inserters are deduped.\n",
    "build-mining-outpost": "build-mining-outpost: Place mining drills on a grid over ore tiles with belt rows and an output chest.\nUsage: factorio.py build-mining-outpost --ore x,y [--ore ...] [--drill name] [--drill-size w,h] [--output name] [--no-clear]\n   or: factorio.py build-mining-outpost --area x,y,radius [--drill name] [--drill-size w,h] [--output name]\nWarning: one output-belt row between drill rows is not mined; electric drills need a power network.\n",
    "build-defense-line": "build-defense-line: Place 2x2 turrets spaced along a line with a single wall row in front.\nUsage: factorio.py build-defense-line --from x,y --to x,y [--turret name] [--wall name|--no-wall] [--spacing n] [--ammo-chest name] [--no-clear]\nFront side is +y for horizontal lines and +x for vertical lines; single wall layer, no gates/power.\n",
    "act-mine": "act-mine: Mine a resource or entity at target tile coordinates.\nUsage: factorio.py act-mine --target x,y [--target ...] [--resource [name]] [--count n|all]\n   or: factorio.py act-mine --targets-json <json>\nResource mode excludes the character and prioritizes the requested resource deterministically.\nResource mining defaults to count=all (same target until depletion/inventory full); pass a positive --count for a bounded run.\n",
    "act-rotate": "act-rotate: Rotate entities at target tile coordinates (first entity at each point).\nUsage: factorio.py act-rotate --target x,y [--target ...] [--direction 0|4|8|12]\n   or: factorio.py act-rotate --targets-json <json>\nDirection: 0=north (up), 4=east (right), 8=south (down), 12=west (left).\nWith --direction the entity is rotated until it faces that direction (max 4 steps), so one call sets the final orientation.\nNote: The character walks into reach using native pathfinding.\n",
    "path-preview": "path-preview: Ask the native pathfinder for a route without walking it.\nUsage: factorio.py path-preview --target x,y\nReturns ok=true with path waypoints when reachable; ok=false error=no_path when blocked (water/cliff/buildings).\nUse this before long or unseen-terrain moves; route around water/cliff instead of retrying the same no_path target.\n",
    "act-move": "act-move: Move the player through paced, collision-checked steps to target tile coordinates.\nUsage: factorio.py act-move --target x,y [--target ...]\n   or: factorio.py act-move --targets-json <json>\nNote: Stops and returns partial progress if an intermediate step is blocked.\n",
    "unstick": "unstick: Escape when the player is trapped by player-owned buildings; mines low-value blockers until a route opens.\nUsage: factorio.py unstick [--max-removals n]\nNative mining only; no teleport. Use a larger/other opening if no blocker helps.\n",
    "act-launch-rocket": "act-launch-rocket: Launch a ready rocket silo at target tile coordinates.\nUsage: factorio.py act-launch-rocket --target x,y [--target ...]\n   or: factorio.py act-launch-rocket --targets-json <json>\nNote: Walks into reach. Success means launch initiated; the benchmark waits for an actual launch.\n",
    "act-set-recipe": "act-set-recipe: Set the recipe on assemblers at target tile coordinates.\nUsage: factorio.py act-set-recipe --target x,y,recipe [--target ...]\n   or: factorio.py act-set-recipe --targets-json <json>\nNote: The character walks into reach using native pathfinding.\n",
    "act-research": "act-research: Start researching a technology.\nUsage: factorio.py act-research --technology <name>\n",
    "act-craft": "act-craft: Queue a handcraft and verify its products appear (or use --no-wait).\nUsage: factorio.py act-craft --item <name> --count <n> [--no-wait]\n",
    "act-insert": "act-insert: Move items from player inventory into an entity at x,y.\nUsage: factorio.py act-insert --entity x,y --item <name> --count <n>\nNote: The character walks into reach using native pathfinding.\n",
    "act-extract": "act-extract: Remove items from an entity at x,y into player inventory.\nUsage: factorio.py act-extract --entity x,y --item <name> --count <n|all>\nNote: The character walks into reach using native pathfinding.\n",
    "observe-free-space": "observe-free-space: Buildable grid of free/blocked cells plus largest connected free rectangles.\nUsage: factorio.py observe-free-space [--center-x n --center-y n --radius n] [--step n]\nUse for machine-row placement and corridor planning before building.\n",
    "geometry-check": "geometry-check: Validate planned footprints, rotations, overlaps and native placement without building.\nUsage: factorio.py geometry-check (--entity name,x,y[,dir] [--entity ...] | --entities-json <json>)\nReturns per-entity bbox, overlap pairs and placement blockers; use before building a layout.\n",
    "plan-route": "plan-route: Orthogonal belt/pipe/wall/power corridor through observed free space (A*, no build).\nUsage: factorio.py plan-route --from x,y --to x,y [--kind belt|pipe|wall|power] [--width n] [--spacing n] [--radius n]\nOutputs route tiles + planned entities; inspect then build.\n",
    "observe-pipeline": "observe-pipeline: Structured machine/belt/inserter/pipe/power graph with ports, bboxes, statuses and bottlenecks.\nUsage: factorio.py observe-pipeline [--center-x n --center-y n --radius n]\nUse this instead of inferring flow from raw entity lists/ASCII.\n",
    "pipeline-audit": "pipeline-audit: Prioritized bottleneck list derived from the structured pipeline graph.\nUsage: factorio.py pipeline-audit [--center-x n --center-y n --radius n]\n",
    "factory-audit": "factory-audit: Prioritized refactor audit of factory problems, belt links and suggested repairs.\nUsage: factorio.py factory-audit [--center-x n --center-y n --radius n] [--scope belts,power,pipes,machines,containers,rail] [--include-rail]\nDefault scope: belts,power,pipes,machines,containers; rail is opt-in with --include-rail or --scope rail. Run after builds and every few minutes; repair the highest-impact action, verify, then re-audit.\n",
    "belt-contents": "belt-contents: Show items currently on the belt/splitter/underground line at a tile.\nUsage: factorio.py belt-contents --target x,y\n",
    "fluid-contents": "fluid-contents: Show actual fluid amounts inside a pipe/fluid entity at a tile.\nUsage: factorio.py fluid-contents --target x,y\n",
    "observe-container": "observe-container: Show a chest/container inventory at a tile.\nUsage: factorio.py observe-container --target x,y\n",
    "container-transfer": "container-transfer: Move items between containers through the player inventory; omit --item to move all stacks.\nUsage: factorio.py container-transfer --from x,y --to x,y [--item name] [--count n|all]\n",
    "recover-debris": "recover-debris: Scan crash-site spaceship debris, extract loot into the player inventory, then mine each piece.\nUsage: factorio.py recover-debris [--center-x n --center-y n --radius n]\n",
    "job-status": "job-status: Read action job progress.\nUsage: factorio.py job-status --job-id <id>\n",
    "job-cancel": "job-cancel: Request cancellation after the current atomic action.\nUsage: factorio.py job-cancel --job-id <id>\n",
}


def tool_manifest() -> dict[str, Any]:
    """Introspect the local Python client/CLI into a JSON-serializable manifest.

    The manager and the checked-in public/tool-manifest.json add the HTTP
    endpoint list; this function is the local source of truth for method
    signatures, docstrings and CLI usage so the manifest cannot silently drift
    from factorio.py.
    """
    import inspect

    methods: list[dict[str, Any]] = []
    for name, member in inspect.getmembers(FactorioClient, predicate=inspect.isfunction):
        if name.startswith("_"):
            continue
        signature = inspect.signature(member)
        parameters: list[dict[str, Any]] = []
        for parameter in signature.parameters.values():
            if parameter.name == "self":
                continue
            default = parameter.default
            parameters.append({
                "name": parameter.name,
                "kind": parameter.kind.name.lower(),
                "required": default is inspect.Parameter.empty,
                "default": None if default is inspect.Parameter.empty else repr(default),
                "annotation": None if parameter.annotation is inspect.Parameter.empty
                else str(parameter.annotation),
            })
        summary = inspect.getdoc(member) or ""
        methods.append({
            "name": name,
            "signature": f"{name}{signature}",
            "parameters": parameters,
            "description": summary.split("\n\n", 1)[0].replace("\n", " "),
        })
    cli: list[dict[str, Any]] = []
    for command, text in COMMAND_USAGE.items():
        lines = text.strip().splitlines()
        usage = [line for line in lines if line.lower().startswith("usage:")]
        cli.append({
            "command": command,
            "description": lines[0].split(":", 1)[1].strip() if ":" in lines[0] else lines[0],
            "usage": usage[0] if usage else lines[0],
            "help": " ".join(lines[1:]).replace("\\n", " ")[:600],
        })
    cli.sort(key=lambda item: item["command"])
    methods.sort(key=lambda item: item["name"])
    try:
        client_sha256 = hashlib.sha256(Path(__file__).read_bytes()).hexdigest()
    except OSError:
        client_sha256 = ""
    return {
        "schema_version": 1,
        "manifest_version": 2,
        "client_sha256": client_sha256,
        "notes": [
            "Generated from factorio.py (client methods + CLI usage) and src/api/agent.ts endpoints.",
            "Prefer this manifest over reading factorio.py source when choosing a tool.",
            "Manager endpoint: GET /api/agent/tools; CLI: factorio.py tools --json.",
        ],
        "cli_commands": cli,
        "client_methods": methods,
    }


@dataclass
class ParsedArgs:
    base: str
    command: str | None
    flags: dict[str, list[str]] = field(default_factory=dict)
    positionals: list[str] = field(default_factory=list)


def parse_args(argv: list[str]) -> ParsedArgs:
    flags: dict[str, list[str]] = {}
    positionals: list[str] = []
    base = DEFAULT_BASE
    saw_help = False
    index = 0
    while index < len(argv):
        arg = argv[index]
        if arg == "--help":
            saw_help = True
            index += 1
            continue
        if arg.startswith("--"):
            raw = arg[2:]
            if "=" in raw:
                key, value = raw.split("=", 1)
            else:
                key = raw
                if index + 1 < len(argv) and not argv[index + 1].startswith("--"):
                    index += 1
                    value = argv[index]
                else:
                    value = "true"
            if key == "base":
                base = value
            else:
                flags.setdefault(key, []).append(value)
            index += 1
            continue
        positionals.append(arg)
        index += 1

    command = positionals.pop(0) if positionals else None
    if saw_help:
        help_args = ([command] if command else []) + positionals
        return ParsedArgs(base, "help", flags, help_args)
    return ParsedArgs(base, command, flags, positionals)


def get_flag(flags: dict[str, list[str]], name: str) -> str | None:
    values = flags.get(name)
    return values[-1] if values else None


def parse_number(value: str | None, fallback: int | float | None = None) -> int | float | None:
    if value is None:
        return fallback
    try:
        number = float(value.strip()) if value.strip() else 0.0
    except ValueError:
        return fallback
    if not math.isfinite(number):
        return fallback
    return int(number) if number.is_integer() else number


def parse_entities(values: list[str]) -> list[dict[str, Any]]:
    entities = []
    for entry in values:
        parts = [part.strip() for part in entry.split(",")]
        name = parts[0] if parts else ""
        x = parse_number(parts[1], None) if len(parts) > 1 else None
        y = parse_number(parts[2], None) if len(parts) > 2 else None
        direction = parse_number(parts[3], None) if len(parts) > 3 else None
        if not name or x is None or y is None:
            raise ValueError(f"Invalid --entity '{entry}'")
        if len(parts) > 3 and direction is None:
            raise ValueError(f"Invalid --entity direction in '{entry}'")
        entity: dict[str, Any] = {"name": name, "anchor": {"x": x, "y": y}}
        if len(parts) > 3:
            entity["direction"] = direction
        entities.append(entity)
    return entities


def normalize_build_entities(value: Any) -> list[dict[str, Any]]:
    """Normalize --entities-json to the manager's build schema.

    Canonical shape: [{"name": "transport-belt", "anchor": {"x": 1, "y": 2}}].
    The shorthand {"name": "...", "x": 1, "y": 2} is accepted for convenience;
    malformed entries error instead of producing a silent empty build job.
    """
    if not isinstance(value, list):
        raise ValueError("--entities-json must be a JSON array")
    entities: list[dict[str, Any]] = []
    for index, raw in enumerate(value):
        if not isinstance(raw, dict):
            raise ValueError(f"entities[{index}] must be an object")
        entity = dict(raw)
        name = str(entity.get("name") or "").strip()
        if not name:
            raise ValueError(f"entities[{index}] is missing a name")
        anchor = entity.get("anchor")
        if anchor is None:
            anchor = {"x": entity.pop("x", None), "y": entity.pop("y", None)}
        if not isinstance(anchor, dict):
            raise ValueError(f"entities[{index}] anchor must be an object")
        def number_or_none(value: Any) -> float | None:
            return None if value is None else parse_number(str(value), None)

        x = number_or_none(anchor.get("x"))
        y = number_or_none(anchor.get("y"))
        if x is None or y is None:
            raise ValueError(
                f"entities[{index}] needs anchor {{x,y}} (or shorthand x,y); "
                'example: [{"name":"transport-belt","anchor":{"x":10,"y":20}}]'
            )
        normalized: dict[str, Any] = {"name": name, "anchor": {"x": x, "y": y}}
        if "direction" in entity:
            direction = number_or_none(entity["direction"])
            if direction is None:
                raise ValueError(f"entities[{index}].direction must be a number")
            normalized["direction"] = direction
        if "underground_type" in entity:
            underground = entity["underground_type"]
            if underground not in ("input", "output"):
                raise ValueError(f"entities[{index}].underground_type must be input or output")
            normalized["underground_type"] = underground
        entities.append(normalized)
    if not entities:
        raise ValueError("--entities-json contains no entities")
    return entities


def parse_targets(values: list[str], require_recipe: bool) -> list[dict[str, Any]]:
    targets = []
    for entry in values:
        parts = [part.strip() for part in entry.split(",")]
        x = parse_number(parts[0], None) if parts else None
        y = parse_number(parts[1], None) if len(parts) > 1 else None
        recipe = parts[2] if len(parts) > 2 else ""
        if x is None or y is None:
            raise ValueError(f"Invalid --target '{entry}'")
        if require_recipe and not recipe:
            raise ValueError(f"Missing recipe in --target '{entry}'")
        target: dict[str, Any] = {"x": x, "y": y}
        if require_recipe:
            target["recipe"] = recipe
        targets.append(target)
    return targets


def compact(value: Any) -> Any:
    """Recursively omit None values to match JSON.stringify(undefined fields)."""
    if isinstance(value, dict):
        return {key: compact(item) for key, item in value.items() if item is not None}
    if isinstance(value, list):
        return [compact(item) for item in value]
    return value


def http_request(base: str, method: str, path: str, body: Any = None) -> Any:
    encoded = None
    headers: dict[str, str] = {}
    if body is not None:
        encoded = json.dumps(compact(body), separators=(",", ":")).encode("utf-8")
        headers["Content-Type"] = "application/json"
    request = Request(f"{base}{path}", data=encoded, headers=headers, method=method)
    try:
        with urlopen(request) as response:
            raw = response.read().decode("utf-8")
    except HTTPError as error:
        raw = error.read().decode("utf-8", errors="replace")
        try:
            payload = json.loads(raw) if raw else None
        except json.JSONDecodeError:
            payload = raw
        if isinstance(payload, dict) and payload.get("error"):
            raise RuntimeError(str(payload["error"])) from error
        raise RuntimeError(f"HTTP {error.code}") from error
    try:
        return json.loads(raw) if raw else None
    except json.JSONDecodeError:
        return raw


def belt_line_entities(start: dict[str, Any], end: dict[str, Any],
                       name: str = "transport-belt") -> list[dict[str, Any]]:
    """Straight belt run from start to end, with every tile facing the flow."""
    x1, y1 = int(round(float(start["x"]))), int(round(float(start["y"])))
    x2, y2 = int(round(float(end["x"]))), int(round(float(end["y"])))
    dx = (x2 > x1) - (x2 < x1)
    dy = (y2 > y1) - (y2 < y1)
    if dx and dy:
        raise ValueError("belt_line_entities only supports straight horizontal or vertical lines")
    direction = 4 if dx > 0 else 12 if dx < 0 else 8 if dy > 0 else 0
    if dx == 0 and dy == 0:
        return [{"name": name, "x": x1, "y": y1, "direction": direction}]
    entities = []
    x, y = x1, y1
    while True:
        entities.append({"name": name, "x": x, "y": y, "direction": direction})
        if x == x2 and y == y2:
            break
        x += dx
        y += dy
    return entities


INSERTER_DIRECTION_OPPOSITE = {0: 8, 4: 12, 8: 0, 12: 4}


def opposite_direction(direction: int) -> int:
    """Opposite cardinal direction (0=N, 4=E, 8=S, 12=W)."""
    return INSERTER_DIRECTION_OPPOSITE.get(int(direction), 0)


def loader_entity(source: dict[str, Any], target: dict[str, Any],
                  name: str = "inserter") -> dict[str, Any]:
    """Place one inserter between two tiles exactly two apart in a straight line.

    Factorio inserter ``direction`` is the **pickup** side; the drop side is the
    opposite tile. The inserter is therefore oriented to pick up at ``source``.
    """
    x1, y1 = int(round(float(source["x"]))), int(round(float(source["y"])))
    x2, y2 = int(round(float(target["x"]))), int(round(float(target["y"])))
    dx = (x2 > x1) - (x2 < x1)
    dy = (y2 > y1) - (y2 < y1)
    if bool(dx) == bool(dy):
        raise ValueError("loader endpoints must be on the same row or column")
    if abs(x2 - x1) + abs(y2 - y1) != 2:
        raise ValueError("loader endpoints must be exactly two tiles apart")
    toward_target = 4 if dx > 0 else 12 if dx < 0 else 8 if dy > 0 else 0
    return {
        "name": name,
        "x": x1 + dx,
        "y": y1 + dy,
        "direction": opposite_direction(toward_target),
    }


def _decode_blueprint_base64(text: str) -> bytes:
    cleaned = "".join(text.split())
    if not cleaned:
        raise ValueError("blueprint string is empty")
    unexpected = sorted({char for char in cleaned if char not in BLUEPRINT_BASE64_ALPHABET})
    if unexpected:
        raise ValueError("blueprint string is not valid base64 (unexpected character)")
    # Some pasted strings lose their trailing padding; restore it before decoding.
    padded = cleaned + "=" * (-len(cleaned) % 4)
    try:
        return base64.b64decode(padded, validate=True)
    except ValueError as error:
        raise ValueError(f"blueprint string is not valid base64: {error}") from error


def _inflate_blueprint(payload: bytes) -> bytes:
    if not payload:
        raise ValueError("blueprint data is empty")
    decompressor = zlib.decompressobj()
    try:
        data = decompressor.decompress(payload, BLUEPRINT_MAX_DECOMPRESSED_BYTES + 1)
    except zlib.error as error:
        raise ValueError(f"blueprint data is not valid zlib: {error}") from error
    if decompressor.unconsumed_tail:
        raise ValueError("blueprint is too large to expand")
    try:
        data += decompressor.flush()
    except zlib.error as error:
        raise ValueError(f"blueprint data is not valid zlib: {error}") from error
    if not decompressor.eof:
        raise ValueError("blueprint data is not a complete zlib stream")
    if len(data) > BLUEPRINT_MAX_DECOMPRESSED_BYTES:
        raise ValueError("blueprint is too large to expand")
    return data


def _strip_blueprint_version(data: bytes) -> bytes:
    """Drop an in-payload format version byte (legacy/tolerated variant)."""
    if not data:
        raise ValueError("blueprint data is empty")
    if data.startswith(b"{"):
        return data
    if data[:1] in (b"\x00", b"\x01"):
        return data[1:]
    raise ValueError(
        "blueprint data has an unsupported format version; expected a Factorio blueprint string"
    )


def _decode_blueprint_body(text: str) -> dict[str, Any]:
    """Decode the version-stripped base64(zlib(JSON)) body of a blueprint string."""
    payload = _strip_blueprint_version(_inflate_blueprint(_decode_blueprint_base64(text)))
    try:
        decoded = payload.decode("utf-8")
    except UnicodeDecodeError as error:
        raise ValueError(f"blueprint JSON is not valid UTF-8: {error}") from error
    try:
        parsed = json.loads(decoded)
    except json.JSONDecodeError as error:
        raise ValueError(f"blueprint JSON is invalid: {error}") from error
    if not isinstance(parsed, dict):
        raise ValueError("blueprint JSON must be an object")
    return parsed


def decode_blueprint_string(text: str) -> dict[str, Any]:
    """Decode a Factorio blueprint string into its JSON payload.

    Factorio stores blueprints as a one-character format version (normally
    ``"0"``) followed by ``base64(zlib(JSON))``. This also accepts older
    versionless/third-party strings, both with and without the version prefix.
    Raises ``ValueError`` with a stage-specific message for corrupt base64,
    zlib, or JSON.
    """
    if not isinstance(text, str):
        raise ValueError("blueprint string must be a string")
    cleaned = "".join(text.split())
    if not cleaned:
        raise ValueError("blueprint string is empty")
    prefixed_error: ValueError | None = None
    if len(cleaned) > 1 and cleaned[0].isdigit():
        try:
            return _decode_blueprint_body(cleaned[1:])
        except ValueError as error:
            prefixed_error = error
    try:
        return _decode_blueprint_body(cleaned)
    except ValueError as error:
        if prefixed_error is not None:
            raise prefixed_error from error
        raise


def encode_blueprint_string(blueprint: dict[str, Any]) -> str:
    """Encode a blueprint JSON payload into an importable Factorio blueprint string.

    Inverse of :func:`decode_blueprint_string`; the output round-trips exactly
    and uses Factorio's own ``"0" + base64(zlib(JSON))`` wire format.
    """
    if not isinstance(blueprint, dict):
        raise ValueError("blueprint must be a dict")
    payload = json.dumps(blueprint, separators=(",", ":"), ensure_ascii=False).encode("utf-8")
    return BLUEPRINT_VERSION_PREFIX + base64.b64encode(zlib.compress(payload, 9)).decode("ascii")


def _coerce_blueprint(blueprint: Any) -> dict[str, Any]:
    if isinstance(blueprint, str):
        return decode_blueprint_string(blueprint)
    if isinstance(blueprint, dict):
        return blueprint
    raise ValueError("blueprint must be a blueprint string or a decoded dict")


def _blueprint_entities(blueprint: dict[str, Any]) -> list[dict[str, Any]]:
    """Return the entity list from a blueprint payload (wrapped or bare)."""
    root = blueprint.get("blueprint")
    if not isinstance(root, dict):
        if isinstance(blueprint.get("entities"), list):
            root = blueprint
        elif "blueprint_book" in blueprint:
            raise ValueError("blueprint books are not supported; export a single blueprint")
        else:
            raise ValueError("blueprint payload has no 'blueprint' object")
    entities = root.get("entities", [])
    if entities is None:
        entities = []
    if not isinstance(entities, list):
        raise ValueError("blueprint entities must be a list")
    for index, entity in enumerate(entities):
        if not isinstance(entity, dict):
            raise ValueError(f"blueprint entity {index} is not an object")
    return entities


def _blueprint_point(value: Any, label: str) -> tuple[float, float]:
    if isinstance(value, dict):
        raw_x, raw_y = value.get("x"), value.get("y")
    elif isinstance(value, (list, tuple)) and len(value) == 2:
        raw_x, raw_y = value
    else:
        raise ValueError(f"{label} must be {{'x': number, 'y': number}} or (x, y)")
    try:
        x, y = float(raw_x), float(raw_y)
    except (TypeError, ValueError) as error:
        raise ValueError(f"{label} must contain numbers") from error
    if not (math.isfinite(x) and math.isfinite(y)):
        raise ValueError(f"{label} must be finite")
    return x, y


def _prototype_size(prototype_sizes: dict[str, Any] | None, name: str) -> tuple[int, int] | None:
    """Resolve a prototype footprint from a name-keyed size map, if valid."""
    if not prototype_sizes:
        return None
    value = prototype_sizes.get(name)
    if isinstance(value, dict):
        width, height = value.get("width"), value.get("height")
    elif isinstance(value, (list, tuple)) and len(value) == 2:
        width, height = value
    else:
        return None
    try:
        size = (int(width), int(height))
    except (TypeError, ValueError):
        return None
    return size if size[0] > 0 and size[1] > 0 else None


def _blueprint_underground_type(entity: dict[str, Any], index: int) -> str | None:
    """Validate the blueprint input/output subtype for underground entities."""
    name = entity.get("name")
    if not isinstance(name, str):
        return None
    # Vanilla tiers end with "underground-belt"; pipe-to-ground is the pipe pair.
    if not (name == UNDERGROUND_PIPE_NAME or name.endswith("underground-belt")):
        return None
    subtype = entity.get("type")
    if subtype not in ("input", "output"):
        raise ValueError(
            f"blueprint entity {index} ({name}) needs type 'input' or 'output', got {subtype!r}"
        )
    return subtype


def expand_blueprint(
    blueprint: Any,
    *,
    anchor: Any = None,
    offset: tuple[float, float] = (0, 0),
    prototype_sizes: dict[str, Any] | None = None,
) -> list[dict[str, Any]]:
    """Convert a blueprint payload into manager build entities.

    Blueprint ``position`` values are the entity *center* in absolute map
    coordinates. The manager build API expects the integer top-left tile
    (``anchor``) plus an optional direction, so each center is shifted by half
    the prototype footprint; footprints rotate for east/west directions (4, 12),
    exactly like ``agentBuild*Command`` in the manager.

    ``prototype_sizes`` maps an entity name to ``{"width","height"}`` or
    ``(width, height)``; it is required for correct anchors on entities larger
    than one tile (assemblers, furnaces, splitters, ...). Without a size the
    entity is assumed to be 1x1 and its anchor becomes ``floor(position)`` —
    correct for belts, pipes, inserters, chests, poles and lamps, wrong for
    larger prototypes, so pass real sizes (``FactorioClient.build_blueprint``
    fetches them from ``observe-entity-prototype`` automatically).

    ``anchor`` (``{"x","y"}`` or ``(x, y)``) moves the plan so its top-left
    anchor lands there; ``offset`` is then added to every anchor. Results are
    sorted deterministically by (y, x, entity_number).

    Underground belt/pipe-to-ground blueprint entities carry a ``type`` of
    ``"input"`` or ``"output"``; that subtype is validated and emitted as
    ``underground_type`` so the manager build action can create the explicit
    piece (unknown/missing subtypes raise ``ValueError``). Non-underground
    entities' fields are unchanged.
    """
    entities = _blueprint_entities(_coerce_blueprint(blueprint))
    anchor_point = _blueprint_point(anchor, "anchor") if anchor is not None else None
    offset_x, offset_y = _blueprint_point(offset, "offset")
    expanded: list[dict[str, Any]] = []
    entity_numbers: list[int] = []
    for index, entity in enumerate(entities):
        name = entity.get("name")
        if not isinstance(name, str) or not name:
            raise ValueError(f"blueprint entity {index} has no name")
        position_x, position_y = _blueprint_point(
            entity.get("position"), f"blueprint entity {index} position"
        )
        direction = entity.get("direction")
        direction_value: int | None = None
        if direction is not None:
            try:
                direction_value = int(direction)
            except (TypeError, ValueError) as error:
                raise ValueError(f"blueprint entity {index} has an invalid direction") from error
            if direction_value not in range(16):
                raise ValueError(f"blueprint entity {index} direction must be 0-15")
        underground_type = _blueprint_underground_type(entity, index)
        size = _prototype_size(prototype_sizes, name)
        if size is not None:
            width, height = size
            if direction_value in (4, 12):
                width, height = height, width
            anchor_x = position_x - width / 2
            anchor_y = position_y - height / 2
        else:
            # Unknown footprint: assume 1x1 so the anchor is the top-left tile.
            anchor_x, anchor_y = math.floor(position_x), math.floor(position_y)
        item: dict[str, Any] = {
            "name": name,
            "anchor": {"x": int(round(anchor_x)), "y": int(round(anchor_y))},
        }
        if direction_value is not None:
            item["direction"] = direction_value
        if underground_type is not None:
            item["underground_type"] = underground_type
        number = entity.get("entity_number")
        expanded.append(item)
        entity_numbers.append(number if isinstance(number, int) else index)
    if anchor_point is not None and expanded:
        shift_x = anchor_point[0] - min(item["anchor"]["x"] for item in expanded)
        shift_y = anchor_point[1] - min(item["anchor"]["y"] for item in expanded)
    else:
        shift_x = shift_y = 0.0
    shift_x += offset_x
    shift_y += offset_y
    if shift_x or shift_y:
        for item in expanded:
            item["anchor"]["x"] = int(round(item["anchor"]["x"] + shift_x))
            item["anchor"]["y"] = int(round(item["anchor"]["y"] + shift_y))
    order = sorted(
        range(len(expanded)),
        key=lambda index: (
            expanded[index]["anchor"]["y"],
            expanded[index]["anchor"]["x"],
            entity_numbers[index],
            index,
        ),
    )
    return [expanded[index] for index in order]


def blueprint_entities_count(blueprint: Any) -> int:
    """Number of entities in a blueprint payload or blueprint string."""
    return len(_blueprint_entities(_coerce_blueprint(blueprint)))


def blueprint_required_items(
    blueprint: Any, *, item_names: dict[str, str] | None = None
) -> dict[str, int]:
    """Approximate build cost of a blueprint: one place item per entity.

    The Factorio blueprint JSON does not store the item used to place an entity,
    so the entity name is assumed to be the item name. ``item_names`` maps
    prototype names to place items for exceptions (for example a modded
    prototype with a different item). Contents stored on entities (``items``
    and ``items_in_inventory``, present when the blueprint includes contents)
    are added on top, so the result is a preflight estimate, not an exact bill.
    """
    entities = _blueprint_entities(_coerce_blueprint(blueprint))
    mapping = item_names or {}
    required: dict[str, int] = {}
    for entity in entities:
        prototype = entity.get("name")
        if isinstance(prototype, str) and prototype:
            item = mapping.get(prototype, prototype)
            required[item] = required.get(item, 0) + 1
        for field_name in ("items", "items_in_inventory"):
            contents = entity.get(field_name)
            if not isinstance(contents, dict):
                continue
            for item, count in contents.items():
                if not isinstance(item, str) or not item:
                    continue
                try:
                    amount = int(count)
                except (TypeError, ValueError):
                    continue
                if amount > 0:
                    required[item] = required.get(item, 0) + amount
    return required


# Construction-planner conventions. All planners return entities for the
# existing build API (`name`, `anchor` top-left tile, optional `direction`) and
# use integer tile coordinates. Underground belt/pipe pairs are planned
# explicitly: each pair entity carries `underground_type: "input" | "output"`,
# which the manager build action consumes with that subtype (item consumption,
# reach and collision checks are server-side).
POWER_POLE_DEFAULT = "small-electric-pole"
POWER_POLE_BIG = "big-electric-pole"
POWER_POLE_NAMES = frozenset(
    {"small-electric-pole", "medium-electric-pole", "big-electric-pole", "substation"}
)
# Normal-quality base-game pole properties: (supply width, wire reach).
# Small/medium poles cover machines locally; big poles are for long-distance
# trunks (small supply area); substations cover large blocks efficiently.
POWER_POLE_SPECS: dict[str, tuple[int, float]] = {
    "small-electric-pole": (5, 7.5),
    "medium-electric-pole": (5, 9.0),
    "big-electric-pole": (4, 30.0),
    "substation": (18, 18.0),
}
POWER_SUPPLY_HALF = 2  # default small pole supply area is 5x5 centred on the tile
POWER_TILE_STEP = POWER_SUPPLY_HALF * 2 + 1

# Surface belt tier -> (underground entity, standard max underground distance).
# The manager/game remains authoritative and rejects over-distance pairs.
UNDERGROUND_BELT_TIERS = {
    "transport-belt": ("underground-belt", 4),
    "fast-transport-belt": ("fast-underground-belt", 6),
    "express-transport-belt": ("express-underground-belt", 8),
}
UNDERGROUND_PIPE_NAME = "pipe-to-ground"
UNDERGROUND_PIPE_DEFAULT_DISTANCE = 10


def _planner_point(value: Any, label: str, *, integer: bool = True) -> tuple[float, float]:
    """(x, y) from a dict or 2-sequence, optionally requiring integer tiles."""
    if isinstance(value, dict):
        raw_x, raw_y = value.get("x"), value.get("y")
    elif isinstance(value, (list, tuple)) and len(value) == 2:
        raw_x, raw_y = value
    else:
        raise ValueError(f"{label} must be {{'x': number, 'y': number}} or (x, y)")
    try:
        x, y = float(raw_x), float(raw_y)
    except (TypeError, ValueError) as error:
        raise ValueError(f"{label} must contain numbers") from error
    if not (math.isfinite(x) and math.isfinite(y)):
        raise ValueError(f"{label} must be finite")
    if integer and not (x.is_integer() and y.is_integer()):
        raise ValueError(f"{label} must use integer tile coordinates")
    return x, y


def _planner_size(value: Any, default: tuple[int, int]) -> tuple[int, int]:
    """(width, height) from {'width','height'} or a 2-sequence."""
    if value is None:
        return default
    if isinstance(value, dict):
        raw_width, raw_height = value.get("width"), value.get("height")
    elif isinstance(value, (list, tuple)) and len(value) == 2:
        raw_width, raw_height = value
    else:
        raise ValueError("size must be {'width','height'} or (width, height)")
    try:
        width, height = int(raw_width), int(raw_height)
    except (TypeError, ValueError) as error:
        raise ValueError("size must contain positive integers") from error
    if width < 1 or height < 1:
        raise ValueError("size must contain positive integers")
    return width, height


def _planner_area(value: Any) -> tuple[int, int, int, int] | None:
    """Bounding box for an {'x','y','radius'} area (or (x, y, radius)); else None."""
    if isinstance(value, dict) and "radius" in value:
        area_radius = _planner_size(
            {"width": value.get("radius"), "height": value.get("radius")}, (1, 1)
        )[0]
        x, y = _planner_point(value, "area")
        return (
            int(x) - area_radius,
            int(y) - area_radius,
            int(x) + area_radius,
            int(y) + area_radius,
        )
    if (
        isinstance(value, (list, tuple))
        and len(value) == 3
        and all(isinstance(item, (int, float)) and not isinstance(item, bool) for item in value)
    ):
        area_radius = _planner_size({"width": value[2], "height": value[2]}, (1, 1))[0]
        x, y = _planner_point(value[:2], "area")
        return (
            int(x) - area_radius,
            int(y) - area_radius,
            int(x) + area_radius,
            int(y) + area_radius,
        )
    return None


def _planner_sequence(value: Any, label: str) -> list[Any]:
    if isinstance(value, (list, tuple)):
        return list(value)
    raise ValueError(f"{label} must be a list")


def _planner_box(target: Any, index: int) -> tuple[int, int, int, int]:
    """(min_x, min_y, max_x, max_y) covered by one planner target."""
    if isinstance(target, (list, tuple)) and len(target) == 2:
        x, y = _planner_point(target, f"target {index}")
        width, height = 1, 1
    elif isinstance(target, dict):
        if isinstance(target.get("anchor"), dict):
            x, y = _planner_point(target["anchor"], f"target {index} anchor")
        else:
            x, y = _planner_point(target, f"target {index}")
        tile_size = target.get("tile_size")
        tile_size = tile_size if isinstance(tile_size, dict) else {}
        width = target.get("width", tile_size.get("width", 1))
        height = target.get("height", tile_size.get("height", 1))
        width, height = _planner_size({"width": width, "height": height}, (1, 1))
    else:
        raise ValueError(f"target {index} must be {{x,y}}, (x, y) or an entity")
    anchor_x, anchor_y = int(x), int(y)
    return anchor_x, anchor_y, anchor_x + width - 1, anchor_y + height - 1


def _sort_entities(entities: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Deterministic planner order: y, x, then name."""
    return sorted(
        entities,
        key=lambda entity: (
            entity["anchor"]["y"],
            entity["anchor"]["x"],
            str(entity.get("name", "")),
        ),
    )


def _cover_axis(low: int, high: int, supply: int = 5) -> list[int]:
    """Pole tile coordinates whose `supply`-wide areas cover [low, high]."""
    if low > high:
        low, high = high, low
    half = max(0, supply // 2)
    stride = max(1, supply)
    if high - low < stride:
        return [max(low, high - half)]
    positions = [low + half]
    while positions[-1] + half < high:
        positions.append(positions[-1] + stride)
    return positions


def plan_pipe_line(from_xy: Any, to_xy: Any, *, name: str = "pipe") -> list[dict[str, Any]]:
    """L-shaped surface pipe line from `from_xy` to `to_xy` (x first, then y).

    One pipe per tile including both endpoints, direction 0 (pipes are not
    directional), deterministic x-then-y corner. Returns [] for identical
    endpoints. Straight underground pipe runs are planned by
    :func:`plan_underground_pipe_line` (explicit input/output subtype).
    """
    start_x, start_y = _planner_point(from_xy, "from")
    end_x, end_y = _planner_point(to_xy, "to")
    x1, y1, x2, y2 = int(start_x), int(start_y), int(end_x), int(end_y)
    if (x1, y1) == (x2, y2):
        return []

    def pipe(x: int, y: int) -> dict[str, Any]:
        return {"name": name, "anchor": {"x": x, "y": y}, "direction": 0}

    entities = [pipe(x1, y1)]
    x, y = x1, y1
    step = 1 if x2 > x1 else -1
    while x != x2:
        x += step
        entities.append(pipe(x, y1))
    step = 1 if y2 > y1 else -1
    while y != y2:
        y += step
        entities.append(pipe(x2, y))
    return entities


def _path_route_tiles(
    path_points: Any,
    *,
    from_xy: Any = None,
    to_xy: Any = None,
    both_corners: bool = False,
) -> list[tuple[int, int]]:
    """Expand native path waypoints into orthogonal, adjacent tile coordinates."""
    points: list[tuple[int, int]] = []
    for index, raw in enumerate(_planner_sequence(path_points, "path_points")):
        x, y = _planner_point(raw, f"path point {index}", integer=False)
        points.append((int(math.floor(x)), int(math.floor(y))))
    if from_xy is not None:
        x, y = _planner_point(from_xy, "from", integer=False)
        points.insert(0, (int(math.floor(x)), int(math.floor(y))))
    if to_xy is not None:
        x, y = _planner_point(to_xy, "to", integer=False)
        points.append((int(math.floor(x)), int(math.floor(y))))
    if not points:
        return []
    route: list[tuple[int, int]] = []
    seen: set[tuple[int, int]] = set()

    def add(tile: tuple[int, int]) -> None:
        if tile not in seen:
            seen.add(tile)
            route.append(tile)

    add(points[0])
    for target in points[1:]:
        x, y = route[-1]
        dx, dy = target[0] - x, target[1] - y
        if dx == 0 and dy == 0:
            continue
        if dx == 0 or dy == 0:
            step_x = (dx > 0) - (dx < 0)
            step_y = (dy > 0) - (dy < 0)
            while (x, y) != target:
                x += step_x
                y += step_y
                add((x, y))
            continue
        if abs(dx) == 1 and abs(dy) == 1:
            if both_corners:
                add((target[0], y))
                add((x, target[1]))
            else:
                add((target[0], y))
            add(target)
            continue
        step_x = (dx > 0) - (dx < 0)
        while x != target[0]:
            x += step_x
            add((x, y))
        step_y = (dy > 0) - (dy < 0)
        while y != target[1]:
            y += step_y
            add((target[0], y))
    return route


def plan_pipe_route(
    path_points: Any,
    *,
    name: str = "pipe",
    from_xy: Any = None,
    to_xy: Any = None,
) -> list[dict[str, Any]]:
    """Turn a native walkable path into a connected orthogonal pipe route.

    The path may contain diagonal waypoints; each diagonal step is expanded into
    L-shaped pipe tiles. For one-tile diagonals both corner variants are emitted so
    at least one remains buildable at a water/cliff corner (a failed pipe is
    skipped by the build job; the other corner keeps the route connected).
    """
    if not isinstance(name, str) or not name:
        raise ValueError("name must be an entity name")
    route = _path_route_tiles(
        path_points, from_xy=from_xy, to_xy=to_xy, both_corners=True)
    return [
        {"name": name, "anchor": {"x": x, "y": y}, "direction": 0}
        for x, y in route
    ]


def _route_runs(route: list[tuple[int, int]]) -> list[tuple[int, int]]:
    """Maximal straight runs as (start_index, end_index), sharing corner tiles."""
    if not route:
        return []
    runs: list[tuple[int, int]] = []
    start = 0
    previous: tuple[int, int] | None = None
    for index in range(1, len(route)):
        dx = route[index][0] - route[index - 1][0]
        dy = route[index][1] - route[index - 1][1]
        direction = (dx, dy)
        if previous is not None and direction != previous:
            runs.append((start, index - 1))
            start = index - 1
        previous = direction
    runs.append((start, len(route) - 1))
    return runs


def plan_underground_pipe_route(
    path_points: Any,
    *,
    from_xy: Any = None,
    to_xy: Any = None,
    max_distance: Any = UNDERGROUND_PIPE_DEFAULT_DISTANCE,
) -> list[dict[str, Any]]:
    """Lay mostly pipe-to-ground along a path, leaving walkable gaps.

    Corners and the two endpoints are surface pipes; each straight span between
    corners uses underground input/output pairs with the normal spacing. The
    resulting pipe network is connected while most of the route is walkable.
    """
    route = _path_route_tiles(path_points, from_xy=from_xy, to_xy=to_xy)
    if not route:
        return []
    distance = _underground_distance(max_distance, default=UNDERGROUND_PIPE_DEFAULT_DISTANCE)
    entities: list[dict[str, Any]] = []
    seen: set[tuple[int, int]] = set()

    def add(entity: dict[str, Any]) -> None:
        anchor = entity["anchor"]
        key = (int(anchor["x"]), int(anchor["y"]))
        if key in seen:
            return
        seen.add(key)
        entities.append(entity)

    def surface(x: int, y: int) -> dict[str, Any]:
        return {"name": "pipe", "anchor": {"x": x, "y": y}, "direction": 0}

    for start, end in _route_runs(route):
        add(surface(*route[start]))
        add(surface(*route[end]))
        if end - start == 2:
            add(surface(*route[start + 1]))
        elif end - start >= 3:
            for entity in plan_underground_pipe_line(
                route[start + 1], route[end - 1], max_distance=distance
            ):
                add(entity)
    return entities


def _route_direction(route: list[tuple[int, int]], index: int) -> int:
    """Belt/pipe direction from a route's next tile (0 north, 4 east, 8 south, 12 west)."""
    if not route:
        return 0
    if index + 1 < len(route):
        nx, ny = route[index + 1]
    else:
        px, py = route[index - 1]
        nx, ny = 2 * route[index][0] - px, 2 * route[index][1] - py
    x, y = route[index]
    dx, dy = nx - x, ny - y
    if abs(dx) >= abs(dy):
        return 4 if dx > 0 else 12
    return 8 if dy > 0 else 0


BELT_NAMES = frozenset({
    "transport-belt", "fast-transport-belt", "express-transport-belt",
    "underground-belt", "fast-underground-belt", "express-underground-belt",
    "splitter", "fast-splitter", "express-splitter",
})
BELT_DIRECTIONS = {0: (0, -1), 4: (1, 0), 8: (0, 1), 12: (-1, 0)}


def validate_belt_entities(
    entities: Any,
    *,
    from_xy: Any = None,
    to_xy: Any = None,
) -> dict[str, Any]:
    """Check a planned belt run for dead ends, head-on tiles and missing inputs.

    Only plain transport belts are validated; splitters/undergrounds are reported
    as opaque neighbors. Endpoints (the run's start/end) are allowed to have no
    downstream/upstream belt because an inserter or drill may feed/consume there.
    """
    items = _planner_sequence(entities, "entities")
    by_tile: dict[tuple[int, int], dict[str, Any]] = {}
    for index, raw in enumerate(items):
        if not isinstance(raw, dict):
            continue
        name = raw.get("name")
        anchor = raw.get("anchor") or {"x": raw.get("x"), "y": raw.get("y")}
        try:
            x, y = _planner_point(anchor, f"entity {index} anchor")
            direction = int(raw.get("direction", 0))
        except (TypeError, ValueError):
            continue
        if isinstance(name, str) and name in BELT_NAMES:
            by_tile[(int(x), int(y))] = {"name": name, "direction": direction if direction in BELT_DIRECTIONS else 0}
    endpoints: set[tuple[int, int]] = set()
    for value in (from_xy, to_xy):
        if value is None:
            continue
        x, y = _planner_point(value, "endpoint", integer=False)
        endpoints.add((int(math.floor(x)), int(math.floor(y))))
    issues: list[dict[str, Any]] = []
    links: list[dict[str, Any]] = []
    for (x, y), belt in by_tile.items():
        if belt["name"] not in ("transport-belt", "fast-transport-belt", "express-transport-belt"):
            continue
        dx, dy = BELT_DIRECTIONS[belt["direction"]]
        target = (x + dx, y + dy)
        next_belt = by_tile.get(target)
        link = "dead_end"
        if next_belt is None and target not in endpoints and (x, y) not in endpoints:
            issues.append({"kind": "belt_dead_end", "x": x, "y": y, "reason": "no belt on output tile"})
        elif next_belt is not None:
            if next_belt["direction"] == belt["direction"]:
                link = "straight"  # both lanes flow through
            elif next_belt["direction"] == (belt["direction"] + 8) % 16:
                link = "head_on"
                issues.append({"kind": "belt_head_on", "x": x, "y": y, "reason": "next belt faces back"})
            else:
                # Perpendicular output feeds the next belt's side: only one lane
                # is side-loaded; this is a corner/merge, not a full two-lane link.
                link = "side_load"
        elif next_belt is None:
            link = "endpoint" if (x, y) in endpoints or target in endpoints else "dead_end"
        links.append({"x": x, "y": y, "direction": belt["direction"], "next_tile": {"x": target[0], "y": target[1]}, "link": link})
        inputs = []
        for source, source_belt in by_tile.items():
            if source == (x, y):
                continue
            sdx, sdy = BELT_DIRECTIONS[source_belt["direction"]]
            if (source[0] + sdx, source[1] + sdy) == (x, y):
                inputs.append(source)
        if not inputs and (x, y) not in endpoints:
            issues.append({"kind": "belt_no_input", "x": x, "y": y, "reason": "no belt feeds this tile"})
    return {
        "ok": not issues,
        "belts": len(by_tile),
        "issues": issues[:200],
        "issue_count": len(issues),
        "links": links[:300],
    }


def _assert_valid_belt_plan(entities: Any, *, from_xy: Any = None, to_xy: Any = None) -> None:
    result = validate_belt_entities(entities, from_xy=from_xy, to_xy=to_xy)
    if result["ok"]:
        return
    sample = "; ".join(f"{issue['kind']} at {issue['x']},{issue['y']}" for issue in result["issues"][:5])
    raise ValueError(f"invalid belt plan ({result['issue_count']} issues): {sample}")


def plan_grid_route(
    from_xy: Any,
    to_xy: Any,
    *,
    rows: list[str],
    origin: dict[str, Any],
    step: int = 1,
    width: int = 1,
) -> list[dict[str, int]]:
    """Orthogonal A* route through a free-space grid (rows: '.' free, other blocked).

    Used by plan-route to plan belt/pipe/wall/power corridors without crossing
    buildings, water or cliffs. Returns tile coordinates in path order.
    """
    if not isinstance(rows, list) or not rows or not all(isinstance(row, str) for row in rows):
        raise ValueError("rows must be a non-empty list of strings")
    step = int(step)
    width = max(1, int(width))
    if step < 1:
        raise ValueError("step must be >= 1")
    start_x, start_y = _planner_point(from_xy, "from")
    end_x, end_y = _planner_point(to_xy, "to")
    origin_x = int(origin.get("x", 0))
    origin_y = int(origin.get("y", 0))
    height = len(rows)
    grid_width = max(len(row) for row in rows)

    def cell(tx: int, ty: int) -> tuple[int, int] | None:
        col = (int(tx) - origin_x) // step
        row = (int(ty) - origin_y) // step
        if col < 0 or col >= grid_width or row < 0 or row >= height:
            return None
        return row, col

    start = cell(start_x, start_y)
    goal = cell(end_x, end_y)
    if start is None or goal is None:
        raise ValueError("route endpoints are outside the free-space window")
    if not start or not goal:
        raise ValueError("route endpoint is outside the free-space window")

    def is_free(row: int, col: int) -> bool:
        if row < 0 or row >= height or col < 0 or col >= len(rows[row]):
            return False
        if width <= 1:
            return rows[row][col] == "."
        half = width // 2
        for dr in range(-half, width - half):
            for dc in range(-half, width - half):
                r, c = row + dr, col + dc
                if r < 0 or r >= height or c < 0 or c >= len(rows[r]) or rows[r][c] != ".":
                    return False
        return True

    if not is_free(*start) or not is_free(*goal):
        raise ValueError("route endpoint is blocked in the free-space grid")

    import heapq
    frontier: list[tuple[int, int, int, int]] = [(0, 0, start[0], start[1])]
    came_from: dict[tuple[int, int], tuple[int, int] | None] = {start: None}
    cost_so_far: dict[tuple[int, int], int] = {start: 0}
    while frontier:
        _, current_cost, row, col = heapq.heappop(frontier)
        if (row, col) == goal:
            break
        if current_cost != cost_so_far.get((row, col)):
            continue
        for dr, dc in ((-1, 0), (1, 0), (0, -1), (0, 1)):
            nr, nc = row + dr, col + dc
            if not is_free(nr, nc):
                continue
            next_cost = current_cost + 1
            key = (nr, nc)
            if key in cost_so_far and next_cost >= cost_so_far[key]:
                continue
            cost_so_far[key] = next_cost
            came_from[key] = (row, col)
            heuristic = abs(goal[0] - nr) + abs(goal[1] - nc)
            heapq.heappush(frontier, (next_cost + heuristic, next_cost, nr, nc))
    if goal not in came_from:
        raise ValueError("no free-space route between endpoints")
    cells: list[tuple[int, int]] = []
    current: tuple[int, int] | None = goal
    while current is not None:
        cells.append(current)
        current = came_from[current]
    cells.reverse()
    return [
        {"x": origin_x + col * step, "y": origin_y + row * step}
        for row, col in cells
    ]


def plan_belt_route(
    path_points: Any,
    *,
    name: str = "transport-belt",
    from_xy: Any = None,
    to_xy: Any = None,
) -> list[dict[str, Any]]:
    """Lay one directed belt per tile along a walkable path."""
    route = _path_route_tiles(path_points, from_xy=from_xy, to_xy=to_xy)
    return [
        {"name": name, "anchor": {"x": x, "y": y}, "direction": _route_direction(route, i)}
        for i, (x, y) in enumerate(route)
    ]


def plan_wall_route(
    path_points: Any,
    *,
    name: str = "stone-wall",
    from_xy: Any = None,
    to_xy: Any = None,
) -> list[dict[str, Any]]:
    """Lay one wall tile per tile along a walkable path."""
    route = _path_route_tiles(path_points, from_xy=from_xy, to_xy=to_xy)
    return [{"name": name, "anchor": {"x": x, "y": y}} for x, y in route]


def plan_pole_route(
    path_points: Any,
    *,
    name: str = "big-electric-pole",
    spacing: int | None = None,
    from_xy: Any = None,
    to_xy: Any = None,
) -> list[dict[str, Any]]:
    """Place poles along a walkable route at wire-reach intervals."""
    route = _path_route_tiles(path_points, from_xy=from_xy, to_xy=to_xy)
    if not route:
        return []
    reach = int(POWER_POLE_SPECS.get(name, (5, 7.5))[1])
    step = int(spacing) if spacing is not None else max(1, reach)
    if step < 1:
        raise ValueError("spacing must be >= 1")
    if step > reach:
        raise ValueError(f"spacing {step} exceeds {name} wire reach {reach}")
    indices = list(range(0, len(route), step))
    if indices[-1] != len(route) - 1:
        indices.append(len(route) - 1)
    return [
        {"name": name, "anchor": {"x": route[i][0], "y": route[i][1]}}
        for i in indices
    ]


def _underground_axis(
    from_xy: Any, to_xy: Any, label: str
) -> tuple[tuple[int, int], tuple[int, int], int, int]:
    """Start tile, unit step, flow direction and tile span for a straight line."""
    start_x, start_y = _planner_point(from_xy, f"{label} from")
    end_x, end_y = _planner_point(to_xy, f"{label} to")
    x1, y1, x2, y2 = int(start_x), int(start_y), int(end_x), int(end_y)
    if (x1, y1) == (x2, y2):
        raise ValueError(f"{label} needs distinct endpoints (zero-length line is not valid)")
    if x1 != x2 and y1 != y2:
        raise ValueError(
            f"{label} only supports straight horizontal or vertical lines; "
            "diagonal routing is not supported"
        )
    if y1 == y2:
        step_x = 1 if x2 > x1 else -1
        return (x1, y1), (step_x, 0), (4 if step_x > 0 else 12), abs(x2 - x1)
    step_y = 1 if y2 > y1 else -1
    return (x1, y1), (0, step_y), (8 if step_y > 0 else 0), abs(y2 - y1)


def _underground_distance(value: Any, *, default: int | None = None) -> int:
    if value is None:
        if default is None:
            raise ValueError("max_distance must be a positive integer")
        return default
    try:
        number = float(value)
    except (TypeError, ValueError) as error:
        raise ValueError("max_distance must be a positive integer") from error
    if not math.isfinite(number) or number < 1 or not number.is_integer():
        raise ValueError("max_distance must be a positive integer")
    return int(number)


def _underground_layout(length: int, distance: int) -> list[tuple[int, str]]:
    """Offsets/roles for one straight underground run.

    Pairs are input at ``offset`` and output at ``offset + distance`` (both on
    the line), followed by one surface connector tile when the line continues.
    Items flow from the pair output into that surface tile and then into the
    next pair, so consecutive pairs never overlap and the run stays continuous.
    Tails shorter than a pair are laid with surface tiles.
    """
    layout: list[tuple[int, str]] = []
    offset = 0
    while offset <= length:
        if length - offset >= distance:
            layout.append((offset, "input"))
            output_offset = offset + distance
            layout.append((output_offset, "output"))
            offset = output_offset + 1
            if offset <= length:
                layout.append((offset, "surface"))
                offset += 1
        else:
            layout.append((offset, "surface"))
            offset += 1
    return layout


def _plan_underground_run(
    from_xy: Any,
    to_xy: Any,
    *,
    distance: int,
    pair_name: str,
    surface_name: str,
    surface_direction: str,
    label: str,
) -> list[dict[str, Any]]:
    start, step, direction, length = _underground_axis(from_xy, to_xy, label)
    entities: list[dict[str, Any]] = []
    for offset, role in _underground_layout(length, distance):
        x = start[0] + step[0] * offset
        y = start[1] + step[1] * offset
        if role == "surface":
            entity: dict[str, Any] = {
                "name": surface_name,
                "anchor": {"x": x, "y": y},
                "direction": direction if surface_direction == "flow" else 0,
            }
        else:
            entity = {
                "name": pair_name,
                "anchor": {"x": x, "y": y},
                "direction": direction,
                "underground_type": role,
            }
        entities.append(entity)
    return entities


def _underground_belt_names(name: str) -> tuple[str, str, int]:
    """(surface belt, underground belt, default distance) for a belt tier."""
    if not isinstance(name, str) or not name:
        raise ValueError("name must be a belt entity name")
    if name in UNDERGROUND_BELT_TIERS:
        pair_name, distance = UNDERGROUND_BELT_TIERS[name]
        return name, pair_name, distance
    for surface_name, (pair_name, distance) in UNDERGROUND_BELT_TIERS.items():
        if name == pair_name:
            return surface_name, pair_name, distance
    # Modded/unknown tier: keep the requested surface name and the base
    # underground belt so the plan still builds something the API knows.
    return name, "underground-belt", UNDERGROUND_BELT_TIERS["transport-belt"][1]


def plan_underground_belt_line(
    from_xy: Any,
    to_xy: Any,
    *,
    name: str = "transport-belt",
    max_distance: Any = None,
) -> list[dict[str, Any]]:
    """Straight underground-belt line from `from_xy` to `to_xy`.

    Layout convention: every pair is an input at the current tile and an output
    at input + ``distance`` tiles along the flow direction (both pieces face the
    flow direction); the pair is followed by one surface ``name`` belt tile when
    the line continues, and tails shorter than a pair are surface belts. Items
    flow continuously: pair output -> surface tile -> next pair input. Pairs are
    laid from `from` toward `to`, so a reverse call mirrors directions (result
    stays in path order; no tile repeats).

    ``distance`` is the tile offset between input and output anchors. With
    ``max_distance=None`` the standard tier distance is inferred from ``name``:
    transport-belt 4, fast-transport-belt 6, express-transport-belt 8 (the
    manager/game is authoritative and rejects over-distance pairs). Unknown or
    modded tiers keep the requested surface name with the base underground belt
    and distance 4; pass ``max_distance`` for those. Underground entity names can
    also be passed as ``name`` (for example "fast-underground-belt").

    Returns entities for the build API with ``underground_type: "input" |
    "output"`` on pair pieces. Straight lines only; diagonal routing raises
    ValueError.
    """
    surface_name, pair_name, tier_distance = _underground_belt_names(name)
    distance = _underground_distance(max_distance, default=tier_distance)
    return _plan_underground_run(
        from_xy,
        to_xy,
        distance=distance,
        pair_name=pair_name,
        surface_name=surface_name,
        surface_direction="flow",
        label="underground belt line",
    )


def plan_underground_pipe_line(
    from_xy: Any,
    to_xy: Any,
    *,
    max_distance: Any = UNDERGROUND_PIPE_DEFAULT_DISTANCE,
) -> list[dict[str, Any]]:
    """Straight pipe-to-ground line from `from_xy` to `to_xy`.

    Same pair layout as :func:`plan_underground_belt_line`: a ``pipe-to-ground``
    input at the current tile and output at input + ``max_distance`` tiles along
    the flow direction, separated by one surface ``pipe`` connector tile while
    the line continues, with surface pipes for tails shorter than a pair. Items
    flow pair output -> surface pipe -> next pair input. ``max_distance``
    defaults to 10 (the standard pipe-to-ground distance) and must be a positive
    integer; the manager/game remains authoritative for the real limit. Returns
    entities with ``underground_type: "input" | "output"`` on pair pieces.
    Straight lines only; diagonal routing raises ValueError.
    """
    distance = _underground_distance(max_distance, default=UNDERGROUND_PIPE_DEFAULT_DISTANCE)
    return _plan_underground_run(
        from_xy,
        to_xy,
        distance=distance,
        pair_name=UNDERGROUND_PIPE_NAME,
        surface_name="pipe",
        surface_direction="none",
        label="underground pipe line",
    )


def plan_power_line(
    from_xy: Any,
    to_xy: Any,
    *,
    pole: str = POWER_POLE_DEFAULT,
    spacing: int | None = None,
) -> list[dict[str, Any]]:
    """Place a straight horizontal/vertical power-pole line.

    This is the recommended trunk layout: all poles share one axis, spacing is
    bounded by the selected pole's wire reach, and the two endpoints are included
    exactly. For long runs use big-electric-pole (30-tile reach); for local
    machine coverage use build_power_network with small/medium poles or
    substations. Diagonal lines are rejected so the result stays 横平竖直.
    """
    start_x, start_y = _planner_point(from_xy, "from")
    end_x, end_y = _planner_point(to_xy, "to")
    x1, y1, x2, y2 = int(start_x), int(start_y), int(end_x), int(end_y)
    if x1 != x2 and y1 != y2:
        raise ValueError("plan_power_line only supports a straight horizontal or vertical line")
    if not isinstance(pole, str) or not pole:
        raise ValueError("pole must be an entity name")
    reach = int(POWER_POLE_SPECS.get(pole, (5, 7.5))[1])
    step = int(spacing) if spacing is not None else max(1, reach)
    if step < 1:
        raise ValueError("spacing must be >= 1")
    if step > reach:
        raise ValueError(f"spacing {step} exceeds {pole} wire reach {reach}")
    length = abs((x2 - x1) if y1 == y2 else (y2 - y1))
    if length == 0:
        return []
    direction = 1 if (x2 - x1 if y1 == y2 else y2 - y1) > 0 else -1
    positions = [0]
    while positions[-1] + step < length:
        positions.append(positions[-1] + step)
    if positions[-1] != length:
        positions.append(length)
    return [
        {
            "name": pole,
            "anchor": {
                "x": x1 + (offset * direction if y1 == y2 else 0),
                "y": y1 + (offset * direction if x1 == x2 else 0),
            },
        }
        for offset in positions
    ]


def plan_power_network(
    targets_or_area: Any,
    *,
    pole: str = POWER_POLE_DEFAULT,
    big_pole_every: int = 0,
) -> list[dict[str, Any]]:
    """Poles covering the bounding box of entity targets or a scan area.

    Conventions: a small-electric-pole supply area is 5x5 centred on the pole
    tile, so poles are placed on a 5-tile grid (`POWER_TILE_STEP`) where adjacent
    poles are within the 7.5-tile wire reach (5 straight / ~7.07 diagonal).
    The whole union rectangle of the targets is covered; this is a simple,
    deterministic tiling, not a wire-length optimum, and existing pole entities
    found in `targets` are kept (deduped) but not re-emitted.

    `targets_or_area` accepts a target list (each `{x,y}`, `(x, y)`, or
    `{anchor:{x,y},width?,height?}` entity) or an `{x,y,radius}` area. The area
    is the square that fits the scan, so poles can sit outside open entrances.
    Pole spacing comes from `POWER_POLE_SPECS`: small/medium cover on a 5-tile
    grid, substations on an 18-tile grid, while big poles have a tiny supply area
    and should be used with :func:`plan_power_line` for transmission trunks.

    `big_pole_every` replaces every Nth generated pole (1-based row-major order)
    with a big-electric-pole for long-haul wiring; its smaller supply area is not
    re-tiled, so leave 0 unless that trade-off is intended.
    """
    if not isinstance(pole, str) or not pole:
        raise ValueError("pole must be an entity name")
    every = int(big_pole_every)
    if every < 0:
        raise ValueError("big_pole_every must be >= 0")
    area = _planner_area(targets_or_area)
    existing: set[tuple[int, int]] = set()
    boxes: list[tuple[int, int, int, int]] = []
    if area is not None:
        boxes.append(area)
    else:
        if isinstance(targets_or_area, dict):
            targets = [targets_or_area]
        else:
            targets = _planner_sequence(targets_or_area, "targets")
        if not targets:
            raise ValueError("plan_power_network needs at least one target or an area")
        for index, target in enumerate(targets):
            if isinstance(target, dict) and target.get("name") in POWER_POLE_NAMES:
                anchor = target.get("anchor")
                try:
                    anchor_x, anchor_y = _planner_point(anchor, f"target {index} anchor")
                except ValueError:
                    anchor_x, anchor_y = _planner_point(target, f"target {index}")
                existing.add((int(anchor_x), int(anchor_y)))
                continue
            boxes.append(_planner_box(target, index))
        if not boxes:
            raise ValueError("plan_power_network needs at least one non-pole target")
    min_x = min(box[0] for box in boxes)
    min_y = min(box[1] for box in boxes)
    max_x = max(box[2] for box in boxes)
    max_y = max(box[3] for box in boxes)
    entities: list[dict[str, Any]] = []
    generated = 0
    supply = POWER_POLE_SPECS.get(pole, (5, 7.5))[0]
    for y in _cover_axis(min_y, max_y, supply):
        for x in _cover_axis(min_x, max_x, supply):
            if (x, y) in existing:
                continue
            generated += 1
            name = POWER_POLE_BIG if every and generated % every == 0 else pole
            entities.append({"name": name, "anchor": {"x": x, "y": y}})
    return _sort_entities(entities)


def plan_inserter_pairs(
    entities: Any,
    *,
    direction: Any = "east",
    inserter: str = "inserter",
    width: int = 3,
    height: int = 3,
) -> list[dict[str, Any]]:
    """Input+output inserter pairs around machines, one pair per machine.

    Factorio inserter direction is the pickup side, so an east-flow pair faces
    west: the input inserter west of the machine picks up from the west belt and
    drops east into the machine; the output inserter east of it picks up from the
    machine and drops east onto the belt. West/north/south mirror this rule.
    Inserts are deduped by tile, so two machines one tile apart share a single
    machine-to-machine inserter. `direction` accepts east/west/north/south (or
    4/12/0/8). Footprints default to 3x3 and can be overridden per machine with
    `width`/`height`/`tile_size` or by the call-wide defaults.
    """
    flows = {
        "east": (4, "horizontal"),
        "west": (12, "horizontal"),
        "south": (8, "vertical"),
        "north": (0, "vertical"),
    }
    if isinstance(direction, int):
        flow = {4: "east", 12: "west", 8: "south", 0: "north"}.get(direction)
    else:
        flow = str(direction).lower()
    if flow not in flows:
        raise ValueError("direction must be east, west, north or south")
    drop_direction, axis = flows[flow]
    direction_value = opposite_direction(drop_direction)
    machine_list = _planner_sequence(entities, "entities")
    machines: list[tuple[int, int, int, int]] = []
    for index, machine in enumerate(machine_list):
        if isinstance(machine, dict) and isinstance(machine.get("anchor"), dict):
            anchor_x, anchor_y = _planner_point(machine["anchor"], f"entity {index} anchor")
        else:
            anchor_x, anchor_y = _planner_point(machine, f"entity {index}")
        tile_size = machine.get("tile_size") if isinstance(machine, dict) else None
        tile_size = tile_size if isinstance(tile_size, dict) else {}
        entity_width = machine.get("width") if isinstance(machine, dict) else None
        entity_height = machine.get("height") if isinstance(machine, dict) else None
        machine_width, machine_height = _planner_size(
            {
                "width": entity_width or tile_size.get("width") or width,
                "height": entity_height or tile_size.get("height") or height,
            },
            (width, height),
        )
        machines.append((int(anchor_x), int(anchor_y), machine_width, machine_height))
    machines.sort(key=lambda machine: (machine[1], machine[0]))
    emitted: dict[tuple[int, int], dict[str, Any]] = {}
    for anchor_x, anchor_y, machine_width, machine_height in machines:
        if axis == "horizontal":
            center_y = anchor_y + machine_height // 2
            if flow == "east":
                candidates = [(anchor_x - 1, center_y), (anchor_x + machine_width, center_y)]
            else:
                candidates = [(anchor_x + machine_width, center_y), (anchor_x - 1, center_y)]
        else:
            center_x = anchor_x + machine_width // 2
            if flow == "south":
                candidates = [(center_x, anchor_y - 1), (center_x, anchor_y + machine_height)]
            else:
                candidates = [(center_x, anchor_y + machine_height), (center_x, anchor_y - 1)]
        for x, y in candidates:
            if (x, y) in emitted:
                continue  # shared machine-to-machine inserter
            emitted[(x, y)] = {
                "name": inserter,
                "anchor": {"x": x, "y": y},
                "direction": direction_value,
            }
    return _sort_entities(list(emitted.values()))


def plan_mining_outpost(
    patch_area_or_centers: Any,
    *,
    drill: str = "electric-mining-drill",
    drill_grid: Any = None,
    output: str | None = "iron-chest",
    inserter: str = "inserter",
) -> dict[str, Any]:
    """Mining outpost plan: drills on a grid over ore, with belt rows and a chest.

    Input is an ore-tile list (`[{x,y}, ...]`, e.g. from `observe-resources`) or
    an `{x,y,radius}` area that is treated as fully ore-filled. Drills are laid
    on `drill_grid` (default 3x3) anchors aligned to the ore bounding box, with
    one output-belt row between drill rows (`height + 1` stride); a chest is fed
    by one inserter at the end of each row. Ore rows in the belt gaps and ore
    outside the drill grid are reported as warnings and are not mined.

    Returns `{"entities": [...], "warnings": [...]}`. Surface transport only:
    no underground belts, no power poles for electric drills, no resource
    coverage guarantee for arbitrary patch shapes.
    """
    drill_width, drill_height = _planner_size(drill_grid, (3, 3))
    warnings: list[str] = []
    area = _planner_area(patch_area_or_centers)
    ore_tiles: set[tuple[int, int]] | None = None
    if area is not None:
        min_x, min_y, max_x, max_y = area
        warnings.append(
            "area input assumes ore fills the whole square; pass explicit ore tiles for exact coverage"
        )
    else:
        ore_tiles = set()
        for index, tile in enumerate(_planner_sequence(patch_area_or_centers, "ore tiles")):
            if isinstance(tile, dict) and isinstance(tile.get("anchor"), dict):
                tile_x, tile_y = _planner_point(tile["anchor"], f"ore tile {index} anchor")
            else:
                tile_x, tile_y = _planner_point(tile, f"ore tile {index}")
            ore_tiles.add((int(tile_x), int(tile_y)))
        if not ore_tiles:
            raise ValueError("plan_mining_outpost needs at least one ore tile or an area")
        min_x = min(tile[0] for tile in ore_tiles)
        min_y = min(tile[1] for tile in ore_tiles)
        max_x = max(tile[0] for tile in ore_tiles)
        max_y = max(tile[1] for tile in ore_tiles)
    row_stride = drill_height + 1  # one output-belt row between drill rows
    drill_columns = list(range(min_x, max_x + 1, drill_width))
    drill_rows: list[int] = []
    row = min_y
    while row <= max_y:
        drill_rows.append(row)
        row += row_stride
    drills: list[tuple[int, int]] = []
    skipped = 0
    for anchor_y in drill_rows:
        for anchor_x in drill_columns:
            has_ore = area is not None or any(
                (x, y) in ore_tiles
                for x in range(anchor_x, anchor_x + drill_width)
                for y in range(anchor_y, anchor_y + drill_height)
            )
            if has_ore:
                drills.append((anchor_x, anchor_y))
            else:
                skipped += 1
    if skipped:
        warnings.append(f"skipped {skipped} drill positions with no ore under their footprint")
    if ore_tiles is not None:
        covered = {
            (x, y)
            for anchor_x, anchor_y in drills
            for x in range(anchor_x, anchor_x + drill_width)
            for y in range(anchor_y, anchor_y + drill_height)
        }
        uncovered = ore_tiles - covered
        if uncovered:
            warnings.append(
                f"{len(uncovered)} ore tiles are not covered by any drill "
                "(output-belt gap rows or grid edge)"
            )
    elif len(drill_rows) > 1:
        warnings.append(
            f"output belts leave {len(drill_rows) - 1} ore rows between drill rows unmined"
        )
    if "electric" in drill:
        warnings.append("electric drills need power; no power network is planned by this helper")
    entities: list[dict[str, Any]] = [
        {"name": drill, "anchor": {"x": anchor_x, "y": anchor_y}}
        for anchor_x, anchor_y in drills
    ]
    for anchor_y in drill_rows:
        row_columns = [anchor_x for anchor_x, row_y in drills if row_y == anchor_y]
        if not row_columns:
            continue
        belt_y = anchor_y + drill_height
        belt_columns = list(range(min(row_columns), max(row_columns) + drill_width))
        entities.extend(
            {"name": "transport-belt", "anchor": {"x": belt_x, "y": belt_y}, "direction": 4}
            for belt_x in belt_columns
        )
        if output:
            inserter_x = belt_columns[-1] + 1
            entities.append(
                # Pickup from the west belt, drop east into the chest.
                {"name": inserter, "anchor": {"x": inserter_x, "y": belt_y}, "direction": 12}
            )
            entities.append({"name": output, "anchor": {"x": inserter_x + 1, "y": belt_y}})
    return {"entities": _sort_entities(entities), "warnings": warnings}


def plan_defense_line(
    from_xy: Any,
    to_xy: Any,
    *,
    turret: str = "gun-turret",
    wall: str | None = "stone-wall",
    spacing: int = 8,
    ammo_chest: str | None = None,
    inserter: str = "inserter",
) -> dict[str, Any]:
    """Defense line plan: 2x2 turrets spaced along the line, wall row in front.

    The front side is +y (south) for horizontal lines and +x (east) for vertical
    lines; callers flip the endpoints/coordinates to face another direction.
    Turret anchors are laid from the lower coordinate every `spacing` tiles, a
    one-tile wall row sits two tiles in front of the turret row, and with
    `ammo_chest` each turret gets a chest behind it plus an inserter feeding it.

    Returns `{"entities": [...], "warnings": [...]}`. Single wall layer, no
    gates, no power and no ammo production are planned.
    """
    start_x, start_y = _planner_point(from_xy, "from")
    end_x, end_y = _planner_point(to_xy, "to")
    x1, y1, x2, y2 = int(start_x), int(start_y), int(end_x), int(end_y)
    if x1 != x2 and y1 != y2:
        raise ValueError("defense line must be horizontal or vertical")
    gap = int(spacing)
    if gap < 2:
        raise ValueError("spacing must be at least 2 tiles for 2x2 turrets")
    entities: list[dict[str, Any]] = []
    warnings: list[str] = [
        "defense line is a single wall layer with no gates, power or ammo production"
    ]
    if x1 == x2 and y1 == y2:
        warnings.append("defense line endpoints are identical; placing one turret")
    if y1 == y2:
        low, high = sorted((x1, x2))
        anchors: list[tuple[int, int]] = []
        x = low
        while x + 1 <= high:
            anchors.append((x, y1))
            x += gap
        if not anchors:
            anchors.append((low, y1))
            warnings.append("line is shorter than a 2x2 turret footprint")
        for anchor_x, anchor_y in anchors:
            entities.append(
                {"name": turret, "anchor": {"x": anchor_x, "y": anchor_y}, "direction": 8}
            )
            if ammo_chest:
                entities.append(
                    # Pickup north from the chest, drop south into the turret.
                    {"name": inserter, "anchor": {"x": anchor_x, "y": anchor_y - 1}, "direction": 0}
                )
                entities.append(
                    {"name": ammo_chest, "anchor": {"x": anchor_x, "y": anchor_y - 2}}
                )
        if wall:
            entities.extend(
                {"name": wall, "anchor": {"x": wall_x, "y": y1 + 2}}
                for wall_x in range(low, high + 1)
            )
    else:
        low, high = sorted((y1, y2))
        anchors = []
        y = low
        while y + 1 <= high:
            anchors.append((x1, y))
            y += gap
        if not anchors:
            anchors.append((x1, low))
            warnings.append("line is shorter than a 2x2 turret footprint")
        for anchor_x, anchor_y in anchors:
            entities.append(
                {"name": turret, "anchor": {"x": anchor_x, "y": anchor_y}, "direction": 4}
            )
            if ammo_chest:
                entities.append(
                    # Pickup west from the chest, drop east into the turret.
                    {"name": inserter, "anchor": {"x": anchor_x - 1, "y": anchor_y}, "direction": 12}
                )
                entities.append(
                    {"name": ammo_chest, "anchor": {"x": anchor_x - 2, "y": anchor_y}}
                )
        if wall:
            entities.extend(
                {"name": wall, "anchor": {"x": x1 + 2, "y": wall_y}}
                for wall_y in range(low, high + 1)
            )
    return {"entities": _sort_entities(entities), "warnings": warnings}


def parse_copy_targets(values: list[str]) -> list[dict[str, Any]]:
    """CLI helper: parse `source-x,source-y,target-x,target-y` copy-settings pairs."""
    targets = []
    for entry in values:
        parts = [part.strip() for part in entry.split(",")]
        if len(parts) != 4:
            raise ValueError(
                f"Invalid --target '{entry}', expected source-x,source-y,target-x,target-y"
            )
        numbers = [parse_number(part, None) for part in parts]
        if any(number is None for number in numbers):
            raise ValueError(
                f"Invalid --target '{entry}', expected source-x,source-y,target-x,target-y"
            )
        source_x, source_y, target_x, target_y = numbers
        targets.append(
            {
                "source": {"x": source_x, "y": source_y},
                "target": {"x": target_x, "y": target_y},
            }
        )
    return targets


def _parse_sized_points(values: list[str], label: str) -> list[dict[str, Any]]:
    """CLI helper: parse `x,y[,width,height]` planner target/machine lists."""
    points = []
    for entry in values:
        parts = [part.strip() for part in entry.split(",")]
        if len(parts) not in (2, 4):
            raise ValueError(f"Invalid {label} '{entry}', expected x,y[,width,height]")
        x, y = parse_number(parts[0], None), parse_number(parts[1], None)
        if x is None or y is None:
            raise ValueError(f"Invalid {label} '{entry}', expected x,y[,width,height]")
        point: dict[str, Any] = {"x": x, "y": y}
        if len(parts) == 4:
            width, height = parse_number(parts[2], None), parse_number(parts[3], None)
            if width is None or height is None:
                raise ValueError(f"Invalid {label} '{entry}', expected x,y[,width,height]")
            point["width"] = width
            point["height"] = height
        points.append(point)
    return points


def _parse_area_flag(value: str, label: str = "area") -> dict[str, Any]:
    """CLI helper: parse an `x,y,radius` area flag."""
    parts = [part.strip() for part in value.split(",")]
    if len(parts) != 3:
        raise ValueError(f"Invalid --{label}, expected x,y,radius")
    numbers = [parse_number(part, None) for part in parts]
    if any(number is None for number in numbers):
        raise ValueError(f"Invalid --{label}, expected x,y,radius")
    x, y, radius = numbers
    return {"x": x, "y": y, "radius": radius}


def _wait_timeout(timeout: float) -> float:
    """Cap blocking waits: the agent should switch to useful work instead."""
    max_wait = float(os.environ.get("AUTORIO_MAX_WAIT_SECONDS", "5") or 5)
    return max(0.0, min(float(timeout), max_wait))


REFACTOR_SCOPE_TYPES: dict[str, list[str]] = {
    "belts": ["transport-belt", "underground-belt", "splitter"],
    "power": ["electric-pole", "generator", "boiler", "solar-panel", "accumulator", "lamp"],
    "pipes": ["pipe", "pipe-to-ground", "pump", "offshore-pump", "storage-tank"],
    "machines": [
        "furnace", "assembling-machine", "lab", "mining-drill", "pumpjack",
        "oil-refinery", "chemical-plant", "centrifuge", "rocket-silo", "inserter",
    ],
    "containers": ["container", "logistic-container"],
    "rail": [
        "straight-rail", "curved-rail", "rail-signal", "rail-chain-signal",
        "train-stop", "locomotive", "cargo-wagon", "fluid-wagon", "artillery-wagon",
    ],
}


def expand_refactor_scope(scope: list[str] | None) -> list[str]:
    """Map belt/power/pipes/machines/rail scopes to observe-area type filters."""
    if not scope:
        return []
    types: list[str] = []
    for raw in scope:
        name = str(raw).strip().lower()
        if name not in REFACTOR_SCOPE_TYPES:
            raise ValueError(
                f"Unknown refactor scope {raw!r}; use belts,power,pipes,machines,rail")
        for entity_type in REFACTOR_SCOPE_TYPES[name]:
            if entity_type not in types:
                types.append(entity_type)
    return types


class FactorioClient:
    """Synchronous Python client for the Factorio manager API.

    Observation methods return the server response envelope so callers retain
    metadata such as ``truncated``. Action methods return the action job. By
    default they wait for a terminal job state; pass ``detach=True`` to return
    immediately after submission.
    """

    def __init__(self, base_url: str = DEFAULT_BASE, *, poll_interval: float = POLL_INTERVAL_SECONDS):
        self.base_url = base_url.rstrip("/")
        self.poll_interval = max(0.0, float(poll_interval))

    def request(self, method: str, path: str, body: Any = None) -> Any:
        return http_request(self.base_url, method, path, body)

    def list_blueprints(self, run_id: str | None = None) -> Any:
        """Return blueprints available for one run (or the active run)."""
        path = f"/api/runs/{quote(run_id, safe='')}/blueprints" if run_id else "/api/blueprints"
        return self.request("GET", path)

    def save_blueprint(
        self,
        blueprint: Any,
        *,
        label: str | None = None,
        description: str | None = None,
        source: str = "saved",
        run_id: str | None = None,
    ) -> Any:
        """Persist a blueprint string (or decoded payload) for the current run."""
        if isinstance(blueprint, str):
            wire = blueprint
        else:
            wire = encode_blueprint_string(blueprint)
        body: dict[str, Any] = {"blueprint": wire, "source": source}
        if label:
            body["label"] = label
        if description:
            body["description"] = description
        active_id = run_id or os.environ.get("AUTORIO_RUN_ID")
        path = f"/api/runs/{quote(active_id, safe='')}/blueprints" if active_id else "/api/blueprints"
        return self.request("POST", path, body)

    def capture_blueprint(self, *, x: float = 0, y: float = 0, radius: int = 80,
                          label: str | None = None,
                          description: str | None = None) -> Any:
        """Capture the current built layout in an area into the run blueprint registry."""
        return self.request("POST", "/api/agent/blueprints/capture", {
            "window": {"x": x, "y": y, "radius": radius},
            "label": label,
            "description": description,
        })

    def evaluate_blueprint(self, *, blueprint: Any = None, blueprint_id: str | None = None,
                           outputs: dict[str, float] | None = None,
                           power_kw: float | None = None,
                           build_seconds: float | None = None) -> Any:
        """Evaluate a blueprint's structural (and optional dynamic) efficiency."""
        if blueprint is not None and not isinstance(blueprint, str):
            raise ValueError("blueprint must be a blueprint string")
        body: dict[str, Any] = {
            "blueprint": blueprint,
            "blueprint_id": blueprint_id,
            "outputs": outputs or {},
            "power_kw": power_kw,
            "build_seconds": build_seconds,
        }
        return self.request("POST", "/api/agent/blueprints/evaluate", body)

    def _blueprint_payload(self, *, blueprint: Any = None,
                           blueprint_id: str | None = None) -> dict[str, Any]:
        if blueprint_id:
            active_id = os.environ.get("AUTORIO_RUN_ID")
            path = (f"/api/runs/{quote(active_id, safe='')}/blueprints/{quote(blueprint_id, safe='')}"
                    if active_id else f"/api/blueprints/{quote(blueprint_id, safe='')}")
            detail = data_value(self.request("GET", path))
            wire = detail.get("wire") if isinstance(detail, dict) else None
            if not isinstance(wire, str):
                raise ValueError("blueprint detail did not contain a wire string")
            return decode_blueprint_string(wire)
        if isinstance(blueprint, str):
            return decode_blueprint_string(blueprint)
        if isinstance(blueprint, dict):
            return blueprint
        raise ValueError("provide blueprint, blueprint_id or a file")

    def analyze_blueprint(self, *, blueprint: Any = None,
                          blueprint_id: str | None = None) -> dict[str, Any]:
        """Lane-level flow, supply check, lint and lane-mix analysis.

        Ported from factorio-blueprint-tools (MIT); see blueprint_analysis/NOTICE.
        """
        payload = self._blueprint_payload(blueprint=blueprint, blueprint_id=blueprint_id)
        from blueprint_analysis import analyze_blueprint_payload
        return analyze_blueprint_payload(payload)

    def diff_blueprint(self, *, before: Any = None, after: Any = None,
                       before_id: str | None = None,
                       after_id: str | None = None) -> dict[str, Any]:
        """Structural difference between two blueprint versions/ids."""
        before_payload = self._blueprint_payload(blueprint=before, blueprint_id=before_id)
        after_payload = self._blueprint_payload(blueprint=after, blueprint_id=after_id)
        from blueprint_analysis import diff_blueprint_payloads
        return diff_blueprint_payloads(before_payload, after_payload)

    def map_preview_exchange(self, map_string: str, *, size: int = 1024,
                             planets: list[str] | None = None) -> dict[str, Any]:
        """Decode a map exchange string and render all requested planets."""
        payload: dict[str, Any] = {"map_string": map_string, "size": size}
        if planets:
            payload["planets"] = planets
        return data_value(self.request("POST", "/api/map-preview/exchange", payload))

    def generate_blueprint_gamedata(self, dump_file: str | None = None,
                                    output_file: str | None = None) -> dict[str, Any]:
        """Regenerate blueprint recipe/footprint data from Factorio --dump-data."""
        import json
        from blueprint_analysis.gamedata import SLIM_PATH, slim_from_dump

        candidate = dump_file or os.environ.get("FBP_DATA_DUMP")
        if not candidate:
            appdata = os.environ.get("APPDATA")
            if appdata:
                candidate = str(Path(appdata) / "Factorio" / "script-output" / "data-raw-dump.json")
        if not candidate:
            raise ValueError("No data-raw-dump.json path; pass --dump-file or set FBP_DATA_DUMP")
        source = Path(candidate)
        if not source.exists():
            raise ValueError(f"data dump not found: {source}")
        dump = json.loads(source.read_text(encoding="utf-8"))
        slim = slim_from_dump(dump)
        slim["source"] = f"{source} (regenerated locally)"
        target = Path(output_file) if output_file else Path(SLIM_PATH)
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(json.dumps(slim, sort_keys=True, indent=0) + "\n", encoding="utf-8")
        return {
            "ok": True,
            "source": str(source),
            "output": str(target),
            "recipes": len(slim["recipes"]),
            "footprints": len(slim["footprints"]),
            "bytes": target.stat().st_size,
        }

    def server_status(self) -> Any:
        return self.request("GET", "/api/server/status")

    def server_saves(self) -> Any:
        return self.request("GET", "/api/saves")

    def create_save(self, name: str) -> Any:
        return self.request("POST", "/api/saves", {"name": name})

    def save_active_game(self) -> Any:
        return self.request("POST", "/api/server/save")

    def server_start(self, save: str) -> Any:
        return self.request("POST", "/api/server/start", {"save": save})

    def server_stop(self) -> Any:
        return self.request("POST", "/api/server/stop")

    def observe_world(self, *, x: float = 0, y: float = 0, radius: float = 12,
                      include: list[str] | None = None) -> Any:
        return self.request("POST", "/api/agent/observe/world", {
            "window": {"x": x, "y": y, "radius": radius},
            "include": include or ["terrain", "entities"],
        })

    def observe_map(self, *, x: float = 0, y: float = 0, radius: float = 48) -> Any:
        return self.request("POST", "/api/agent/observe/map", {
            "window": {"x": x, "y": y, "radius": radius},
        })

    def observe_map_overview(
        self, *, x: float = 0, y: float = 0, radius: float = 128, size: int = 96,
        format: str | None = None,
    ) -> Any:
        """Compact charted map thumbnail (ASCII rows by default; format="svg")."""
        body: dict[str, Any] = {
            "window": {"x": x, "y": y, "radius": radius},
            "size": size,
        }
        if format:
            body["format"] = format
        return self.request("POST", "/api/agent/observe/map-overview", body)

    def observe_player(self, *, inventory_slots: int | None = None,
                       equipment_slots: int | None = None) -> Any:
        return self.request("POST", "/api/agent/observe/player", {"limits": {
            "inventory_slots": inventory_slots,
            "equipment_slots": equipment_slots,
        }})

    def observe_research(self, *, available: int | None = None,
                         locked: int | None = None,
                         completed: int | None = None) -> Any:
        return self.request("POST", "/api/agent/observe/research", {"limits": {
            "available": available,
            "locked": locked,
            "completed": completed,
        }})

    def observe_recipes(self, *, recipes: int | None = None,
                        unlocked_only: bool = False) -> Any:
        return self.request("POST", "/api/agent/observe/recipes", {
            "limits": {"recipes": recipes},
            "filters": {"unlocked": True} if unlocked_only else None,
        })

    def observe_entities(self, targets: list[dict[str, Any]]) -> Any:
        return self.request("POST", "/api/agent/observe/entity", {"targets": targets})

    def observe_resources(self, *, x: float = 0, y: float = 0,
                          radius: float = 50) -> Any:
        return self.request("POST", "/api/agent/observe/resources", {
            "window": {"x": x, "y": y, "radius": radius},
        })

    def build_belt_line(self, start: dict[str, Any], end: dict[str, Any],
                        *, name: str = "transport-belt", **options: Any) -> Any:
        entities = belt_line_entities(start, end, name)
        _assert_valid_belt_plan(entities, from_xy=start, to_xy=end)
        return self.build(entities, **options)

    def build_loader(self, source: dict[str, Any], target: dict[str, Any],
                     *, name: str = "inserter", **options: Any) -> Any:
        return self.build([loader_entity(source, target, name)], **options)

    def observe_factory(self, *, x: float | None = None, y: float | None = None,
                        radius: float = 120) -> Any:
        window: dict[str, Any] = {"radius": radius}
        if x is not None:
            window["x"] = x
        if y is not None:
            window["y"] = y
        return self.request("POST", "/api/agent/observe/factory", {"window": window})

    def state(self) -> Any:
        """Read the active run's STATE.md freshness/status."""
        return self.request("GET", "/api/agent/state")

    def tools(self, query: str | None = None, *, local: bool = False) -> Any:
        """Fetch the generated manifest, falling back to local introspection.

        A manager can legitimately be older than the workspace client; the
        response carries ``source``/``client_outdated`` so agents know when to
        trust the local manifest instead of assuming a missing method is absent.
        """
        if local:
            return {
                "schema_version": 2,
                "ok": True,
                "cmd": "tools",
                "data": {**tool_manifest(), "source": "local"},
                "local": True,
            }
        path = "/api/agent/tools"
        if query:
            path += f"?q={quote(str(query), safe='')}"
        try:
            response = self.request("GET", path)
        except Exception as error:
            return {
                "schema_version": 2,
                "ok": True,
                "cmd": "tools",
                "data": {**tool_manifest(), "source": "local", "fallback": True,
                         "fallback_reason": str(error)},
                "fallback": True,
            }
        data = data_value(response)
        if isinstance(data, dict):
            data["source"] = "manager"
            manager_hash = (data.get("sources") or {}).get("factorio.py")
            local_hash = (tool_manifest() or {}).get("client_sha256")
            if manager_hash and local_hash and manager_hash != local_hash:
                data["client_outdated"] = True
                data["client_update_hint"] = (
                    "workspace factorio.py differs from the manager manifest; "
                    "start a fresh run or refresh the workspace client")
        return response

    def write_state(self, current: str, *, scores: dict[str, int] | None = None,
                    done_when: str | None = None, next: str | None = None,
                    objective: str | None = None, timebox: str | None = None,
                    progress: str | None = None, notes: str | None = None,
                    markdown: str | None = None) -> Any:
        """Write/refresh STATE.md and reset the state-update deadline gate."""
        body: dict[str, Any] = {"current": current}
        for key, value in {
            "scores": scores,
            "done_when": done_when,
            "next": next,
            "objective": objective,
            "timebox": timebox,
            "progress": progress,
            "notes": notes,
            "markdown": markdown,
        }.items():
            if value is not None:
                body[key] = value
        return self.request("POST", "/api/agent/state", body)

    def factory_audit(self, *, x: float | None = None, y: float | None = None,
                      radius: int = 120, scope: list[str] | None = None,
                      include_rail: bool = False) -> Any:
        """Prioritized refactor audit: problems, belt/power/pipe links and repairs."""
        return self.request("POST", "/api/agent/observe/audit", {
            "window": {"x": x, "y": y, "radius": radius},
            "scope": scope,
            "include_rail": include_rail,
        })

    def observe_pipeline(self, *, x: float | None = None, y: float | None = None,
                         radius: int = 80,
                         flows: dict[str, float] | None = None) -> Any:
        """Structured machine/belt/inserter/pipe/power graph plus bottlenecks.

        ``flows`` optionally annotates nodes/segments with externally measured
        rates (for example belt-count samples or production deltas).
        """
        body: dict[str, Any] = {"window": {"x": x, "y": y, "radius": radius}}
        if flows:
            body["flows"] = {key: float(value) for key, value in flows.items()}
        return self.request("POST", "/api/agent/observe/pipeline", body)

    def observe_free_space(self, *, x: float | None = None, y: float | None = None,
                            radius: int = 60, step: int = 1) -> Any:
        """Buildable grid, blocked cells and largest free rectangles."""
        return self.request("POST", "/api/agent/observe/free-space", {
            "window": {"x": x, "y": y, "radius": radius},
            "step": step,
        })

    def plan_route(self, from_xy: Any, to_xy: Any, *,
                     kind: str = "belt", radius: int | None = None,
                     width: int = 1, spacing: int | None = None,
                     clear: bool = False) -> dict[str, Any]:
        """Plan an orthogonal belt/pipe/wall/power route through free space.

        Uses observe-free-space for the window then A* (plan_grid_route); does
        not build. ``kind`` is belt, pipe, wall or power; use build with the
        returned entities, or pass ``clear`` only for a future build job.
        """
        start_x, start_y = _planner_point(from_xy, "from")
        end_x, end_y = _planner_point(to_xy, "to")
        center_x = (start_x + end_x) / 2
        center_y = (start_y + end_y) / 2
        needed = max(abs(end_x - start_x), abs(end_y - start_y)) / 2 + 12
        window_radius = int(radius) if radius is not None else int(min(120, max(12, needed)))
        free = data_value(self.observe_free_space(
            x=center_x, y=center_y, radius=window_radius, step=1))
        if not isinstance(free, dict) or not isinstance(free.get("rows"), list):
            raise RuntimeError("free-space observation did not return rows")
        route = plan_grid_route(
            (start_x, start_y), (end_x, end_y),
            rows=free["rows"],
            origin=free.get("origin") if isinstance(free.get("origin"), dict) else {},
            step=int(free.get("step") or 1),
            width=width,
        )
        kind_name = str(kind).lower()
        if kind_name == "belt":
            entities = plan_belt_route(route)
            warnings: list[str] = []
        elif kind_name == "pipe":
            entities = plan_pipe_route(route)
            warnings = []
        elif kind_name == "wall":
            entities = plan_wall_route(route)
            warnings = []
        elif kind_name == "power":
            spacing_value = int(spacing) if spacing is not None else 7
            entities = plan_pole_route(route, spacing=spacing_value)
            warnings = []
        else:
            raise ValueError("kind must be belt, pipe, wall or power")
        return {"ok": True, "kind": kind_name, "route": route, "entities": entities,
                "warnings": warnings, "window": free.get("window")}

    def pipeline_audit(self, *, x: float | None = None, y: float | None = None,
                       radius: int = 80) -> dict[str, Any]:
        """Return only the prioritized bottleneck section of the pipeline graph."""
        data = data_value(self.observe_pipeline(x=x, y=y, radius=radius))
        if not isinstance(data, dict):
            return {"ok": False, "error": "invalid pipeline response"}
        return {
            "counts": data.get("counts"),
            "window": data.get("window"),
            "bottlenecks": data.get("bottlenecks", []),
            "bottleneck_actions": data.get("bottleneck_actions", []),
        }

    def observe_connections(self, *, x: float | None = None, y: float | None = None,
                            radius: float = 120) -> Any:
        window: dict[str, Any] = {"radius": radius}
        if x is not None:
            window["x"] = x
        if y is not None:
            window["y"] = y
        return self.request("POST", "/api/agent/observe/connections", {"window": window})

    def observe_layout(self, *, x: float | None = None, y: float | None = None,
                       radius: float = 35, step: int = 1) -> Any:
        window: dict[str, Any] = {"radius": radius, "step": step}
        if x is not None:
            window["x"] = x
        if y is not None:
            window["y"] = y
        return self.request("POST", "/api/agent/observe/layout", {"window": window})

    def observe_entity_prototype(self, name: str) -> Any:
        return self.request("POST", "/api/agent/observe/entity-prototype", {"name": name})

    def describe(self, name: str, *, kind: str = "entity") -> Any:
        """Resolve an entity/technology localised description in the game locale."""
        return self.request("POST", "/api/agent/observe/description", {
            "kind": kind,
            "name": name,
        })

    def entity_usage(self, name: str) -> Any:
        """Curated behavior/placement rules plus prototype metadata for an entity."""
        return self.request("POST", "/api/agent/observe/entity-usage", {"name": name})

    def entity_usage_catalog(self) -> Any:
        """All curated entity behavior/placement rules, no game RCON needed."""
        return self.request("GET", "/api/agent/observe/entity-usage-catalog")

    def knowledge(self, topic: str | None = None) -> Any:
        """Concise engineering knowledge for inserters/pipes/trains/power/chemistry/defense/production/blueprints."""
        path = "/api/agent/knowledge"
        if topic:
            path += "?topic=" + quote(str(topic), safe="")
        return self.request("GET", path)

    def alerts(self) -> Any:
        """Read the manager's current critical/warning alert envelope."""
        return self.request("GET", "/api/agent/alerts")

    def ack_alerts(self) -> Any:
        """Acknowledge the current alert revision (does not fix the alerts)."""
        return self.request("POST", "/api/agent/alerts/ack")

    def observe_placement(self, placements: list[dict[str, Any]]) -> Any:
        return self.request("POST", "/api/agent/observe/placement", {"placements": placements})

    def observe_production(self) -> Any:
        """Per-minute production/consumption rates from the manager's sampler.

        The sampler fills its first window lazily, so the first call after RCON
        connects can answer 409 "telemetry not ready"; retry that case once after
        ``max(poll_interval, 0.5)`` seconds, then let the error propagate. The
        server attempts a live sample on the first call, so failures here mean
        RCON/game state, not a missing window.
        """
        try:
            return self.request("POST", "/api/agent/observe/production", {})
        except RuntimeError as error:
            if "telemetry not ready" not in str(error):
                raise
            time.sleep(max(self.poll_interval, 0.5))
            return self.request("POST", "/api/agent/observe/production", {})

    def observe_fluids(self, x: float | None = None, y: float | None = None,
                       radius: int = 32) -> Any:
        """Fluid networks/levels around a window (defaults to the player position)."""
        return self.request("POST", "/api/agent/observe/fluids", {
            "x": x, "y": y, "radius": radius,
        })

    def observe_combat(self, x: float | None = None, y: float | None = None,
                       radius: int = 64) -> Any:
        """Read-only enemy nests/units, player turrets, and player health scan."""
        return self.request("POST", "/api/agent/observe/combat", {
            "x": x, "y": y, "radius": radius,
        })

    def observe_area(self, x: float | None = None, y: float | None = None,
                     radius: int = 64, *,
                     limit: int | None = None, types: list[str] | None = None,
                     filters: list[str] | None = None, player_only: bool = False,
                     order: str = "name") -> Any:
        """Deconstruction-planning entity list for an area (name/type/position).

        Omitted coordinates are stripped from the request body, so the server
        falls back to its own defaults. Server defaults exclude resources,
        characters and cliffs; explicit ``types`` can include them.
        """
        return self.request("POST", "/api/agent/observe/area", {
            "window": {"x": x, "y": y, "radius": radius},
            "limit": limit,
            "types": types,
            "filters": filters,
            "player_only": player_only,
            "order": order,
        })

    def container_contents(self, x: float, y: float) -> dict[str, Any]:
        """Observe a chest/container at a tile and return its inventory stacks."""
        observation = self.observe_entities([{"x": x, "y": y}])
        data = data_value(observation)
        if isinstance(data, dict):
            results = data.get("results")
            if isinstance(results, list) and results:
                data = results[0]
        items = _observation_inventory_items(observation)
        return {"ok": bool(isinstance(data, dict) and data.get("ok")), "entity": data, "items": items}

    def belt_contents(self, x: float, y: float) -> dict[str, Any]:
        """Read items currently on a belt/splitter/underground line at a tile."""
        observation = self.observe_entities([{"x": x, "y": y}])
        data = data_value(observation)
        first = {}
        if isinstance(data, dict) and isinstance(data.get("results"), list) and data["results"]:
            first = data["results"][0] if isinstance(data["results"][0], dict) else {}
        return {"ok": bool(first.get("ok")), "entity": first.get("name"), "belt": first.get("belt")}

    def fluid_contents(self, x: float, y: float) -> dict[str, Any]:
        """Read the actual fluids currently inside a pipe/fluid entity."""
        observation = self.observe_entities([{"x": x, "y": y}])
        data = data_value(observation)
        first = {}
        if isinstance(data, dict) and isinstance(data.get("results"), list) and data["results"]:
            first = data["results"][0] if isinstance(data["results"][0], dict) else {}
        return {
            "ok": bool(first.get("ok")),
            "entity": first.get("name"),
            "fluid_contents": first.get("fluid_contents") or [],
            "fluid_boxes": first.get("fluid_boxes") or [],
        }

    def container_transfer(self, source: dict[str, Any], target: dict[str, Any],
                           *, item: str | None = None,
                           count: int | str | None = None) -> dict[str, Any]:
        """Move items from one container to another through the player inventory.

        ``item=None`` moves every stack; ``count=None/'all'`` moves all matching
        items. The source is emptied before the target is filled, so a full target
        leaves leftovers in the player inventory (report them).
        """
        contents = self.container_contents(float(source["x"]), float(source["y"]))
        stacks = contents.get("items") if isinstance(contents.get("items"), list) else []
        wanted: dict[str, int] = {}
        for stack in stacks:
            name = stack.get("name") if isinstance(stack, dict) else None
            amount = stack.get("count") if isinstance(stack, dict) else None
            if not isinstance(name, str) or (item and name != item):
                continue
            wanted[name] = wanted.get(name, 0) + int(amount or 0)
        moved: dict[str, int] = {}
        errors: list[str] = []
        for name, available in wanted.items():
            amount = available if count is None or count == "all" else min(available, int(count))
            if amount <= 0:
                continue
            extracted = self.extract(source, name, "all")
            removed = int((_job_first_result(extracted) or {}).get("removed") or 0)
            if removed <= 0:
                errors.append(f"extract failed for {name}")
                continue
            inserted = self.insert(target, name, removed)
            placed = int((_job_first_result(inserted) or {}).get("inserted") or 0)
            moved[name] = moved.get(name, 0) + placed
            if placed < removed:
                errors.append(f"target full for {name}: {removed - placed} left in player inventory")
        return {"ok": not errors, "moved": moved, "left_in_player": bool(errors), "errors": errors}

    def recover_debris(self, *, x: float = 0, y: float = 0, radius: int = 64,
                       limit: int = 300) -> dict[str, Any]:
        """Recover crash-site spaceship debris near a point.

        Scans containers and simple entities whose name starts with
        ``crash-site-spaceship``, extracts their loot into the player inventory,
        then mines each piece. Returns recovered items and per-entity errors.
        """
        response = self.observe_area(x, y, radius, limit=limit, player_only=False,
                                     types=["container", "simple-entity-with-owner"])
        data = data_value(response)
        entities = data.get("entities") if isinstance(data, dict) else None
        debris = [entity for entity in entities if isinstance(entity, dict)
                  and isinstance(entity.get("name"), str)
                  and entity["name"].startswith("crash-site-spaceship")] if isinstance(entities, list) else []
        recovered: dict[str, int] = {}
        results: list[dict[str, Any]] = []

        def process(entity: dict[str, Any], retry_alert: bool = True) -> dict[str, Any]:
            target = {"x": int(entity["x"]), "y": int(entity["y"])}
            name = str(entity["name"])
            loot: dict[str, int] = {}
            try:
                try:
                    self.ack_alerts()
                except Exception:
                    pass  # Keep clearing loot even if the alert endpoint is unavailable.
                contents = self.container_contents(target["x"], target["y"])
                for stack in contents.get("items", []) if isinstance(contents.get("items"), list) else []:
                    if isinstance(stack, dict) and isinstance(stack.get("name"), str):
                        loot[stack["name"]] = loot.get(stack["name"], 0) + int(stack.get("count") or 0)
                for item_name in loot:
                    job = self.extract(target, item_name, "all")
                    result = _job_first_result(job) or {}
                    removed = int(result.get("removed") or 0)
                    if removed:
                        recovered[item_name] = recovered.get(item_name, 0) + removed
                mined = self.mine([{**target, "kind": "entity", "name": name, "allow_buildings": True}])
                result = _job_first_result(mined) or {}
                return {"name": name, **target, "loot": loot, "mined": result.get("ok") is not False}
            except Exception as error:  # Per-debris failure must not abort the sweep.
                if retry_alert and "ALERTS_PENDING" in str(error):
                    try:
                        self.ack_alerts()
                        return process(entity, retry_alert=False)
                    except Exception:
                        pass
                return {"name": name, **target, "error": str(error)}

        for entity in debris:
            results.append(process(entity))
        return {"ok": not any("error" in item for item in results), "debris": len(debris),
                "recovered": recovered, "results": results}

    def copy_settings(self, targets: list[dict[str, Any]], *, dry_run: bool = False) -> Any:
        """Copy entity settings between source/target pairs.

        ``dry_run`` uses the read-only observe route (reach/compatibility report);
        otherwise the synchronous act route mutates settings. Both are NOT job
        queued and do not walk the character: call ``move()`` so the character is
        within reach of every source and target first, then read the per-target
        results for unreachable/incompatible pairs.
        """
        path = "/api/agent/observe/copy-settings" if dry_run else "/api/agent/act/copy-settings"
        return self.request("POST", path, {"targets": targets})

    def copy_settings_check(self, targets: list[dict[str, Any]]) -> Any:
        """Dry-run alias of :meth:`copy_settings` (no settings are changed)."""
        return self.copy_settings(targets, dry_run=True)

    def observe_snapshot(self, x: float | None = None, y: float | None = None,
                         radius: int = 64) -> dict[str, Any]:
        """Player + factory + research + production in one sequential call.

        Saves agent round trips and prompt tokens versus four separate calls.
        Each part holds the response ``data``; a failing part is recorded as
        ``{"ok": false, "error": ...}`` in place and in ``errors``, and the
        aggregate ``ok`` becomes false. Production is polled last via
        :meth:`observe_production` (which retries the not-ready case once).
        """
        snapshot: dict[str, Any] = {"ok": True}
        errors: list[dict[str, str]] = []

        def record(name: str, call: Callable[[], Any]) -> None:
            try:
                snapshot[name] = data_value(call())
            except Exception as error:  # A partial snapshot must still be useful.
                message = str(error) or error.__class__.__name__
                snapshot[name] = {"ok": False, "error": message}
                errors.append({"part": name, "error": message})

        record("player", lambda: self.observe_player())
        record("factory", lambda: self.observe_factory(x=x, y=y, radius=radius))
        record("research", lambda: self.observe_research())
        record("production", lambda: self.observe_production())
        if errors:
            snapshot["ok"] = False
            snapshot["errors"] = errors
        return snapshot

    def unstick(self, *, max_removals: int = 8) -> dict[str, Any]:
        """Escape a player trapped by player-owned buildings.

        Tries a short path in eight directions first; if every route is blocked,
        mines low-value blocking belts/pipes/poles/walls (last resort: machines)
        one at a time until a route opens. Uses native mining and never teleports.
        """
        max_removals = max(1, int(max_removals))
        try:
            self.ack_alerts()
        except Exception:
            pass  # Rescue is best-effort even without an active run/alerts.
        player = self.player_position()
        px, py = int(math.floor(player["x"])), int(math.floor(player["y"]))
        targets = [(px + dx * 4, py + dy * 4) for dx, dy in
                   ((1, 0), (-1, 0), (0, 1), (0, -1), (1, 1), (1, -1), (-1, 1), (-1, -1))]
        def find_route() -> tuple[int, int] | None:
            for tx, ty in targets:
                try:
                    if _job_path_points(self.preview_path(tx + 0.5, ty + 0.5)):
                        return tx, ty
                except Exception:
                    continue
            return None

        def move_out(tx: int, ty: int) -> dict[str, Any]:
            try:
                result = self.move([{"x": tx, "y": ty}])
                return {"moved_to": {"x": tx, "y": ty}, "move_result": result}
            except Exception as error:
                return {"move_error": str(error), "moved_to": {"x": tx, "y": ty}}

        route = find_route()
        if route:
            return {"ok": True, "escaped": True, "removed": [], "method": "path", **move_out(*route)}
        area = self.observe_area(px, py, 3, player_only=True, limit=100)
        data = data_value(area)
        entities = data.get("entities") if isinstance(data, dict) else []
        priority = {
            "transport-belt": 0, "fast-transport-belt": 0, "express-transport-belt": 0,
            "underground-belt": 0, "fast-underground-belt": 0, "express-underground-belt": 0,
            "splitter": 0, "fast-splitter": 0, "express-splitter": 0,
            "pipe": 0, "pipe-to-ground": 0, "small-electric-pole": 1,
            "medium-electric-pole": 1, "big-electric-pole": 1, "substation": 1,
            "stone-wall": 1, "gate": 1, "inserter": 2,
        }
        candidates: list[tuple[int, int, dict[str, Any]]] = []
        for entity in entities if isinstance(entities, list) else []:
            if not isinstance(entity, dict):
                continue
            name = entity.get("name")
            try:
                x, y = int(entity["x"]), int(entity["y"])
            except (KeyError, TypeError, ValueError):
                continue
            score = priority.get(str(name), 4)
            candidates.append((score, abs(x - px) + abs(y - py), {"x": x, "y": y, "name": name}))
        candidates.sort(key=lambda item: (item[0], item[1]))
        removed: list[dict[str, Any]] = []
        for _score, _distance, target in candidates[:max_removals]:
            job = self.mine([{**target, "kind": "entity", "allow_buildings": True}])
            result = _job_first_result(job) or {}
            if result.get("ok") is False:
                continue
            removed.append(target)
            route = find_route()
            if route:
                return {
                    "ok": True,
                    "escaped": True,
                    "removed": removed,
                    "method": "mined_blocker",
                    **move_out(*route),
                }
        return {
            "ok": False,
            "error": "blocked_no_escape",
            "removed": removed,
            "hint": "No low-value blocker opened a path; inspect the enclosure from outside or deconstruct a larger opening.",
        }

    def player_position(self) -> dict[str, float]:
        player = data_value(self.observe_player())["player"]
        return {"x": float(player["x"]), "y": float(player["y"])}

    def inventory_counts(self) -> dict[str, int]:
        player = data_value(self.observe_player())["player"]
        counts: dict[str, int] = {}
        for container in player.get("inventories", []):
            for slot in container.get("slots", []):
                name, count = slot.get("name"), slot.get("count")
                if name and count:
                    counts[name] = counts.get(name, 0) + count
        return counts

    def wait_until(self, predicate: Callable[[], Any], *, timeout: float = 300,
                   interval: float | None = None) -> Any:
        """Poll a condition and return as soon as it is truthy."""
        delay = self.poll_interval if interval is None else max(0.05, interval)
        budget = _wait_timeout(timeout)
        deadline = time.monotonic() + budget
        while True:
            value = predicate()
            if value:
                return value
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise TimeoutError(
                f"condition not met within {budget:g}s; do not wait — switch to the next useful task"
            )
            time.sleep(min(delay, remaining))

    def wait_for_item(self, item: str, count: int = 1, *, timeout: float = 300,
                      interval: float = 1.0) -> dict[str, int]:
        self.wait_until(lambda: self.inventory_counts().get(item, 0) >= count,
                        timeout=timeout, interval=interval)
        return self.inventory_counts()

    def wait_for_research(self, technology: str, *, timeout: float = 600,
                          interval: float = 2.0) -> Any:
        def completed() -> bool:
            data = data_value(self.observe_research(completed=200))
            return any(tech.get("name") == technology for tech in data.get("completed", []))
        self.wait_until(completed, timeout=timeout, interval=interval)
        return technology

    def wait_for_factory(self, *, max_no_fuel: int = 0, max_no_power: int = 0,
                         radius: float = 120, timeout: float = 300,
                         interval: float = 3.0) -> Any:
        def stable() -> bool:
            data = data_value(self.observe_factory(radius=radius))
            totals = data.get("totals", {})
            return (totals.get("no_fuel", 0) <= max_no_fuel and
                    totals.get("no_power", 0) <= max_no_power)
        self.wait_until(stable, timeout=timeout, interval=interval)
        return data_value(self.observe_factory(radius=radius))

    def wait_for_production(self, item: str, rate: float, *, timeout: float = 600,
                            interval: float = 5.0, stable_polls: int = 2) -> Any:
        """Wait until ``item`` is produced at >= ``rate`` per minute.

        ``stable_polls`` consecutive polls must meet the rate (guards against a
        one-sample spike). Returns the last production observation ``data``;
        raises ``TimeoutError`` with the last rate and telemetry-timeout count.
        """
        required = max(1, int(stable_polls))
        delay = max(0.05, float(interval))
        deadline = time.monotonic() + _wait_timeout(timeout)
        consecutive = 0
        timeouts = 0
        last: Any = None
        last_rate: float | None = None
        while True:
            try:
                response = self.observe_production()
                last = data_value(response)
                rates = last.get("production_per_minute") if isinstance(last, dict) else None
                try:
                    last_rate = float((rates or {}).get(item, 0) or 0)
                except (TypeError, ValueError):
                    last_rate = 0.0
            except RuntimeError:
                timeouts += 1
                consecutive = 0
            else:
                if last_rate is not None and last_rate >= float(rate):
                    consecutive += 1
                    if consecutive >= required:
                        return last
                else:
                    consecutive = 0
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise TimeoutError(
                    f"production of {item} did not reach {rate:g}/min within {timeout:g}s "
                    f"(last {last_rate if last_rate is not None else 'unavailable'}/min, "
                    f"telemetry timeouts {timeouts})"
                )
            time.sleep(min(delay, remaining))

    def wait_for_fluid(self, fluid: str, amount: float, *, timeout: float = 600,
                       interval: float = 5.0) -> Any:
        """Wait until the scanned fluid networks hold >= ``amount`` of ``fluid``.

        Polls :meth:`observe_fluids` (default radius around the player) and sums
        the ``fluids[fluid].amount`` aggregate that the endpoint returns; returns
        the last observation ``data``. Raises ``TimeoutError`` with the last
        amount and telemetry-timeout count.
        """
        delay = max(0.05, float(interval))
        deadline = time.monotonic() + max(0.0, float(timeout))
        timeouts = 0
        last: Any = None
        last_amount = 0.0
        while True:
            try:
                response = self.observe_fluids()
                last = data_value(response)
                fluids = last.get("fluids") if isinstance(last, dict) else None
                entry = fluids.get(fluid) if isinstance(fluids, dict) else None
                try:
                    last_amount = float((entry or {}).get("amount", 0) or 0)
                except (TypeError, ValueError):
                    last_amount = 0.0
            except RuntimeError:
                timeouts += 1
            else:
                if last_amount >= float(amount):
                    return last
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise TimeoutError(
                    f"fluid {fluid} did not reach {amount:g} within {timeout:g}s "
                    f"(last amount {last_amount:g}, telemetry timeouts {timeouts})"
                )
            time.sleep(min(delay, remaining))

    def submit_action(self, action: str, payload: Any, *, detach: bool = False,
                      idempotency_key: str | None = None,
                      timeout: float | None = None) -> Any:
        job = self.request("POST", "/api/agent/jobs", {
            "action": action,
            "payload": payload,
            "idempotency_key": idempotency_key,
        })
        if detach:
            return job
        job_id = job.get("job_id") if isinstance(job, dict) else None
        if not job_id:
            raise RuntimeError("Server did not return a job ID")
        return self.wait_for_job(str(job_id), timeout=timeout, initial=job)

    def wait_for_job(self, job_id: str, *, timeout: float | None = None,
                     initial: Any = None) -> Any:
        started = time.monotonic()
        job = initial if initial is not None else self.job_status(job_id)
        while isinstance(job, dict) and job.get("status") in ("queued", "running"):
            if timeout is not None and time.monotonic() - started >= timeout:
                raise TimeoutError(f"Timed out waiting for job {job_id}")
            time.sleep(self.poll_interval)
            job = self.job_status(job_id)
        return job

    def job_status(self, job_id: str) -> Any:
        encoded_id = quote(str(job_id), safe="-_.!~*'()")
        return self.request("GET", f"/api/agent/jobs/{encoded_id}")

    def job_cancel(self, job_id: str) -> Any:
        encoded_id = quote(str(job_id), safe="-_.!~*'()")
        return self.request("POST", f"/api/agent/jobs/{encoded_id}/cancel")

    def build(self, entities: list[dict[str, Any]], *, clear: bool = True,
              **options: Any) -> Any:
        """Build entities after mining trees/rocks from their footprints."""
        return self.submit_action(
            "build", {"entities": entities, "clear_obstacles": clear}, **options)

    def _blueprint_prototype_sizes(
        self, names: list[str]
    ) -> tuple[dict[str, dict[str, int]], list[str]]:
        """Look up entity footprints through observe-entity-prototype (best effort)."""
        sizes: dict[str, dict[str, int]] = {}
        warnings: list[str] = []
        for name in names:
            try:
                data = data_value(self.observe_entity_prototype(name))
            except Exception as error:  # A failed lookup must not abort the build.
                warnings.append(f"prototype lookup failed for {name}: {error}")
                continue
            tile = data.get("tile_size") if isinstance(data, dict) else None
            if not isinstance(tile, dict):
                warnings.append(f"prototype {name} has no tile_size; assuming 1x1")
                continue
            try:
                width, height = int(tile.get("width")), int(tile.get("height"))
            except (TypeError, ValueError):
                warnings.append(f"prototype {name} has an invalid tile_size; assuming 1x1")
                continue
            if width <= 0 or height <= 0:
                warnings.append(f"prototype {name} has an invalid tile_size; assuming 1x1")
                continue
            sizes[name] = {"width": width, "height": height}
        return sizes, warnings

    def _register_blueprint_best_effort(self, blueprint: Any, *, source: str = "built") -> None:
        """Best-effort per-run registry write; a blueprint build must not fail if UI storage does."""
        run_id = os.environ.get("AUTORIO_RUN_ID")
        if not run_id:
            return
        try:
            self.save_blueprint(blueprint, source=source, run_id=run_id)
        except Exception:
            if os.environ.get("AUTORIO_BLUEPRINT_REGISTRY_STRICT") == "1":
                raise

    def build_blueprint(
        self,
        blueprint: Any,
        *,
        anchor: Any = None,
        dry_run: bool = False,
        clear: bool = True,
        max_per_job: int = BLUEPRINT_MAX_ENTITIES_PER_JOB,
        offset: tuple[float, float] = (0, 0),
        prototype_sizes: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        """Decode, expand and build a Factorio blueprint string.

        Entities are built in sequential jobs of at most ``max_per_job`` (capped
        at the manager limit of 50); per-entity results and obstacle clearing
        summaries are aggregated. Fatal job failures stop the remaining chunks
        and are reported as ``failed_chunk``/``error``; individual entity
        failures are returned in ``results`` and make ``ok`` false without
        aborting later chunks.

        ``dry_run`` builds nothing: it returns the expanded entities, a chunked
        placement analysis, and the blueprint items missing from the player
        inventory. ``ok`` is false when a build job fails, when any entity
        result reports ``ok: false``, or (dry run) when items are missing.
        ``anchor``/``offset``/``prototype_sizes`` behave like
        :func:`expand_blueprint`; missing footprints are fetched from
        ``observe-entity-prototype`` (or pass ``prototype_sizes`` directly).
        """
        self._register_blueprint_best_effort(blueprint, source="built")
        payload = _coerce_blueprint(blueprint)
        raw_entities = _blueprint_entities(payload)
        if not raw_entities:
            raise ValueError("blueprint contains no entities")
        limit = int(max_per_job)
        if limit < 1:
            raise ValueError("max_per_job must be at least 1")
        limit = min(limit, BLUEPRINT_MAX_ENTITIES_PER_JOB)
        sizes: dict[str, Any] = dict(prototype_sizes or {})
        unique_names = list(
            dict.fromkeys(
                entity["name"]
                for entity in raw_entities
                if isinstance(entity.get("name"), str) and entity.get("name")
            )
        )
        unresolved = [name for name in unique_names if _prototype_size(sizes, name) is None]
        warnings: list[str] = []
        if unresolved:
            fetched, lookup_warnings = self._blueprint_prototype_sizes(unresolved)
            sizes.update(fetched)
            warnings.extend(lookup_warnings)
            for name in unresolved:
                if _prototype_size(sizes, name) is None:
                    warnings.append(
                        f"unknown footprint for {name}; assuming 1x1 "
                        "(pass prototype_sizes for an exact anchor)"
                    )
        entities = expand_blueprint(payload, anchor=anchor, offset=offset, prototype_sizes=sizes)
        required = blueprint_required_items(payload)
        if dry_run:
            placement_results: list[Any] = []
            placement_truncated = False
            for start in range(0, len(entities), BLUEPRINT_MAX_ENTITIES_PER_JOB):
                response = self.observe_placement(
                    entities[start:start + BLUEPRINT_MAX_ENTITIES_PER_JOB]
                )
                data = data_value(response)
                if isinstance(data, dict):
                    placement_results.extend(data.get("results") or [])
                if isinstance(response, dict) and response.get("truncated"):
                    placement_truncated = True
            available = self.inventory_counts()
            missing_items = [
                {
                    "name": name,
                    "required": count,
                    "available": available.get(name, 0),
                    "missing": count - available.get(name, 0),
                }
                for name, count in required.items()
                if count > available.get(name, 0)
            ]
            missing_items.sort(key=lambda entry: entry["name"])
            return {
                "ok": not missing_items,
                "entities": entities,
                "placement": {"results": placement_results, "truncated": placement_truncated},
                "missing_items": missing_items,
                "required_items": required,
                "warnings": warnings,
            }
        summary = self._submit_planned(
            entities,
            clear=clear,
            max_per_job=limit,
            warnings=warnings,
            include_entities=False,
        )
        summary["blueprint_entities"] = len(entities)
        return summary

    def _run_chunks(
        self,
        items: list[Any],
        submit: Callable[[list[Any]], Any],
        *,
        max_per_job: int = BLUEPRINT_MAX_ENTITIES_PER_JOB,
    ) -> dict[str, Any]:
        """Run items through sequential jobs of at most ``max_per_job``.

        Shared by build planners (:meth:`_submit_planned`, via ``self.build``) and
        deconstruction (via ``self.mine``). Aggregates per-item results and job
        ids, stops on the first fatal job failure (``failed_chunk``/``error``),
        and treats an empty item list as an ok no-op. Per-entity ``ok: false``
        results are kept but do not abort later chunks.
        """
        limit = int(max_per_job)
        if limit < 1:
            raise ValueError("max_per_job must be at least 1")
        limit = min(limit, BLUEPRINT_MAX_ENTITIES_PER_JOB)
        chunks = [items[start:start + limit] for start in range(0, len(items), limit)]
        summary: dict[str, Any] = {
            "ok": True,
            "chunks": 0,
            "max_per_job": limit,
            "results": [],
            "job_ids": [],
        }
        if not chunks:
            return summary
        jobs: list[Any] = []
        results: list[Any] = []
        failed_chunk: int | None = None
        error: str | None = None
        for index, chunk in enumerate(chunks):
            try:
                job = submit(chunk)
            except Exception as chunk_error:  # Stop launching chunks after a job failure.
                failed_chunk = index
                error = str(chunk_error) or chunk_error.__class__.__name__
                break
            jobs.append(job)
            status = job.get("status") if isinstance(job, dict) else None
            if not isinstance(job, dict) or status in ("failed", "cancelled"):
                failed_chunk = index
                error = (
                    str(job.get("error"))
                    if isinstance(job, dict) and job.get("error")
                    else f"job for chunk {index} {status or 'failed'}"
                )
                break
            chunk_results = job.get("results")
            if not isinstance(chunk_results, list) or not chunk_results:
                failed_chunk = index
                error = f"job for chunk {index} returned no results"
                break
            results.extend(chunk_results)
        ok = failed_chunk is None and bool(results) and all(
            isinstance(result, dict) and result.get("ok") is not False for result in results
        )
        summary.update(
            ok=ok,
            chunks=len(chunks),
            results=results,
            job_ids=[job.get("job_id") for job in jobs if isinstance(job, dict)],
        )
        if failed_chunk is not None:
            summary["failed_chunk"] = failed_chunk
            summary["error"] = error
        return summary

    def _submit_planned(
        self,
        plan_entities: list[dict[str, Any]],
        *,
        clear: bool = True,
        max_per_job: int = BLUEPRINT_MAX_ENTITIES_PER_JOB,
        warnings: list[str] | None = None,
        include_entities: bool = True,
    ) -> dict[str, Any]:
        """Submit a planned entity list in <=50-entity jobs and aggregate results.

        Shared executor for the blueprint and construction planners: sequential
        jobs, per-entity result/clearing aggregation, fatal-chunk stop with
        ``failed_chunk``/``error``, and an empty-plan no-op success.
        """
        plan_entities = [dict(entity) for entity in plan_entities]
        summary = self._run_chunks(
            plan_entities,
            lambda chunk: self.build(chunk, clear=clear),
            max_per_job=max_per_job,
        )
        cleared = 0
        skipped: list[Any] = []
        pending_remaining = 0
        clearing_ok = True
        for result in summary["results"]:
            clearing = result.get("clearing") if isinstance(result, dict) else None
            if not isinstance(clearing, dict):
                continue
            cleared_entries = clearing.get("cleared")
            if isinstance(cleared_entries, list):
                cleared += len(cleared_entries)
            if isinstance(clearing.get("skipped"), list):
                skipped.extend(clearing["skipped"])
            try:
                pending_remaining += int(clearing.get("pending_remaining") or 0)
            except (TypeError, ValueError):
                pass
            if clearing.get("ok") is False:
                clearing_ok = False
        summary["clearing"] = {
            "ok": clearing_ok,
            "cleared": cleared,
            "skipped": skipped,
            "pending_remaining": pending_remaining,
        }
        summary["warnings"] = list(warnings or [])
        if include_entities:
            summary["entities"] = plan_entities
        return summary

    def _resolve_plan(self, plan: Any) -> tuple[list[dict[str, Any]], list[str]]:
        if isinstance(plan, dict):
            entities = plan.get("entities")
            warnings = plan.get("warnings") or []
            if not isinstance(entities, list):
                raise ValueError("plan must contain an entities list")
            return (
                [dict(entity) for entity in entities if isinstance(entity, dict)],
                [str(warning) for warning in warnings],
            )
        if isinstance(plan, list):
            return [dict(entity) for entity in plan if isinstance(entity, dict)], []
        raise ValueError("plan must be an entity list or {'entities': [...]}")

    def geometry_check(self, entities: Any, *,
                       prototype_sizes: dict[str, Any] | None = None) -> dict[str, Any]:
        """Check planned footprints, rotations, overlaps and native placement.

        Does not build. Prototype sizes are inferred per unique entity name via
        observe-entity-prototype unless provided as {name: {width,height}}.
        """
        normalized = normalize_build_entities(entities)
        sizes = dict(prototype_sizes or {})
        for entity in normalized:
            name = entity["name"]
            if name in sizes:
                continue
            prototype = data_value(self.observe_entity_prototype(name))
            tile_size = prototype.get("tile_size") if isinstance(prototype, dict) else None
            if not isinstance(tile_size, dict):
                raise ValueError(f"cannot resolve prototype size for {name!r}")
            sizes[name] = tile_size
        direction_errors: list[dict[str, Any]] = []
        valid_directions = {0, 4, 8, 12}
        for index, entity in enumerate(normalized):
            if "direction" not in entity:
                continue
            direction = int(entity.get("direction", 0))
            if direction not in valid_directions:
                direction_errors.append({
                    "index": index,
                    "name": entity["name"],
                    "anchor": entity["anchor"],
                    "direction": direction,
                    "error": "direction must be 0, 4, 8 or 12",
                })
        footprints: list[dict[str, Any]] = []
        for entity in normalized:
            anchor = entity["anchor"]
            try:
                x = int(float(anchor["x"]))
                y = int(float(anchor["y"]))
            except (KeyError, TypeError, ValueError) as error:
                raise ValueError("entity anchor must contain numeric x/y") from error
            size = sizes[entity["name"]]
            try:
                width = int(size["width"])
                height = int(size["height"])
            except (KeyError, TypeError, ValueError) as error:
                raise ValueError(f"invalid prototype size for {entity['name']!r}") from error
            direction = int(entity.get("direction", 0))
            if direction in (4, 12):
                width, height = height, width
            footprints.append({
                "name": entity["name"],
                "anchor": {"x": x, "y": y},
                "direction": direction,
                "width": width,
                "height": height,
                "bbox": {"left": x, "top": y, "right": x + width, "bottom": y + height},
            })
        overlaps: list[dict[str, Any]] = []
        for index, first in enumerate(footprints):
            a = first["bbox"]
            for other in footprints[index + 1:]:
                b = other["bbox"]
                if a["left"] < b["right"] and a["right"] > b["left"] and \
                        a["top"] < b["bottom"] and a["bottom"] > b["top"]:
                    overlaps.append({
                        "a": {"name": first["name"], "anchor": first["anchor"]},
                        "b": {"name": other["name"], "anchor": other["anchor"]},
                    })
        response = self.observe_placement(normalized)
        data = data_value(response)
        results = data.get("results") if isinstance(data, dict) else []
        blockers: list[dict[str, Any]] = []
        for index, result in enumerate(results if isinstance(results, list) else []):
            if not isinstance(result, dict):
                continue
            if result.get("ok") is False or result.get("can_place") is False:
                entity = footprints[index] if index < len(footprints) else {}
                blockers.append({
                    "index": index,
                    "name": entity.get("name"),
                    "anchor": entity.get("anchor"),
                    "error": result.get("error"),
                    "diagnostics": result.get("diagnostics"),
                })
        return {
            "ok": not overlaps and not blockers and not direction_errors,
            "entities": footprints,
            "overlaps": overlaps,
            "blockers": blockers,
            "direction_errors": direction_errors,
            "results": results,
        }

    def plan_build(self, entities: list[dict[str, Any]]) -> dict[str, Any]:
        """Dry-run placement analysis for a planned entity list (chunked by 50).

        Returns ``{ok, entities, results, blockers, missing_items, truncated}``
        without building. ``blockers`` lists entities whose placement analysis
        reports ``ok: false`` or ``can_place: false`` with their diagnostics;
        ``missing_items`` compares the entities' place items against the player
        inventory (entity name assumed to be the item name, like blueprints).
        """
        plan_entities = [dict(entity) for entity in entities]
        if not plan_entities:
            raise ValueError("plan_build needs at least one entity")
        results: list[Any] = []
        truncated = False
        for start in range(0, len(plan_entities), BLUEPRINT_MAX_ENTITIES_PER_JOB):
            chunk = plan_entities[start:start + BLUEPRINT_MAX_ENTITIES_PER_JOB]
            response = self.observe_placement(chunk)
            data = data_value(response)
            if isinstance(data, dict):
                results.extend(data.get("results") or [])
            if isinstance(response, dict) and response.get("truncated"):
                truncated = True
        blockers: list[dict[str, Any]] = []
        for index, result in enumerate(results):
            entity = plan_entities[index] if index < len(plan_entities) else {}
            if not isinstance(result, dict):
                blockers.append({
                    "index": index,
                    "name": entity.get("name"),
                    "anchor": entity.get("anchor"),
                    "error": "invalid placement result",
                })
                continue
            if result.get("ok") is False or result.get("can_place") is False:
                blockers.append({
                    "index": index,
                    "name": entity.get("name"),
                    "anchor": entity.get("anchor"),
                    "intended_center": result.get("intended_center"),
                    "diagnostics": result.get("diagnostics"),
                    "error": result.get("error"),
                })
        required: dict[str, int] = {}
        for entity in plan_entities:
            name = entity.get("name")
            if isinstance(name, str) and name:
                required[name] = required.get(name, 0) + 1
        inventory_warning: str | None = None
        try:
            available: dict[str, int] | None = self.inventory_counts()
        except Exception as error:  # Inventory only feeds the optional preflight.
            available = None
            inventory_warning = (
                f"inventory unavailable: {str(error) or error.__class__.__name__}"
            )
        missing_items = []
        if available is not None:
            missing_items = [
                {
                    "name": name,
                    "required": count,
                    "available": available.get(name, 0),
                    "missing": count - available.get(name, 0),
                }
                for name, count in required.items()
                if count > available.get(name, 0)
            ]
            missing_items.sort(key=lambda entry: entry["name"])
        result: dict[str, Any] = {
            "ok": not blockers and not missing_items,
            "entities": plan_entities,
            "results": results,
            "blockers": blockers,
            "missing_items": missing_items,
            "truncated": truncated,
        }
        if inventory_warning is not None:
            result["warning"] = inventory_warning
        return result

    def _nearest_target_order(
        self,
        targets: list[dict[str, Any]],
        start: tuple[float, float],
    ) -> list[dict[str, Any]]:
        """Order targets by nearest-neighbor travel from ``start`` (stable ties)."""
        remaining = list(targets)
        ordered: list[dict[str, Any]] = []
        current = (float(start[0]), float(start[1]))
        while remaining:
            def distance(target: dict[str, Any]) -> tuple[float, int, int]:
                dx = float(target["x"]) - current[0]
                dy = float(target["y"]) - current[1]
                return (dx * dx + dy * dy, int(target["y"]), int(target["x"]))
            nearest = min(remaining, key=distance)
            ordered.append(nearest)
            remaining.remove(nearest)
            current = (float(nearest["x"]), float(nearest["y"]))
        return ordered

    def deconstruct_area(self, x: float | None = None, y: float | None = None,
                         radius: int = 64, *, limit: int | None = None,
                         types: list[str] | None = None,
                         filters: list[str] | None = None,
                         player_only: bool = True,
                         max_per_job: int = BLUEPRINT_MAX_ENTITIES_PER_JOB,
                         order: str = "nearest",
                         start_xy: Any = None,
                         max_distance: float | None = None,
                         scope: list[str] | None = None,
                         dry_run: bool = False) -> dict[str, Any]:
        """Observe an area and remove the resulting entities with native mining.

        The server's ``observe/area`` scan returns the planning entity list
        (defaults exclude resources, characters and cliffs; ``player_only`` uses
        the ``last_user`` heuristic). Removal then goes through the normal queued
        native miner: one target per entity (kind "resource" for resources,
        otherwise "entity", with its prototype name), in sequential jobs of at
        most ``max_per_job`` (capped at the manager batch limit of 50). This is
        deliberately NOT an instant deconstruct: the character walks, mining
        takes real time, and unreachable/depleted targets fail per entity
        (aggregate ``ok`` false) without stopping later chunks.

        ``dry_run`` returns the plan only (scanned/counts/entities/truncated) and
        never calls ``mine``. An empty area is an ok no-op with zero chunks.
        Fatal job-level failures stop the remaining chunks and report
        ``failed_chunk``/``error``. A scan that reports ``ok: false`` (for
        example no character) raises ``RuntimeError``; HTTP errors propagate like
        the other wrappers.

        Note: trees/rocks (passability) are only included with
        ``player_only=False`` plus explicit ``types`` such as ``["tree"]`` or
        ``["tree", "simple-entity"]``; resources likewise need
        ``types=["resource"]`` (they are excluded by default).
        """
        max_per_job = int(max_per_job)
        if max_per_job < 1:
            raise ValueError("max_per_job must be at least 1")
        max_per_job = min(max_per_job, BLUEPRINT_MAX_ENTITIES_PER_JOB)
        scope_types = expand_refactor_scope(scope)
        if scope_types:
            combined = list(types or [])
            for entity_type in scope_types:
                if entity_type not in combined:
                    combined.append(entity_type)
            types = combined
        response = self.observe_area(
            x, y, radius, limit=limit, types=types, filters=filters,
            player_only=player_only, order="near" if order == "nearest" else "name",
        )
        data = data_value(response)
        if not isinstance(data, dict):
            data = {}
        if data.get("ok") is False:
            raise RuntimeError(str(data.get("error") or "observe-area failed"))
        raw_entities = data.get("entities")
        entities = [entity for entity in raw_entities if isinstance(entity, dict)] \
            if isinstance(raw_entities, list) else []
        targets: list[dict[str, Any]] = []
        for entity in entities:
            try:
                target_x = int(entity["x"])
                target_y = int(entity["y"])
            except (KeyError, TypeError, ValueError):
                continue
            target: dict[str, Any] = {"x": target_x, "y": target_y}
            target["kind"] = "resource" if entity.get("type") == "resource" else "entity"
            # Deconstruction is explicit cleanup, not manual resource work:
            # permit player-owned entities and let the manager award cleanup points.
            target["allow_buildings"] = True
            target["cleanup"] = True
            name = entity.get("name")
            if isinstance(name, str) and name:
                target["name"] = name
            targets.append(target)
        empty_containers_only = bool(scope and "containers" in scope)
        skipped_nonempty_containers = 0
        if empty_containers_only:
            entity_by_tile = {
                (int(entity["x"]), int(entity["y"])): entity
                for entity in entities
                if isinstance(entity, dict)
                and isinstance(entity.get("x"), (int, float))
                and isinstance(entity.get("y"), (int, float))
            }
            kept: list[dict[str, Any]] = []
            for target in targets:
                entity = entity_by_tile.get((int(target["x"]), int(target["y"])), {})
                if entity.get("type") in ("container", "logistic-container"):
                    try:
                        contents = self.container_contents(target["x"], target["y"])
                        items = contents.get("items") if isinstance(contents, dict) else None
                        if isinstance(items, list) and items:
                            skipped_nonempty_containers += 1
                            continue
                    except Exception:
                        # Unknown contents must not be removed automatically.
                        skipped_nonempty_containers += 1
                        continue
                kept.append(target)
            targets = kept

        if order not in ("nearest", "scan"):
            raise ValueError("order must be 'nearest' or 'scan'")
        reference: tuple[float, float] | None = None
        if order == "nearest":
            if start_xy is not None:
                start_x, start_y = _planner_point(start_xy, "start")
                reference = (float(start_x), float(start_y))
            elif x is not None and y is not None:
                reference = (float(x), float(y))
            else:
                try:
                    here = self.player_position()
                    reference = (float(here["x"]), float(here["y"]))
                except Exception:
                    reference = (float(targets[0]["x"]), float(targets[0]["y"])) if targets else (0.0, 0.0)
        skipped_far = 0
        if reference is not None and max_distance is not None:
            limit_distance = float(max_distance)
            if limit_distance < 0:
                raise ValueError("max_distance must be >= 0")
            filtered: list[dict[str, Any]] = []
            for target in targets:
                dx = float(target["x"]) - reference[0]
                dy = float(target["y"]) - reference[1]
                if math.hypot(dx, dy) <= limit_distance:
                    filtered.append(target)
                else:
                    skipped_far += 1
            targets = filtered
        if reference is not None:
            targets = self._nearest_target_order(targets, reference)

        by_type: dict[str, int] = {}
        for entity in entities:
            entity_type = entity.get("type")
            if isinstance(entity_type, str) and entity_type:
                by_type[entity_type] = by_type.get(entity_type, 0) + 1
        counts = data.get("counts") if isinstance(data.get("counts"), dict) else {}
        scanned = data.get("scanned")
        if not isinstance(scanned, int):
            scanned = counts.get("total", len(entities))
        summary: dict[str, Any] = {
            "ok": True,
            "dry_run": bool(dry_run),
            "scanned": scanned,
            "area": data.get("area"),
            "player_only": data.get("player_only", player_only),
            "entities": entities,
            "counts": {
                "total": counts.get("total", len(entities)),
                "matched": counts.get("matched", len(entities)),
                "included": counts.get("included", len(entities)),
                "planned": len(targets),
                "by_type": by_type,
            },
            "truncated": bool(data.get("truncated", False)),
            "matched": len(targets),
            "targets": targets,
            "chunks": 0,
            "max_per_job": max_per_job,
            "order": order,
            "scope": scope,
            "scope_types": scope_types,
            "empty_containers_only": empty_containers_only,
            "skipped_nonempty_containers": skipped_nonempty_containers,
            "start": {"x": reference[0], "y": reference[1]} if reference else None,
            "max_distance": max_distance,
            "skipped_far": skipped_far,
            "results": [],
            "job_ids": [],
        }
        if dry_run:
            return summary
        mining = self._run_chunks(targets, self.mine, max_per_job=max_per_job)
        summary.update(
            ok=mining["ok"],
            chunks=mining["chunks"],
            max_per_job=mining["max_per_job"],
            results=mining["results"],
            job_ids=mining["job_ids"],
        )
        if "failed_chunk" in mining:
            summary["failed_chunk"] = mining["failed_chunk"]
            summary["error"] = mining.get("error")
        return summary

    def build_pipe_line(self, from_xy: Any = None, to_xy: Any = None, *,
                        plan: Any = None, name: str = "pipe",
                        clear: bool = True) -> dict[str, Any]:
        """Plan (or accept) a surface pipe line and build it in chunks."""
        if plan is not None:
            entities, warnings = self._resolve_plan(plan)
        else:
            if from_xy is None or to_xy is None:
                raise ValueError("build_pipe_line needs from/to points or a plan")
            entities, warnings = plan_pipe_line(from_xy, to_xy, name=name), []
        return self._submit_planned(entities, clear=clear, warnings=warnings)

    def build_pipe_route(self, from_xy: Any, to_xy: Any, *,
                         name: str = "pipe", plan: Any = None,
                         underground: bool = True,
                         clear: bool = True) -> dict[str, Any]:
        """Route pipes around water/cliffs using the native pathfinder, then build.

        Falls back to a straight/L plan only when a path is available; if the
        pathfinder reports no_path the caller should choose a different endpoint.
        """
        if plan is not None:
            entities, warnings = self._resolve_plan(plan)
        else:
            x, y = _planner_point(to_xy, "to")
            job = self.preview_path(float(x) + 0.5, float(y) + 0.5)
            path = _job_path_points(job)
            if not path:
                raise ValueError("pathfinder did not return a route; pipe route cannot be planned")
            entities = (
                plan_underground_pipe_route(path, from_xy=from_xy, to_xy=to_xy)
                if underground
                else plan_pipe_route(path, name=name, from_xy=from_xy, to_xy=to_xy)
            )
            warnings = []
        return self._submit_planned(entities, clear=clear, warnings=warnings)

    def build_line(self, kind: str, from_xy: Any = None, to_xy: Any = None, *,
                   name: str | None = None, route: str = "auto",
                   spacing: int | None = None, plan: Any = None,
                   underground: bool = True, clear: bool = True) -> dict[str, Any]:
        """Unified linear builder for pipes, belts, walls, poles and underground pairs.

        ``route="auto"`` asks the native pathfinder for a walkable corridor and
        lays the selected entity along an orthogonal route, avoiding lakes and
        cliffs the same way a character walks. ``route="straight"`` keeps the
        historical L-shaped/straight plan. Underground variants are straight-only.
        """
        if plan is not None:
            entities, warnings = self._resolve_plan(plan)
            return self._submit_planned(entities, clear=clear, warnings=warnings)
        if from_xy is None or to_xy is None:
            raise ValueError("build_line needs from/to points or a plan")
        canonical = str(kind).strip().lower()
        if canonical in ("underground-pipe", "pipe-to-ground"):
            if route != "straight":
                raise ValueError("underground pipe is straight-only; use route='straight' or segment the route")
            return self.build_underground_pipe_line(from_xy, to_xy, clear=clear)
        if canonical in ("underground-belt", "underground"):
            if route != "straight":
                raise ValueError("underground belt is straight-only; use route='straight' or segment the route")
            return self.build_underground_belt_line(
                from_xy, to_xy, name=name or "transport-belt", clear=clear)
        if canonical not in ("pipe", "belt", "wall", "pole"):
            raise ValueError("kind must be pipe, belt, wall, pole, underground-pipe or underground-belt")
        if route not in ("auto", "straight"):
            raise ValueError("route must be auto or straight")
        if route == "auto":
            x, y = _planner_point(to_xy, "to")
            path = _job_path_points(self.preview_path(float(x) + 0.5, float(y) + 0.5))
            if not path:
                raise ValueError("pathfinder did not return a route; choose a reachable waypoint")
            if canonical == "pipe":
                entities = (
                    plan_underground_pipe_route(path, from_xy=from_xy, to_xy=to_xy)
                    if underground
                    else plan_pipe_route(path, name=name or "pipe", from_xy=from_xy, to_xy=to_xy)
                )
            elif canonical == "belt":
                entities = plan_belt_route(
                    path, name=name or "transport-belt", from_xy=from_xy, to_xy=to_xy)
            elif canonical == "wall":
                entities = plan_wall_route(
                    path, name=name or "stone-wall", from_xy=from_xy, to_xy=to_xy)
            else:
                entities = plan_pole_route(
                    path, name=name or "big-electric-pole",
                    spacing=spacing, from_xy=from_xy, to_xy=to_xy)
            warnings = []
        elif canonical == "pipe" and underground:
            entities = plan_underground_pipe_route(
                [from_xy, to_xy], max_distance=UNDERGROUND_PIPE_DEFAULT_DISTANCE)
            warnings = []
        elif canonical == "pipe":
            entities, warnings = plan_pipe_line(from_xy, to_xy, name=name or "pipe"), []
        elif canonical == "belt":
            path = _path_route_tiles([from_xy, to_xy])
            entities = [
                {"name": name or "transport-belt", "anchor": {"x": x, "y": y},
                 "direction": _route_direction(path, i)}
                for i, (x, y) in enumerate(path)
            ]
            warnings = []
        elif canonical == "wall":
            path = _path_route_tiles([from_xy, to_xy])
            entities = [
                {"name": name or "stone-wall", "anchor": {"x": x, "y": y}}
                for x, y in path
            ]
            warnings = []
        else:
            path = _path_route_tiles([from_xy, to_xy])
            entities = plan_pole_route(
                [{"x": x + 0.5, "y": y + 0.5} for x, y in path],
                name=name or "big-electric-pole", spacing=spacing)
            warnings = []
        if canonical == "belt":
            _assert_valid_belt_plan(entities, from_xy=from_xy, to_xy=to_xy)
        return self._submit_planned(entities, clear=clear, warnings=warnings)

    BELT_TYPES = [
        "transport-belt", "fast-transport-belt", "express-transport-belt",
        "underground-belt", "fast-underground-belt", "express-underground-belt",
        "splitter", "fast-splitter", "express-splitter",
    ]

    def relayout_belts(self, x: float, y: float, radius: int = 80,
                       *, dry_run: bool = False) -> dict[str, Any]:
        """Remove all belts in an area so a failed layout can be redesigned.

        Use after a belt section has failed link/connection checks more than
        three times. This intentionally removes every belt in the area
        (player-built or not); dry_run returns the removal plan only.
        """
        return self.deconstruct_area(
            x, y, radius, types=list(self.BELT_TYPES),
            player_only=False, dry_run=dry_run,
        )

    def build_underground_belt_line(self, from_xy: Any = None, to_xy: Any = None, *,
                                    plan: Any = None, name: str = "transport-belt",
                                    max_distance: Any = None,
                                    clear: bool = True) -> dict[str, Any]:
        """Plan (or accept) a straight underground-belt line and build it in chunks.

        Pair entities carry ``underground_type`` for the manager build action;
        per-entity errors such as ``unknown_entity``/``invalid_underground_type``/
        ``missing_item`` are returned unchanged in ``results`` (aggregate ``ok``
        becomes false). See :func:`plan_underground_belt_line` for the layout.
        """
        if plan is not None:
            entities, warnings = self._resolve_plan(plan)
        else:
            if from_xy is None or to_xy is None:
                raise ValueError("build_underground_belt_line needs from/to points or a plan")
            entities = plan_underground_belt_line(
                from_xy, to_xy, name=name, max_distance=max_distance)
            warnings = []
        return self._submit_planned(entities, clear=clear, warnings=warnings)

    def build_underground_pipe_line(self, from_xy: Any = None, to_xy: Any = None, *,
                                    plan: Any = None,
                                    max_distance: Any = UNDERGROUND_PIPE_DEFAULT_DISTANCE,
                                    clear: bool = True) -> dict[str, Any]:
        """Plan (or accept) a straight pipe-to-ground line and build it in chunks.

        Pair entities carry ``underground_type``; server-side placement errors are
        surfaced unchanged in ``results``. See :func:`plan_underground_pipe_line`
        for the layout.
        """
        if plan is not None:
            entities, warnings = self._resolve_plan(plan)
        else:
            if from_xy is None or to_xy is None:
                raise ValueError("build_underground_pipe_line needs from/to points or a plan")
            entities = plan_underground_pipe_line(from_xy, to_xy, max_distance=max_distance)
            warnings = []
        return self._submit_planned(entities, clear=clear, warnings=warnings)

    def build_power_line(self, from_xy: Any, to_xy: Any, *, plan: Any = None,
                         pole: str = POWER_POLE_BIG, spacing: int | None = None,
                         clear: bool = True) -> dict[str, Any]:
        """Plan (or accept) a straight horizontal/vertical pole trunk and build it."""
        if plan is not None:
            entities, warnings = self._resolve_plan(plan)
        else:
            entities = plan_power_line(from_xy, to_xy, pole=pole, spacing=spacing)
            warnings = []
        return self._submit_planned(entities, clear=clear, warnings=warnings)

    def build_power_network(self, targets_or_area: Any = None, *, plan: Any = None,
                            pole: str = POWER_POLE_DEFAULT, big_pole_every: int = 0,
                            clear: bool = True) -> dict[str, Any]:
        """Plan (or accept) a covering pole network and build it in chunks."""
        if plan is not None:
            entities, warnings = self._resolve_plan(plan)
        else:
            if targets_or_area is None:
                raise ValueError("build_power_network needs targets/area or a plan")
            entities = plan_power_network(
                targets_or_area, pole=pole, big_pole_every=big_pole_every
            )
            warnings = []
        return self._submit_planned(entities, clear=clear, warnings=warnings)

    def build_inserter_pairs(self, machines: Any = None, *, plan: Any = None,
                             direction: Any = "east", inserter: str = "inserter",
                             width: int = 3, height: int = 3,
                             clear: bool = True) -> dict[str, Any]:
        """Plan (or accept) input/output inserter pairs and build them in chunks."""
        if plan is not None:
            entities, warnings = self._resolve_plan(plan)
        else:
            if machines is None:
                raise ValueError("build_inserter_pairs needs machines or a plan")
            entities, warnings = plan_inserter_pairs(
                machines,
                direction=direction,
                inserter=inserter,
                width=width,
                height=height,
            ), []
        return self._submit_planned(entities, clear=clear, warnings=warnings)

    def build_mining_outpost(self, patch_area_or_centers: Any = None, *,
                             plan: Any = None, drill: str = "electric-mining-drill",
                             drill_grid: Any = None, output: str | None = "iron-chest",
                             inserter: str = "inserter",
                             clear: bool = True) -> dict[str, Any]:
        """Plan (or accept) a mining outpost and build it in chunks."""
        if plan is not None:
            entities, warnings = self._resolve_plan(plan)
        else:
            if patch_area_or_centers is None:
                raise ValueError("build_mining_outpost needs ore tiles/area or a plan")
            outpost = plan_mining_outpost(
                patch_area_or_centers,
                drill=drill,
                drill_grid=drill_grid,
                output=output,
                inserter=inserter,
            )
            entities, warnings = outpost["entities"], outpost["warnings"]
        return self._submit_planned(entities, clear=clear, warnings=warnings)

    def build_defense_line(self, from_xy: Any = None, to_xy: Any = None, *,
                           plan: Any = None, turret: str = "gun-turret",
                           wall: str | None = "stone-wall", spacing: int = 8,
                           ammo_chest: str | None = None,
                           inserter: str = "inserter",
                           clear: bool = True) -> dict[str, Any]:
        """Plan (or accept) a defense line and build it in chunks."""
        if plan is not None:
            entities, warnings = self._resolve_plan(plan)
        else:
            if from_xy is None or to_xy is None:
                raise ValueError("build_defense_line needs from/to points or a plan")
            defense = plan_defense_line(
                from_xy,
                to_xy,
                turret=turret,
                wall=wall,
                spacing=spacing,
                ammo_chest=ammo_chest,
                inserter=inserter,
            )
            entities, warnings = defense["entities"], defense["warnings"]
        return self._submit_planned(entities, clear=clear, warnings=warnings)


    def mine(self, targets: list[dict[str, Any]], **options: Any) -> Any:
        return self.submit_action("mine", {"targets": targets}, **options)

    def mine_continuous(self, target: dict[str, Any], *, count: Any = 1,
                        resource: str | None = None, max_cycles: int = 1000,
                        **options: Any) -> dict[str, Any]:
        """Mine one target repeatedly until it depletes or ``count`` cycles finish.

        This deliberately keeps the same target across calls (the character does
        not switch ore tiles after one extraction). Use ``count="all"`` to keep
        mining until no resource is found at the target (or ``max_cycles``).
        """
        target = dict(target)
        target["kind"] = "resource"
        if resource:
            target["name"] = resource
        raw_count = "all" if isinstance(count, str) and count.lower() == "all" else int(count)
        if raw_count != "all" and raw_count < 1:
            raise ValueError("count must be >= 1 or 'all'")
        items: dict[str, int] = {}
        cycles = 0
        last: Any = None
        depleted = False
        while raw_count == "all" or cycles < raw_count:
            if cycles >= max_cycles:
                break
            job = self.mine([target], **options)
            last = job
            result = None
            data = job.get("data") if isinstance(job, dict) else None
            results = data.get("results") if isinstance(data, dict) else None
            if isinstance(results, list) and results and isinstance(results[0], dict):
                result = results[0]
            if not isinstance(result, dict) or result.get("ok") is False:
                error = result.get("error") if isinstance(result, dict) else None
                depleted = error in ("no_resource", "target_disappeared")
                break
            cycles += 1
            mined = result.get("items")
            if isinstance(mined, dict):
                for item, amount in mined.items():
                    try:
                        items[str(item)] = items.get(str(item), 0) + int(amount)
                    except (TypeError, ValueError):
                        continue
            if not result.get("mined_count"):
                depleted = True
                break
        return {
            "ok": bool(cycles > 0),
            "cycles": cycles,
            "depleted": depleted,
            "items": items,
            "last": last,
        }

    def rotate(
        self,
        targets: list[dict[str, Any]],
        direction: int | None = None,
        **options: Any,
    ) -> Any:
        """Rotate entities under the target tiles.

        Pass ``direction`` (0=north, 4=east, 8=south, 12=west) to rotate each
        entity until it faces that direction; without it a single 90-degree
        rotation is performed. The character walks into reach first, so this is
        slower than a direct RCON edit but honours native reach rules.
        """
        if direction is not None:
            if direction not in (0, 4, 8, 12):
                raise ValueError("direction must be one of 0, 4, 8, 12")
            targets = [dict(target, direction=direction) for target in targets]
        return self.submit_action("rotate", {"targets": targets}, **options)

    def move(self, targets: list[dict[str, Any]], *, max_step: float | None = None,
             **options: Any) -> Any:
        limit = max_step
        if limit is None:
            limit = float(os.environ.get("AUTORIO_MAX_MOVE_TILES", "64"))
        if limit and limit > 0 and targets:
            here = self.player_position()
            for target in targets:
                x, y = float(target.get("x")), float(target.get("y"))
                distance = math.hypot(x - here["x"], y - here["y"])
                if distance > limit:
                    ratio = limit / distance
                    wx, wy = here["x"] + (x - here["x"]) * ratio, here["y"] + (y - here["y"]) * ratio
                    raise ValueError(
                        f"move target ({x:g},{y:g}) is {distance:.0f} tiles away (limit {limit:g}); "
                        f"move in waypoints, e.g. ({wx:.0f},{wy:.0f}) first, and observe the route")
        return self.submit_action("move", {"targets": targets}, **options)

    def preview_path(self, x: float, y: float, **options: Any) -> Any:
        """Ask the native pathfinder for a route without walking (preview only)."""
        return self.submit_action("path", {"targets": [{"x": x, "y": y}]}, **options)

    def launch_rocket(self, targets: list[dict[str, Any]], **options: Any) -> Any:
        """Launch ready silos; success indicates launch initiation, not flight completion."""
        return self.submit_action("launch-rocket", {"targets": targets}, **options)

    def set_recipe(self, targets: list[dict[str, Any]], **options: Any) -> Any:
        return self.submit_action("set-recipe", {"targets": targets}, **options)

    def research(self, technology: str, **options: Any) -> Any:
        return self.submit_action("research", {"technology": technology}, **options)

    def craft(self, item: str, count: int = 1, *, wait: bool = True,
              wait_timeout: float | None = None, **options: Any) -> Any:
        before = self.inventory_counts() if wait and not options.get("detach") else {}
        job = self.submit_action("craft", {"item": item, "count": count}, **options)
        if not wait or options.get("detach") or not action_job_ok(job):
            return job
        result = (job.get("results") or [{}])[0] if isinstance(job, dict) else {}
        products = result.get("products") if isinstance(result, dict) else None
        if not isinstance(products, list) or not products:
            products = [{"name": item, "amount": 1, "type": "item"}]
        if wait_timeout is None:
            try:
                wait_timeout = max(15.0, float(result.get("energy") or 0.5) * max(1, count) * 1.5 + 15.0)
            except (TypeError, ValueError):
                wait_timeout = max(15.0, count * 1.5 + 15.0)
        deadline = time.monotonic() + wait_timeout
        while time.monotonic() < deadline:
            counts = self.inventory_counts()
            complete = True
            for product in products:
                if product.get("type", "item") == "fluid":
                    continue
                name = str(product.get("name"))
                amount = int(product.get("amount", 1)) * count
                if counts.get(name, 0) < before.get(name, 0) + amount:
                    complete = False
                    break
            if complete:
                return job
            time.sleep(max(0.25, self.poll_interval))
        raise TimeoutError(
            f"craft {item} x{count} was queued but its products did not appear within {wait_timeout:g}s")

    def insert(self, entity: dict[str, float], item: str, count: int = 1,
               **options: Any) -> Any:
        return self.submit_action("insert", {
            "entity": entity, "item": item, "count": count,
        }, **options)

    def extract(self, entity: dict[str, float], item: str,
                count: int | str = 1, **options: Any) -> Any:
        return self.submit_action("extract", {
            "entity": entity, "item": item, "count": count,
        }, **options)


def submit_action_job(base: str, action: str, payload: Any, detach: bool, idempotency_key: str | None) -> Any:
    job = http_request(
        base,
        "POST",
        "/api/agent/jobs",
        {"action": action, "payload": payload, "idempotency_key": idempotency_key},
    )
    if detach:
        return job
    job_id = job.get("job_id") if isinstance(job, dict) else None
    if not job_id:
        raise RuntimeError("Server did not return a job ID")
    while isinstance(job, dict) and job.get("status") in ("queued", "running"):
        time.sleep(POLL_INTERVAL_SECONDS)
        encoded_id = quote(str(job_id), safe="-_.!~*'()")
        job = http_request(base, "GET", f"/api/agent/jobs/{encoded_id}")
    return job


def _job_path_points(job: Any) -> list[Any]:
    """Extract the native path array from a path-preview action-job response."""
    if not isinstance(job, dict):
        return []
    for container in (job.get("results"), (job.get("data") or {}).get("results")
                      if isinstance(job.get("data"), dict) else None):
        if not isinstance(container, list):
            continue
        for result in container:
            if not isinstance(result, dict):
                continue
            path = result.get("path") or result.get("path_out")
            if isinstance(path, list) and path:
                return path
    return []


def action_job_ok(job: Any) -> bool:
    if not isinstance(job, dict):
        return False
    if job.get("status") in ("failed", "cancelled"):
        return False
    if job.get("status") in ("queued", "running"):
        return True
    results = job.get("results")
    return isinstance(results, list) and bool(results) and all(
        isinstance(result, dict) and result.get("ok") is not False for result in results
    )


def parse_json_if_string(value: Any) -> Any:
    if not isinstance(value, str):
        return value
    try:
        return json.loads(value)
    except json.JSONDecodeError:
        return value


def data_value(response: Any) -> Any:
    if isinstance(response, dict) and response.get("data") is not None:
        return response["data"]
    return response


def _job_first_result(job: Any) -> dict[str, Any] | None:
    """Return the first per-target result from an action-job response."""
    if not isinstance(job, dict):
        return None
    data = job.get("data")
    results = data.get("results") if isinstance(data, dict) else None
    if not isinstance(results, list) and isinstance(job.get("results"), list):
        results = job["results"]
    if isinstance(results, list) and results and isinstance(results[0], dict):
        return results[0]
    return None


def _observation_inventory_items(observation: Any) -> list[dict[str, Any]]:
    """Flatten inventories from an observe-entity result into slot entries."""
    data = data_value(observation)
    if not isinstance(data, dict):
        return []
    results = data.get("results") if isinstance(data.get("results"), list) else []
    first = results[0] if results and isinstance(results[0], dict) else {}
    inventories = first.get("inventories") if isinstance(first.get("inventories"), list) else []
    items: list[dict[str, Any]] = []
    for inventory in inventories:
        if not isinstance(inventory, dict):
            continue
        for item in inventory.get("items") if isinstance(inventory.get("items"), list) else []:
            if isinstance(item, dict) and isinstance(item.get("name"), str):
                items.append(item)
    return items


def write_response(*, ok: bool, cmd: str, started: float, data: Any = MISSING,
                   error: str | None = None, truncated: Any = MISSING) -> None:
    response: dict[str, Any] = {"ok": ok, "cmd": cmd}
    if data is not MISSING:
        response["data"] = data
    if error is not None:
        response["error"] = error
    if truncated is not MISSING:
        response["truncated"] = truncated
    print(json.dumps(response, separators=(",", ":"), ensure_ascii=False))


def run(argv: list[str]) -> int:
    started = time.monotonic()
    parsed = parse_args(argv)
    if not parsed.command:
        sys.stderr.write(GLOBAL_USAGE)
        return 1
    if parsed.command == "help":
        command = parsed.positionals[0] if parsed.positionals else None
        sys.stderr.write(COMMAND_USAGE.get(command, GLOBAL_USAGE))
        return 0

    cmd = parsed.command
    flag = lambda name: get_flag(parsed.flags, name)
    flags = parsed.flags

    def request(method: str, path: str, body: Any = None) -> Any:
        return http_request(parsed.base, method, path, body)

    def submit(action: str, payload: Any) -> Any:
        return submit_action_job(
            parsed.base,
            action,
            payload,
            detach=bool(flag("detach")),
            idempotency_key=flag("idempotency-key"),
        )

    def output(data: Any, *, ok: bool = True, truncated: Any = MISSING) -> int:
        write_response(ok=ok, cmd=cmd, data=data, truncated=truncated, started=started)
        return 0 if ok else 1

    try:
        if cmd == "server-status":
            return output(request("GET", "/api/server/status"))
        if cmd == "server-start":
            save = flag("save")
            if not save:
                raise ValueError("Missing --save")
            return output(request("POST", "/api/server/start", {"save": save}))
        if cmd == "server-stop":
            return output(request("POST", "/api/server/stop"))
        if cmd == "server-saves":
            return output(request("GET", "/api/saves"))

        if cmd == "observe-world":
            include = [part.strip() for part in (flag("include") or "").split(",") if part.strip()]
            response = request("POST", "/api/agent/observe/world", {
                "window": {
                    "x": parse_number(flag("window-x"), 0),
                    "y": parse_number(flag("window-y"), 0),
                    "radius": parse_number(flag("radius"), 12),
                },
                "include": include or ["terrain", "entities"],
            })
            truncated = response["truncated"] if isinstance(response, dict) and "truncated" in response else MISSING
            return output(data_value(response), truncated=truncated)
        if cmd == "observe-map-overview":
            response = FactorioClient(parsed.base).observe_map_overview(
                x=parse_number(flag("center-x"), 0),
                y=parse_number(flag("center-y"), 0),
                radius=parse_number(flag("radius"), 128),
                size=parse_number(flag("size"), 96),
                format=flag("format"),
            )
            return output(data_value(response))
        if cmd == "observe-map":
            response = request("POST", "/api/agent/observe/map", {"window": {
                "x": parse_number(flag("center-x"), 0),
                "y": parse_number(flag("center-y"), 0),
                "radius": parse_number(flag("radius"), 48),
            }})
            return output(data_value(response))
        if cmd == "observe-player":
            response = request("POST", "/api/agent/observe/player", {"limits": {
                "inventory_slots": parse_number(flag("limit-inventory")),
                "equipment_slots": parse_number(flag("limit-equipment")),
            }})
            truncated = response["truncated"] if isinstance(response, dict) and "truncated" in response else MISSING
            return output(data_value(response), truncated=truncated)
        if cmd == "observe-research":
            response = request("POST", "/api/agent/observe/research", {"limits": {
                "available": parse_number(flag("limit-available")),
                "locked": parse_number(flag("limit-locked")),
                "completed": parse_number(flag("limit-completed")),
            }})
            truncated = response["truncated"] if isinstance(response, dict) and "truncated" in response else MISSING
            return output(data_value(response), truncated=truncated)
        if cmd == "observe-recipes":
            response = request("POST", "/api/agent/observe/recipes", {
                "limits": {"recipes": parse_number(flag("limit-recipes"))},
                "filters": {"unlocked": True} if flag("unlocked-only") else None,
            })
            truncated = response["truncated"] if isinstance(response, dict) and "truncated" in response else MISSING
            return output(parse_json_if_string(data_value(response)), truncated=truncated)
        if cmd == "observe-entity":
            targets = json.loads(flag("targets-json")) if flag("targets-json") else parse_targets(flags.get("target", []), False)
            response = request("POST", "/api/agent/observe/entity", {"targets": targets})
            truncated = response["truncated"] if isinstance(response, dict) and "truncated" in response else MISSING
            return output(data_value(response), truncated=truncated)
        if cmd == "observe-resources":
            response = request("POST", "/api/agent/observe/resources", {"window": {
                "x": parse_number(flag("window-x"), 0),
                "y": parse_number(flag("window-y"), 0),
                "radius": parse_number(flag("radius"), 50),
            }})
            return output(data_value(response))
        if cmd == "blueprint-capture":
            result = data_value(FactorioClient(parsed.base).capture_blueprint(
                x=parse_number(flag("center-x"), 0) or 0,
                y=parse_number(flag("center-y"), 0) or 0,
                radius=parse_number(flag("radius"), 80) or 80,
                label=flag("label"),
                description=flag("description"),
            ))
            return output(result, ok=True)
        if cmd == "map-preview-exchange":
            string_file = flag("string-file")
            map_string = flag("string")
            if string_file:
                try:
                    with open(string_file, "r", encoding="utf-8") as handle:
                        map_string = handle.read()
                except OSError as error:
                    raise ValueError(f"Cannot read {string_file!r}: {error}") from error
            if not map_string:
                raise ValueError("Missing --string-file or --string")
            size_value = int(flag("size") or "1024")
            planets_value = flag("planets")
            planets = [entry.strip() for entry in planets_value.split(",") if entry.strip()] if planets_value else None
            result = FactorioClient(parsed.base).map_preview_exchange(
                map_string.strip(), size=size_value, planets=planets)
            return output(result, ok=bool(result.get("ok")))
        if cmd == "blueprint-gamedata":
            result = FactorioClient(parsed.base).generate_blueprint_gamedata(flag("dump-file"))
            return output(result, ok=True)
        if cmd in ("blueprint-analyze", "blueprint-diff"):
            def read_bp(file_flag: str, string_flag: str, id_flag: str) -> Any:
                file_value = flag(file_flag)
                if file_value:
                    try:
                        with open(file_value, "r", encoding="utf-8") as handle:
                            return handle.read()
                    except OSError as error:
                        raise ValueError(f"Cannot read {file_value!r}: {error}") from error
                return flag(string_flag) or None
            if cmd == "blueprint-analyze":
                bp = read_bp("blueprint-file", "blueprint", "id")
                if not bp and not flag("id"):
                    raise ValueError("Missing --blueprint-file, --blueprint or --id")
                result = FactorioClient(parsed.base).analyze_blueprint(
                    blueprint=bp, blueprint_id=flag("id"))
                return output(result, ok=True)
            before_value = read_bp("before-file", "before", "before-id")
            after_value = read_bp("after-file", "after", "after-id")
            if not (before_value or flag("before-id")) or not (after_value or flag("after-id")):
                raise ValueError("Missing before/after blueprint or id")
            result = FactorioClient(parsed.base).diff_blueprint(
                before=before_value, after=after_value,
                before_id=flag("before-id"), after_id=flag("after-id"))
            return output(result, ok=bool(result.get("ok")))
        if cmd == "blueprint-evaluate":
            blueprint_file = flag("blueprint-file")
            blueprint_string = flag("blueprint")
            if blueprint_file:
                try:
                    with open(blueprint_file, "r", encoding="utf-8") as handle:
                        blueprint_string = handle.read()
                except OSError as error:
                    raise ValueError(
                        f"Cannot read --blueprint-file {blueprint_file!r}: {error}") from error
            outputs: dict[str, float] = {}
            for entry in flags.get("output", []):
                item, _, rate = entry.partition("=")
                if not item or _ == "":
                    raise ValueError(f"Invalid --output '{entry}'; use item=rate")
                parsed_rate = parse_number(rate, None)
                if parsed_rate is None:
                    raise ValueError(f"Invalid --output rate '{entry}'")
                outputs[item.strip()] = float(parsed_rate)
            result = data_value(FactorioClient(parsed.base).evaluate_blueprint(
                blueprint=blueprint_string,
                blueprint_id=flag("id"),
                outputs=outputs,
                power_kw=parse_number(flag("power-kw"), None),
                build_seconds=parse_number(flag("build-seconds"), None),
            ))
            return output(result, ok=True)
        if cmd == "blueprint-list":
            response = FactorioClient(parsed.base).list_blueprints(flag("run-id"))
            return output(data_value(response))
        if cmd == "blueprint-save":
            blueprint_file = flag("blueprint-file")
            blueprint_string = flag("blueprint")
            if blueprint_file:
                try:
                    with open(blueprint_file, "r", encoding="utf-8") as handle:
                        blueprint_text = handle.read()
                except OSError as error:
                    raise ValueError(
                        f"Cannot read --blueprint-file {blueprint_file!r}: {error}") from error
            elif blueprint_string is not None:
                blueprint_text = blueprint_string
            else:
                raise ValueError("Missing --blueprint or --blueprint-file")
            response = FactorioClient(parsed.base).save_blueprint(
                blueprint_text,
                label=flag("label"),
                description=flag("description"),
                source=flag("source") or "saved",
                run_id=flag("run-id"),
            )
            return output(data_value(response))
        if cmd == "tools":
            response = FactorioClient(parsed.base).tools(
                query=flag("query"), local=bool(flag("local")))
            return output(data_value(response), truncated=MISSING)
        if cmd == "state-show":
            return output(data_value(request("GET", "/api/agent/state")))
        if cmd == "state-write":
            current = flag("current")
            if not current:
                raise ValueError("Missing --current")
            body: dict[str, Any] = {"current": current}
            for key in ("done-when", "next", "objective", "timebox", "progress", "notes", "markdown"):
                value = flag(key)
                if value is not None:
                    body[key.replace("-", "_")] = value
            scores_raw = flag("scores")
            if scores_raw:
                scores: dict[str, int] = {}
                for part in scores_raw.split(","):
                    piece = part.strip()
                    if not piece:
                        continue
                    key, _, value = piece.partition("=")
                    if not key or not value:
                        raise ValueError(f"Invalid --scores entry '{piece}' (use key=value)")
                    scores[key.strip()] = int(parse_number(value, 0) or 0)
                body["scores"] = scores
            return output(data_value(request("POST", "/api/agent/state", body)))
        if cmd == "observe-factory":
            window = {"radius": parse_number(flag("radius"), 120)}
            if parse_number(flag("center-x")) is not None:
                window["x"] = parse_number(flag("center-x"))
            if parse_number(flag("center-y")) is not None:
                window["y"] = parse_number(flag("center-y"))
            response = request("POST", "/api/agent/observe/factory", {"window": window})
            return output(data_value(response))
        if cmd == "observe-connections":
            window = {"radius": parse_number(flag("radius"), 120)}
            if parse_number(flag("center-x")) is not None:
                window["x"] = parse_number(flag("center-x"))
            if parse_number(flag("center-y")) is not None:
                window["y"] = parse_number(flag("center-y"))
            return output(data_value(request("POST", "/api/agent/observe/connections", {"window": window})))
        if cmd == "observe-layout":
            window = {"radius": parse_number(flag("radius"), 35), "step": parse_number(flag("step"), 1)}
            if parse_number(flag("center-x")) is not None:
                window["x"] = parse_number(flag("center-x"))
            if parse_number(flag("center-y")) is not None:
                window["y"] = parse_number(flag("center-y"))
            return output(data_value(request("POST", "/api/agent/observe/layout", {"window": window})))
        if cmd == "alerts":
            client = FactorioClient(parsed.base)
            result = client.ack_alerts() if flag("ack") else client.alerts()
            return output(data_value(result))
        if cmd == "knowledge":
            return output(data_value(FactorioClient(parsed.base).knowledge(flag("topic"))))
        if cmd == "entity-usage-catalog":
            return output(data_value(FactorioClient(parsed.base).entity_usage_catalog()))
        if cmd == "entity-usage":
            name = flag("name")
            if not name:
                raise ValueError("Missing --name")
            return output(data_value(FactorioClient(parsed.base).entity_usage(name)))
        if cmd == "describe":
            name = flag("name")
            kind = flag("kind") or "entity"
            if not name:
                raise ValueError("Missing --name")
            if kind not in ("entity", "technology"):
                raise ValueError("--kind must be entity or technology")
            response = FactorioClient(parsed.base).describe(name, kind=kind)
            return output(data_value(response))
        if cmd == "observe-entity-prototype":
            name = flag("name")
            if not name:
                raise ValueError("Missing --name")
            return output(data_value(request("POST", "/api/agent/observe/entity-prototype", {"name": name})))
        if cmd == "observe-placement":
            placements = (
                normalize_build_entities(json.loads(flag("entities-json")))
                if flag("entities-json") else parse_entities(flags.get("entity", []))
            )
            response = request("POST", "/api/agent/observe/placement", {"placements": placements})
            truncated = response["truncated"] if isinstance(response, dict) and "truncated" in response else MISSING
            return output(data_value(response), truncated=truncated)
        if cmd == "observe-production":
            return output(data_value(request("POST", "/api/agent/observe/production", {})))
        if cmd == "observe-fluids":
            return output(data_value(request("POST", "/api/agent/observe/fluids", {
                "x": parse_number(flag("center-x")),
                "y": parse_number(flag("center-y")),
                "radius": parse_number(flag("radius"), 32),
            })))
        if cmd == "observe-combat":
            return output(data_value(request("POST", "/api/agent/observe/combat", {
                "x": parse_number(flag("center-x")),
                "y": parse_number(flag("center-y")),
                "radius": parse_number(flag("radius"), 64),
            })))
        if cmd == "observe-area":
            types = [part.strip() for part in (flag("types") or "").split(",") if part.strip()]
            filters = [part.strip() for part in (flag("filters") or "").split(",") if part.strip()]
            response = request("POST", "/api/agent/observe/area", {
                "window": {
                    "x": parse_number(flag("center-x"), 0),
                    "y": parse_number(flag("center-y"), 0),
                    "radius": parse_number(flag("radius"), 64),
                },
                "limit": parse_number(flag("limit")),
                "types": types or None,
                "filters": filters or None,
                "player_only": bool(flag("player-only")),
                "order": flag("order") or "name",
            })
            truncated = response["truncated"] if isinstance(response, dict) and "truncated" in response else MISSING
            return output(data_value(response), truncated=truncated)
        if cmd == "observe-snapshot":
            snapshot = FactorioClient(parsed.base).observe_snapshot(
                x=parse_number(flag("center-x")),
                y=parse_number(flag("center-y")),
                radius=parse_number(flag("radius"), 64),
            )
            return output(snapshot, ok=bool(snapshot.get("ok", True)))
        if cmd == "observe-copy-settings":
            targets = (json.loads(flag("targets-json")) if flag("targets-json")
                       else parse_copy_targets(flags.get("target", [])))
            if not targets:
                raise ValueError("Missing --target or --targets-json")
            response = FactorioClient(parsed.base).copy_settings_check(targets)
            result = data_value(response)
            return output(result, ok=bool(result.get("ok", True)) if isinstance(result, dict) else True)
        if cmd == "deconstruct-area":
            area_types = [part.strip() for part in (flag("types") or "").split(",") if part.strip()]
            area_filters = [part.strip() for part in (flag("filters") or "").split(",") if part.strip()]
            deconstruct_result = FactorioClient(parsed.base).deconstruct_area(
                parse_number(flag("center-x")),
                parse_number(flag("center-y")),
                parse_number(flag("radius"), 64),
                limit=parse_number(flag("limit")),
                types=area_types or None,
                filters=area_filters or None,
                player_only=not bool(flag("include-all")),
                max_per_job=parse_number(flag("max-per-job"), 50),
                order=flag("order") or "nearest",
                start_xy=parse_targets([flag("start")], False)[0] if flag("start") else None,
                max_distance=parse_number(flag("max-distance"), None),
                scope=[part.strip() for part in (flag("scope") or "").split(",") if part.strip()] or None,
                dry_run=bool(flag("dry-run")),
            )
            return output(deconstruct_result,
                          ok=bool(deconstruct_result.get("ok", True)))

        if cmd == "act-build":
            entities = (
                normalize_build_entities(json.loads(flag("entities-json")))
                if flag("entities-json") else parse_entities(flags.get("entity", []))
            )
            job = submit("build", {"entities": entities, "clear_obstacles": not bool(flag("no-clear"))})
        elif cmd == "act-build-belt":
            start_value, end_value = flag("from"), flag("to")
            if not start_value or not end_value:
                raise ValueError("Missing --from or --to")
            start = parse_targets([start_value], False)[0]
            end = parse_targets([end_value], False)[0]
            belt_plan = belt_line_entities(start, end, flag("name") or "transport-belt")
            _assert_valid_belt_plan(belt_plan, from_xy=start, to_xy=end)
            job = submit("build", {"entities": belt_plan,
                                   "clear_obstacles": not bool(flag("no-clear"))})
        elif cmd == "act-build-loader":
            start_value, end_value = flag("from"), flag("to")
            if not start_value or not end_value:
                raise ValueError("Missing --from or --to")
            start = parse_targets([start_value], False)[0]
            end = parse_targets([end_value], False)[0]
            job = submit("build", {"entities": [loader_entity(start, end, flag("name") or "inserter")],
                                   "clear_obstacles": not bool(flag("no-clear"))})
        elif cmd == "act-build-blueprint":
            blueprint_file = flag("blueprint-file")
            blueprint_string = flag("blueprint")
            if blueprint_file:
                try:
                    with open(blueprint_file, "r", encoding="utf-8") as handle:
                        blueprint_text = handle.read()
                except OSError as error:
                    raise ValueError(
                        f"Cannot read --blueprint-file {blueprint_file!r}: {error}") from error
            elif blueprint_string is not None:
                blueprint_text = blueprint_string
            else:
                raise ValueError("Missing --blueprint or --blueprint-file")
            anchor_value = flag("anchor")
            anchor: dict[str, Any] | None = None
            if anchor_value:
                parts = [part.strip() for part in anchor_value.split(",")]
                if len(parts) != 2:
                    raise ValueError("Invalid --anchor, expected x,y")
                anchor_x, anchor_y = parse_number(parts[0], None), parse_number(parts[1], None)
                if anchor_x is None or anchor_y is None:
                    raise ValueError("Invalid --anchor, expected x,y")
                anchor = {"x": anchor_x, "y": anchor_y}
            blueprint_result = FactorioClient(parsed.base).build_blueprint(
                blueprint_text,
                anchor=anchor,
                dry_run=bool(flag("dry-run")),
                clear=not bool(flag("no-clear")),
            )
            return output(blueprint_result, ok=bool(blueprint_result.get("ok", True)))
        elif cmd == "act-copy-settings":
            targets = (json.loads(flag("targets-json")) if flag("targets-json")
                       else parse_copy_targets(flags.get("target", [])))
            if not targets:
                raise ValueError("Missing --target or --targets-json")
            response = FactorioClient(parsed.base).copy_settings(
                targets, dry_run=bool(flag("dry-run")))
            result = data_value(response)
            return output(result, ok=bool(result.get("ok", True)) if isinstance(result, dict) else True)
        elif cmd == "build-pipe-line":
            from_value, to_value = flag("from"), flag("to")
            if not from_value or not to_value:
                raise ValueError("Missing --from or --to")
            planner_result = FactorioClient(parsed.base).build_pipe_line(
                parse_targets([from_value], False)[0],
                parse_targets([to_value], False)[0],
                name=flag("name") or "pipe",
                clear=not bool(flag("no-clear")),
            )
            return output(planner_result, ok=bool(planner_result.get("ok", True)))
        elif cmd == "build-underground-belt":
            from_value, to_value = flag("from"), flag("to")
            if not from_value or not to_value:
                raise ValueError("Missing --from or --to")
            planner_result = FactorioClient(parsed.base).build_underground_belt_line(
                parse_targets([from_value], False)[0],
                parse_targets([to_value], False)[0],
                name=flag("name") or "transport-belt",
                max_distance=parse_number(flag("max-distance")),
                clear=not bool(flag("no-clear")),
            )
            return output(planner_result, ok=bool(planner_result.get("ok", True)))
        elif cmd == "build-underground-pipe":
            from_value, to_value = flag("from"), flag("to")
            if not from_value or not to_value:
                raise ValueError("Missing --from or --to")
            planner_result = FactorioClient(parsed.base).build_underground_pipe_line(
                parse_targets([from_value], False)[0],
                parse_targets([to_value], False)[0],
                max_distance=parse_number(flag("max-distance"), UNDERGROUND_PIPE_DEFAULT_DISTANCE),
                clear=not bool(flag("no-clear")),
            )
            return output(planner_result, ok=bool(planner_result.get("ok", True)))
        elif cmd == "build-power-line":
            from_value, to_value = flag("from"), flag("to")
            if not from_value or not to_value:
                raise ValueError("Missing --from or --to")
            planner_result = FactorioClient(parsed.base).build_power_line(
                parse_targets([from_value], False)[0],
                parse_targets([to_value], False)[0],
                pole=flag("pole") or "big-electric-pole",
                spacing=parse_number(flag("spacing"), None),
                clear=not bool(flag("no-clear")),
            )
            return output(planner_result, ok=bool(planner_result.get("ok", True)))
        elif cmd == "relayout-belts":
            result = FactorioClient(parsed.base).relayout_belts(
                parse_number(flag("center-x"), 0) or 0,
                parse_number(flag("center-y"), 0) or 0,
                parse_number(flag("radius"), 80) or 80,
                dry_run=bool(flag("dry-run")),
            )
            return output(result, ok=bool(result.get("ok", True)))
        elif cmd == "build-line":
            from_value, to_value = flag("from"), flag("to")
            if not from_value or not to_value:
                raise ValueError("Missing --from or --to")
            kind = flag("kind")
            if not kind:
                raise ValueError("Missing --kind")
            planner_result = FactorioClient(parsed.base).build_line(
                kind,
                parse_targets([from_value], False)[0],
                parse_targets([to_value], False)[0],
                name=flag("name"),
                route=flag("route") or "auto",
                spacing=parse_number(flag("spacing"), None),
                underground=not bool(flag("surface-pipes")),
                clear=not bool(flag("no-clear")),
            )
            return output(planner_result, ok=bool(planner_result.get("ok", True)))
        elif cmd == "build-pipe-route":
            from_value, to_value = flag("from"), flag("to")
            if not from_value or not to_value:
                raise ValueError("Missing --from or --to")
            planner_result = FactorioClient(parsed.base).build_pipe_route(
                parse_targets([from_value], False)[0],
                parse_targets([to_value], False)[0],
                name=flag("name") or "pipe",
                underground=not bool(flag("surface-pipes")),
                clear=not bool(flag("no-clear")),
            )
            return output(planner_result, ok=bool(planner_result.get("ok", True)))
        elif cmd == "build-power-network":
            if flag("area"):
                power_targets: Any = _parse_area_flag(flag("area"))
            else:
                power_targets = _parse_sized_points(flags.get("target", []), "--target")
                if not power_targets:
                    raise ValueError("Missing --target or --area")
            planner_result = FactorioClient(parsed.base).build_power_network(
                power_targets,
                pole=flag("pole") or "small-electric-pole",
                big_pole_every=parse_number(flag("big-pole-every"), 0),
                clear=not bool(flag("no-clear")),
            )
            return output(planner_result, ok=bool(planner_result.get("ok", True)))
        elif cmd == "build-inserter-pairs":
            machines = (json.loads(flag("entities-json")) if flag("entities-json")
                        else _parse_sized_points(flags.get("entity", []), "--entity"))
            if not machines:
                raise ValueError("Missing --entity or --entities-json")
            planner_result = FactorioClient(parsed.base).build_inserter_pairs(
                machines,
                direction=flag("direction") or "east",
                inserter=flag("name") or "inserter",
                clear=not bool(flag("no-clear")),
            )
            return output(planner_result, ok=bool(planner_result.get("ok", True)))
        elif cmd == "build-mining-outpost":
            if flag("area"):
                ore_source: Any = _parse_area_flag(flag("area"))
            else:
                ore_source = parse_targets(flags.get("ore", []), False)
                if not ore_source:
                    raise ValueError("Missing --ore or --area")
            drill_grid = None
            drill_size_value = flag("drill-size")
            if drill_size_value:
                size_parts = [part.strip() for part in drill_size_value.split(",")]
                if len(size_parts) != 2:
                    raise ValueError("Invalid --drill-size, expected width,height")
                drill_width = parse_number(size_parts[0], None)
                drill_height = parse_number(size_parts[1], None)
                if drill_width is None or drill_height is None:
                    raise ValueError("Invalid --drill-size, expected width,height")
                drill_grid = (drill_width, drill_height)
            planner_result = FactorioClient(parsed.base).build_mining_outpost(
                ore_source,
                drill=flag("drill") or "electric-mining-drill",
                drill_grid=drill_grid,
                output=flag("output") or "iron-chest",
                clear=not bool(flag("no-clear")),
            )
            return output(planner_result, ok=bool(planner_result.get("ok", True)))
        elif cmd == "build-defense-line":
            from_value, to_value = flag("from"), flag("to")
            if not from_value or not to_value:
                raise ValueError("Missing --from or --to")
            wall: str | None = None if flag("no-wall") else (flag("wall") or "stone-wall")
            planner_result = FactorioClient(parsed.base).build_defense_line(
                parse_targets([from_value], False)[0],
                parse_targets([to_value], False)[0],
                turret=flag("turret") or "gun-turret",
                wall=wall,
                spacing=parse_number(flag("spacing"), 8),
                ammo_chest=flag("ammo-chest"),
                clear=not bool(flag("no-clear")),
            )
            return output(planner_result, ok=bool(planner_result.get("ok", True)))
        elif cmd == "path-preview":
            targets = json.loads(flag("targets-json")) if flag("targets-json") else parse_targets(flags.get("target", []), False)
            if not targets:
                raise ValueError("Missing --target")
            job = submit("path", {"targets": targets[:1]})
        elif cmd == "unstick":
            result = FactorioClient(parsed.base).unstick(
                max_removals=parse_number(flag("max-removals"), 8) or 8)
            return output(result, ok=bool(result.get("ok")))
        elif cmd in ("act-mine", "act-rotate", "act-move", "act-set-recipe", "act-launch-rocket"):
            require_recipe = cmd == "act-set-recipe"
            targets = json.loads(flag("targets-json")) if flag("targets-json") else parse_targets(flags.get("target", []), require_recipe)
            if cmd == "act-rotate" and flag("direction") is not None:
                rotate_direction = parse_number(flag("direction"), None)
                if rotate_direction not in (0, 4, 8, 12):
                    raise ValueError("--direction must be one of 0, 4, 8, 12")
                targets = [dict(target, direction=rotate_direction) for target in targets]
            resource = flag("resource") if cmd == "act-mine" else None
            if cmd == "act-mine" and resource:
                targets = [dict(target, kind="resource", **({} if resource == "true" else {"name": resource})) for target in targets]
            if cmd == "act-mine" and flag("allow-buildings"):
                targets = [dict(target, allow_buildings=True) for target in targets]
            if cmd == "act-mine" and resource:
                raw_count: Any = flag("count")
                mine_count: Any = "all" if raw_count is None or str(raw_count).lower() == "all" else parse_number(raw_count, 1)
                if len(targets) != 1:
                    raise ValueError("resource mining needs exactly one --target; mine one vein to depletion before switching")
                result = FactorioClient(parsed.base).mine_continuous(
                    targets[0], count=mine_count,
                    resource=None if resource in (None, "true") else resource,
                )
                return output(result, ok=bool(result.get("ok")))
            action = {"act-mine": "mine", "act-rotate": "rotate", "act-move": "move", "act-set-recipe": "set-recipe", "act-launch-rocket": "launch-rocket"}[cmd]
            job = submit(action, {"targets": targets})
        elif cmd == "act-research":
            technology = flag("technology")
            if not technology:
                raise ValueError("Missing --technology")
            job = submit("research", {"technology": technology})
        elif cmd == "act-craft":
            item = flag("item")
            if not item:
                raise ValueError("Missing --item")
            waiter = FactorioClient(parsed.base)
            job = waiter.craft(item, parse_number(flag("count"), 1),
                               wait=not bool(flag("no-wait") or flag("detach")),
                               detach=bool(flag("detach")),
                               idempotency_key=flag("idempotency-key"))
        elif cmd in ("act-insert", "act-extract"):
            entity_value = flag("entity")
            item = flag("item")
            if not entity_value:
                raise ValueError("Missing --entity")
            if not item:
                raise ValueError("Missing --item")
            target = parse_targets([entity_value], False)[0]
            raw_count = flag("count")
            count: Any = "all" if cmd == "act-extract" and raw_count == "all" else parse_number(raw_count, 1)
            job = submit(cmd.removeprefix("act-"), {"entity": target, "item": item, "count": count})
        elif cmd == "observe-free-space":
            result = data_value(FactorioClient(parsed.base).observe_free_space(
                x=parse_number(flag("center-x"), None),
                y=parse_number(flag("center-y"), None),
                radius=parse_number(flag("radius"), 60) or 60,
                step=parse_number(flag("step"), 1) or 1,
            ))
            return output(result, ok=True)
        elif cmd == "geometry-check":
            check_entities = (
                normalize_build_entities(json.loads(flag("entities-json")))
                if flag("entities-json") else parse_entities(flags.get("entity", []))
            )
            result = FactorioClient(parsed.base).geometry_check(check_entities)
            return output(result, ok=bool(result.get("ok")))
        elif cmd == "plan-route":
            from_value, to_value = flag("from"), flag("to")
            if not from_value or not to_value:
                raise ValueError("Missing --from or --to")
            start = parse_targets([from_value], False)[0]
            end = parse_targets([to_value], False)[0]
            result = FactorioClient(parsed.base).plan_route(
                start, end,
                kind=flag("kind") or "belt",
                width=parse_number(flag("width"), 1) or 1,
                spacing=parse_number(flag("spacing"), None),
                radius=parse_number(flag("radius"), None),
            )
            return output(result, ok=bool(result.get("ok")))
        elif cmd == "observe-pipeline":
            result = data_value(FactorioClient(parsed.base).observe_pipeline(
                x=parse_number(flag("center-x"), None),
                y=parse_number(flag("center-y"), None),
                radius=parse_number(flag("radius"), 80) or 80,
            ))
            return output(result, ok=True)
        elif cmd == "pipeline-audit":
            result = FactorioClient(parsed.base).pipeline_audit(
                x=parse_number(flag("center-x"), None),
                y=parse_number(flag("center-y"), None),
                radius=parse_number(flag("radius"), 80) or 80,
            )
            return output(result, ok=True)
        elif cmd == "factory-audit":
            audit_scope = [part.strip() for part in (flag("scope") or "").split(",") if part.strip()]
            result = data_value(FactorioClient(parsed.base).factory_audit(
                x=parse_number(flag("center-x"), None),
                y=parse_number(flag("center-y"), None),
                radius=parse_number(flag("radius"), 120) or 120,
                scope=audit_scope or None,
                include_rail=bool(flag("include-rail")),
            ))
            return output(result, ok=True)
        elif cmd in ("belt-contents", "fluid-contents"):
            target = parse_targets([flag("target") or ""], False)[0] if flag("target") else None
            if not target:
                raise ValueError("Missing --target")
            client = FactorioClient(parsed.base)
            result = (client.belt_contents(target["x"], target["y"])
                      if cmd == "belt-contents"
                      else client.fluid_contents(target["x"], target["y"]))
            return output(result, ok=bool(result.get("ok")))
        elif cmd == "observe-container":
            target = parse_targets([flag("target") or ""], False)[0] if flag("target") else None
            if not target:
                raise ValueError("Missing --target")
            return output(FactorioClient(parsed.base).container_contents(target["x"], target["y"]))
        elif cmd == "container-transfer":
            from_value, to_value = flag("from"), flag("to")
            if not from_value or not to_value:
                raise ValueError("Missing --from or --to")
            raw_count = flag("count")
            count: Any = None if raw_count is None or raw_count == "all" else parse_number(raw_count, None)
            result = FactorioClient(parsed.base).container_transfer(
                parse_targets([from_value], False)[0], parse_targets([to_value], False)[0],
                item=flag("item"), count=count,
            )
            return output(result, ok=bool(result.get("ok")))
        elif cmd == "recover-debris":
            result = FactorioClient(parsed.base).recover_debris(
                x=parse_number(flag("center-x"), 0) or 0,
                y=parse_number(flag("center-y"), 0) or 0,
                radius=parse_number(flag("radius"), 64) or 64,
            )
            return output(result, ok=bool(result.get("ok")))
        elif cmd == "wait":
            raise ValueError(
                "wait is disabled: do not idle. Pick the next useful task (add drills/furnaces, "
                "fix power/fuel, stock inputs, set recipes, expand belts, or craft intermediates)."
            )
        elif cmd == "wait-for-item":
            item = flag("item")
            if not item:
                raise ValueError("Missing --item")
            waiter = FactorioClient(parsed.base)
            counts = waiter.wait_for_item(item, parse_number(flag("count"), 1), timeout=parse_number(flag("timeout"), 300))
            return output({"item": item, "count": counts.get(item, 0)})
        elif cmd == "wait-for-research":
            technology = flag("technology")
            if not technology:
                raise ValueError("Missing --technology")
            FactorioClient(parsed.base).wait_for_research(technology, timeout=parse_number(flag("timeout"), 600))
            return output({"technology": technology, "completed": True})
        elif cmd == "job-status":
            job_id = flag("job-id")
            if not job_id:
                raise ValueError("Missing --job-id")
            encoded_id = quote(job_id, safe="-_.!~*'()")
            job = request("GET", f"/api/agent/jobs/{encoded_id}")
        elif cmd == "job-cancel":
            job_id = flag("job-id")
            if not job_id:
                raise ValueError("Missing --job-id")
            encoded_id = quote(job_id, safe="-_.!~*'()")
            return output(request("POST", f"/api/agent/jobs/{encoded_id}/cancel"))
        else:
            raise ValueError(f"Unknown command '{cmd}'")

        return output(job, ok=action_job_ok(job))
    except Exception as error:  # Keep failures machine-readable like the TypeScript CLI.
        write_response(ok=False, cmd=cmd, error=str(error) or "Command failed", started=started)
        return 1


def main() -> None:
    raise SystemExit(run(sys.argv[1:]))


if __name__ == "__main__":
    main()
