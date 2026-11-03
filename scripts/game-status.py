#!/usr/bin/env python3
"""Print a compact live snapshot of the active autorio run and its game state."""

from __future__ import annotations

import collections
import json
import os
import sys
import urllib.request

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from factorio import FactorioClient, data_value  # noqa: E402

BASE = os.environ.get("FACTORIO_API_BASE", "http://127.0.0.1:3000")
IGNORED = {"coal", "stone", "uranium-ore"}


def get(path: str):
    with urllib.request.urlopen(BASE + path, timeout=10) as response:
        return json.load(response)


def inventory(player: dict) -> str:
    items = []
    for container in player.get("inventories", []):
        for slot in container.get("slots", []):
            if slot.get("count"):
                items.append(f"{slot['name']} x{slot['count']}")
    return ", ".join(items) or "empty"


def built_entities(client: FactorioClient, x: float, y: float) -> str:
    world = data_value(client.observe_world(x=x, y=y, radius=45, include=["entities"]))
    counts: collections.Counter[str] = collections.Counter()
    for entity in world.get("entities", []):
        name = entity.get("name", "")
        if name.endswith("-ore") or name in IGNORED or name.startswith("tree-") or name.startswith("crash-site"):
            continue
        counts[name] += 1
    return ", ".join(f"{name} x{count}" for name, count in counts.most_common(15)) or "none"


def main() -> int:
    runs = get("/api/runs").get("runs", [])
    active = next((run for run in runs if run.get("state") in {"preparing", "launching", "running", "saving"}), None)
    run = active or (runs[0] if runs else None)
    if run:
        print(f"Run: {run.get('name') or run.get('id')} [{run.get('state')}] {run.get('reason') or ''}".rstrip())
        print(f"  elapsed {run.get('elapsed_seconds', 0):.0f}s / {run.get('max_seconds')}s"
              f" · actions {run.get('actions')} · tokens {run.get('usage')}")
        if run.get("milestones"):
            print("  milestones: " + ", ".join(
                f"{name}={value['wall_seconds']:.0f}s/{value['game_ticks']}t" for name, value in run["milestones"].items()))
    client = FactorioClient(BASE)
    player = data_value(client.observe_player())["player"]
    print(f"Player: ({player['x']:.1f},{player['y']:.1f}) hp={player['health']} {inventory(player)}")
    research = data_value(client.observe_research())
    current = research.get("current") or (research.get("queue") or [None])[0]
    print(f"Research: {current or 'idle'} · queue={research.get('queue')}")
    print("Built nearby: " + built_entities(client, float(player["x"]), float(player["y"])))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
