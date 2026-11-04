#!/usr/bin/env python3
"""Python client for the autorio Factorio JSON API.

Provides both an importable client and a command-line interface for agents.
"""

from __future__ import annotations

import base64
import json
import math
import os
import sys
import time
import zlib
from dataclasses import dataclass, field
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
    "parse_entities",
    "parse_targets",
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
  observe-player --limit-inventory <n> --limit-equipment <n>
  observe-research --limit-available <n> --limit-locked <n> --limit-completed <n>
  observe-recipes --limit-recipes <n> [--unlocked-only]
  observe-entity --target x,y [--target ...] [--targets-json <json>]
  observe-resources --window-x <n> --window-y <n> --radius <n>
  observe-factory --center-x <n> --center-y <n> --radius <n>
  observe-layout --center-x <n> --center-y <n> --radius <n> --step <n>
  observe-connections --center-x <n> --center-y <n> --radius <n>
  observe-entity-prototype --name <entity-name>
  observe-placement --entity name,anchor-x,anchor-y,dir [--entity ...]
  act-build --entity name,anchor-x,anchor-y,dir [--entity ...] [--no-clear]
  act-build-belt --from x,y --to x,y [--name transport-belt] [--no-clear]
  act-build-loader --from x,y --to x,y [--name inserter] [--no-clear]
  act-build-blueprint (--blueprint-file <path>|--blueprint <string>) [--anchor x,y] [--dry-run] [--no-clear]
  act-mine --target x,y [--target ...] [--resource [name]] [--targets-json <json>]
  act-rotate --target x,y [--target ...] [--targets-json <json>]
  act-move --target x,y [--target ...] [--targets-json <json>]
  act-launch-rocket --target x,y [--target ...] [--targets-json <json>]
  act-set-recipe --target x,y,recipe [--target ...] [--targets-json <json>]
  act-research --technology <name>
  act-craft --item <name> --count <n> [--no-wait]
  act-insert --entity x,y --item <name> --count <n>
  act-extract --entity x,y --item <name> --count <n|all>
  wait --ms <n>
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
    "observe-player": "observe-player: Inspect player position, health, inventories, and equipment.\nUsage: factorio.py observe-player --limit-inventory <n> --limit-equipment <n>\n",
    "observe-research": "observe-research: Get current, queued, available, locked, and completed technologies with costs.\nUsage: factorio.py observe-research --limit-available <n> --limit-locked <n> --limit-completed <n>\n",
    "observe-recipes": "observe-recipes: List available recipes and their ingredients/products.\nUsage: factorio.py observe-recipes --limit-recipes <n> [--unlocked-only]\n",
    "observe-entity": "observe-entity: Inspect entity status, fuel, fluids, recipe, inventory.\nUsage: factorio.py observe-entity --target x,y [--target ...]\n   or: factorio.py observe-entity --targets-json <json>\n",
    "observe-resources": "observe-resources: Scan for resource patches in a radius.\nUsage: factorio.py observe-resources --window-x <n> --window-y <n> --radius <n>\n",
    "observe-factory": "observe-factory: Summarize power, fuel, and entity status counts in a window.\nUsage: factorio.py observe-factory --center-x <n> --center-y <n> --radius <n>\n",
    "observe-layout": "observe-layout: Render a region as an ASCII map (belts, inserters, machines, terrain).\nUsage: factorio.py observe-layout --center-x <n> --center-y <n> --radius <n> --step <n>\n",
    "observe-connections": "observe-connections: Audit inserter/belt/machine links and report dead ends or reversed links.\nUsage: factorio.py observe-connections --center-x <n> --center-y <n> --radius <n>\n",
    "observe-entity-prototype": "observe-entity-prototype: Look up entity dimensions, fluid connections, energy info.\nUsage: factorio.py observe-entity-prototype --name <entity-name>\n",
    "observe-placement": "observe-placement: Analyze buildability without consuming an item.\nUsage: factorio.py observe-placement --entity name,anchor-x,anchor-y,dir [--entity ...]\n",
    "act-build": "act-build: Place entities using the top-left occupied tile as the anchor.\nUsage: factorio.py act-build --entity name,anchor-x,anchor-y,dir [--entity ...] [--no-clear]\n   or: factorio.py act-build --entities-json <json> [--no-clear]\nDirection: 0=north (up), 4=east (right), 8=south (down), 12=west (left).\nNote: The character walks into reach using native pathfinding. Trees and rocks in the\nfootprint are mined before placement unless --no-clear is given.\n",
    "act-build-blueprint": "act-build-blueprint: Expand a Factorio blueprint string and build it in batches of at most 50 entities.\nUsage: factorio.py act-build-blueprint --blueprint-file <path> [--anchor x,y] [--dry-run] [--no-clear]\n   or: factorio.py act-build-blueprint --blueprint <string> [--anchor x,y] [--dry-run] [--no-clear]\nPosition: blueprint positions are map coordinates; --anchor moves the whole plan so its top-left tile lands there.\nDirections: 0=north (up), 4=east (right), 8=south (down), 12=west (left).\nDry run: prints the expanded entities, placement analysis, and missing items without building.\nNote: Recipes, filters and module settings inside the blueprint are NOT applied; set them with\nact-set-recipe afterwards. The character walks between entities, so a large plan takes many minutes.\n",
    "act-mine": "act-mine: Mine a resource or entity at target tile coordinates.\nUsage: factorio.py act-mine --target x,y [--target ...] [--resource [name]]\n   or: factorio.py act-mine --targets-json <json>\nResource mode excludes the character and prioritizes the requested resource deterministically.\nNote: The character walks into reach and performs one native mining cycle per target (one extraction for a resource vein).\n",
    "act-rotate": "act-rotate: Rotate entities at target tile coordinates (first entity at each point).\nUsage: factorio.py act-rotate --target x,y [--target ...]\n   or: factorio.py act-rotate --targets-json <json>\nDirection (in results): 0=north (up), 4=east (right), 8=south (down), 12=west (left).\nNote: The character walks into reach using native pathfinding.\n",
    "act-move": "act-move: Move the player through paced, collision-checked steps to target tile coordinates.\nUsage: factorio.py act-move --target x,y [--target ...]\n   or: factorio.py act-move --targets-json <json>\nNote: Stops and returns partial progress if an intermediate step is blocked.\n",
    "act-launch-rocket": "act-launch-rocket: Launch a ready rocket silo at target tile coordinates.\nUsage: factorio.py act-launch-rocket --target x,y [--target ...]\n   or: factorio.py act-launch-rocket --targets-json <json>\nNote: Walks into reach. Success means launch initiated; the benchmark waits for an actual launch.\n",
    "act-set-recipe": "act-set-recipe: Set the recipe on assemblers at target tile coordinates.\nUsage: factorio.py act-set-recipe --target x,y,recipe [--target ...]\n   or: factorio.py act-set-recipe --targets-json <json>\nNote: The character walks into reach using native pathfinding.\n",
    "act-research": "act-research: Start researching a technology.\nUsage: factorio.py act-research --technology <name>\n",
    "act-craft": "act-craft: Queue a handcraft and verify its products appear (or use --no-wait).\nUsage: factorio.py act-craft --item <name> --count <n> [--no-wait]\n",
    "act-insert": "act-insert: Move items from player inventory into an entity at x,y.\nUsage: factorio.py act-insert --entity x,y --item <name> --count <n>\nNote: The character walks into reach using native pathfinding.\n",
    "act-extract": "act-extract: Remove items from an entity at x,y into player inventory.\nUsage: factorio.py act-extract --entity x,y --item <name> --count <n|all>\nNote: The character walks into reach using native pathfinding.\n",
    "wait": "wait: Sleep locally for N milliseconds between actions.\nUsage: factorio.py wait --ms <n>\n",
    "job-status": "job-status: Read action job progress.\nUsage: factorio.py job-status --job-id <id>\n",
    "job-cancel": "job-cancel: Request cancellation after the current atomic action.\nUsage: factorio.py job-cancel --job-id <id>\n",
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


def loader_entity(source: dict[str, Any], target: dict[str, Any],
                  name: str = "inserter") -> dict[str, Any]:
    """Place one inserter between two tiles exactly two apart in a straight line."""
    x1, y1 = int(round(float(source["x"]))), int(round(float(source["y"])))
    x2, y2 = int(round(float(target["x"]))), int(round(float(target["y"])))
    dx = (x2 > x1) - (x2 < x1)
    dy = (y2 > y1) - (y2 < y1)
    if bool(dx) == bool(dy):
        raise ValueError("loader endpoints must be on the same row or column")
    if abs(x2 - x1) + abs(y2 - y1) != 2:
        raise ValueError("loader endpoints must be exactly two tiles apart")
    direction = 4 if dx > 0 else 12 if dx < 0 else 8 if dy > 0 else 0
    return {"name": name, "x": x1 + dx, "y": y1 + dy, "direction": direction}


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
        return self.build(belt_line_entities(start, end, name), **options)

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

    def observe_placement(self, placements: list[dict[str, Any]]) -> Any:
        return self.request("POST", "/api/agent/observe/placement", {"placements": placements})

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
        deadline = time.monotonic() + max(0.0, timeout)
        while True:
            value = predicate()
            if value:
                return value
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise TimeoutError(f"condition not met within {timeout:g}s")
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
        for entity in raw_entities:
            subtype = entity.get("type")
            if subtype in ("input", "output"):
                warnings.append(
                    f"entity {entity.get('name')} is an underground {subtype}; the build API has "
                    "no input/output subtype, so underground pairs may not place correctly"
                )
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
        chunks = [entities[start:start + limit] for start in range(0, len(entities), limit)]
        jobs: list[Any] = []
        results: list[Any] = []
        failed_chunk: int | None = None
        error: str | None = None
        cleared = 0
        skipped: list[Any] = []
        pending_remaining = 0
        clearing_ok = True
        for index, chunk in enumerate(chunks):
            try:
                job = self.build(chunk, clear=clear)
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
                    else f"build job for chunk {index} {status or 'failed'}"
                )
                break
            chunk_results = job.get("results")
            if not isinstance(chunk_results, list) or not chunk_results:
                failed_chunk = index
                error = f"build job for chunk {index} returned no results"
                break
            results.extend(chunk_results)
            for result in chunk_results:
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
        ok = failed_chunk is None and bool(results) and all(
            isinstance(result, dict) and result.get("ok") is not False for result in results
        )
        summary: dict[str, Any] = {
            "ok": ok,
            "blueprint_entities": len(entities),
            "chunks": len(chunks),
            "max_per_job": limit,
            "results": results,
            "clearing": {
                "ok": clearing_ok,
                "cleared": cleared,
                "skipped": skipped,
                "pending_remaining": pending_remaining,
            },
            "job_ids": [job.get("job_id") for job in jobs if isinstance(job, dict)],
            "warnings": warnings,
        }
        if failed_chunk is not None:
            summary["failed_chunk"] = failed_chunk
            summary["error"] = error
        return summary

    def mine(self, targets: list[dict[str, Any]], **options: Any) -> Any:
        return self.submit_action("mine", {"targets": targets}, **options)

    def rotate(self, targets: list[dict[str, Any]], **options: Any) -> Any:
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


def write_response(*, ok: bool, cmd: str, started: float, data: Any = MISSING,
                   error: str | None = None, truncated: Any = MISSING) -> None:
    response: dict[str, Any] = {"schema_version": API_SCHEMA_VERSION, "ok": ok, "cmd": cmd}
    if data is not MISSING:
        response["data"] = data
    if error is not None:
        response["error"] = error
    if truncated is not MISSING:
        response["truncated"] = truncated
    response["timing_ms"] = int((time.monotonic() - started) * 1000)
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
        if cmd == "observe-entity-prototype":
            name = flag("name")
            if not name:
                raise ValueError("Missing --name")
            return output(data_value(request("POST", "/api/agent/observe/entity-prototype", {"name": name})))
        if cmd == "observe-placement":
            placements = json.loads(flag("entities-json")) if flag("entities-json") else parse_entities(flags.get("entity", []))
            response = request("POST", "/api/agent/observe/placement", {"placements": placements})
            truncated = response["truncated"] if isinstance(response, dict) and "truncated" in response else MISSING
            return output(data_value(response), truncated=truncated)

        if cmd == "act-build":
            entities = json.loads(flag("entities-json")) if flag("entities-json") else parse_entities(flags.get("entity", []))
            job = submit("build", {"entities": entities, "clear_obstacles": not bool(flag("no-clear"))})
        elif cmd == "act-build-belt":
            start_value, end_value = flag("from"), flag("to")
            if not start_value or not end_value:
                raise ValueError("Missing --from or --to")
            start = parse_targets([start_value], False)[0]
            end = parse_targets([end_value], False)[0]
            job = submit("build", {"entities": belt_line_entities(start, end, flag("name") or "transport-belt"),
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
        elif cmd in ("act-mine", "act-rotate", "act-move", "act-set-recipe", "act-launch-rocket"):
            require_recipe = cmd == "act-set-recipe"
            targets = json.loads(flag("targets-json")) if flag("targets-json") else parse_targets(flags.get("target", []), require_recipe)
            if cmd == "act-mine" and flag("resource"):
                resource = flag("resource")
                targets = [dict(target, kind="resource", **({} if resource == "true" else {"name": resource})) for target in targets]
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
        elif cmd == "wait":
            milliseconds = max(0, parse_number(flag("ms"), 0) or 0)
            time.sleep(milliseconds / 1000)
            return output({"waited_ms": milliseconds})
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
