#!/usr/bin/env python3
"""Read-only self-test for the Factorio bridge (works with a live autorio game)."""

from __future__ import annotations

import os
import sys
import time
import traceback

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from factorio import FactorioClient, data_value  # noqa: E402

BASE = os.environ.get("FACTORIO_API_BASE", "http://127.0.0.1:3000")
client = FactorioClient(BASE)
results: list[tuple[str, bool, str]] = []


def check(name: str, fn) -> None:
    started = time.perf_counter()
    try:
        detail = fn()
        results.append((name, True, f"{detail} ({(time.perf_counter() - started) * 1000:.0f} ms)"))
    except Exception as error:  # noqa: BLE001
        results.append((name, False, f"{type(error).__name__}: {error}"))


def expect(condition: bool, message: str) -> None:
    if not condition:
        raise AssertionError(message)


def main() -> int:
    try:
        status = data_value(client.server_status())
    except Exception as error:  # noqa: BLE001
        print(f"Cannot reach the manager at {BASE}: {error}")
        return 2
    expect(status.get("running"), "game is not running")
    expect(status.get("rcon", {}).get("connected"), "RCON is not connected")

    player_response = data_value(client.observe_player())
    player = player_response["player"]
    px, py = float(player["x"]), float(player["y"])
    results.append(("server-status", True, f"running pid={status.get('pid')}"))

    check("observe-player", lambda: f"{len(player.get('inventories', []))} inventories")
    check("observe-research", lambda: research_detail())
    check("observe-recipes", lambda: recipes_detail())
    check("observe-world", lambda: world_detail(px, py))
    check("observe-map", lambda: map_detail(px, py))
    check("observe-resources", lambda: resources_detail(px, py))
    check("observe-factory", lambda: factory_detail(px, py))
    check("observe-layout", lambda: layout_detail(px, py))
    check("observe-entity-prototype", lambda: prototype_detail())
    check("observe-placement", lambda: placement_detail(px, py))
    check("observe-entity", lambda: entity_detail(px, py))

    width = max(len(name) for name, _, _ in results)
    for name, ok, detail in results:
        print(f"{name.ljust(width)}  {'PASS' if ok else 'FAIL'}  {detail}")
    print(f"\n{sum(1 for _, ok, _ in results if ok)}/{len(results)} checks passed")
    return 0 if all(ok for _, ok, _ in results) else 1


def research_detail() -> str:
    data = data_value(client.observe_research(available=20, locked=5, completed=5))
    for key in ("available", "upgrades", "triggers", "locked", "completed", "counts"):
        expect(key in data, f"missing research field {key}")
    expect(isinstance(data["upgrades"], list), "upgrades must be an array")
    expect(isinstance(data["triggers"], list), "triggers must be an array")
    sample = next(iter(data["available"] + data["upgrades"] + data["completed"]), None)
    if sample is not None:
        expect("level" in sample, "technology descriptor is missing level")
        expect("max_level" in sample, "technology descriptor is missing max_level")
    counts = data["counts"]
    return (f"available={counts.get('available_total')} upgrades={counts.get('upgrade_total')} "
            f"triggers={counts.get('trigger_total')} completed={counts.get('completed_total')}")


def recipes_detail() -> str:
    data = data_value(client.observe_recipes(recipes=10))
    expect(isinstance(data, dict) and "recipes" in data, "recipes response is not an object")
    recipes = data["recipes"]
    expect(isinstance(recipes, list) and recipes, "no recipes returned")
    with_categories = [recipe for recipe in recipes if recipe.get("categories")]
    expect(bool(with_categories), "recipes have no categories (2.1 expects a categories array)")
    return f"{len(recipes)} recipes, {len(with_categories)} with categories"


def world_detail(x: float, y: float) -> str:
    data = data_value(client.observe_world(x=x, y=y, radius=12, include=["terrain", "entities"]))
    expect(isinstance(data.get("entities"), list), "world entities is not an array")
    return f"{len(data['entities'])} entities"


def map_detail(x: float, y: float) -> str:
    data = data_value(client.observe_map(x=x, y=y, radius=24))
    expect(isinstance(data.get("chunks"), list), "map chunks is not an array")
    return f"{len(data['chunks'])} chunks"


def resources_detail(x: float, y: float) -> str:
    data = data_value(client.observe_resources(x=x, y=y, radius=48))
    expect(isinstance(data.get("patches"), list), "resource patches is not an array")
    return f"{len(data['patches'])} patches"


def factory_detail(x: float, y: float) -> str:
    data = data_value(client.observe_factory(x=x, y=y, radius=120))
    expect(isinstance(data.get("counts"), dict), "factory counts is not an object")
    expect(isinstance(data.get("alerts"), list), "factory alerts is not an array")
    expect(isinstance(data.get("problems"), dict), "factory problems is not an object")
    return f"{len(data['counts'])} entity types, {len(data['alerts'])} alert(s)"


def layout_detail(x: float, y: float) -> str:
    data = data_value(client.observe_layout(x=x, y=y, radius=35, step=1))
    expect(isinstance(data.get("rows"), list) and data["rows"], "layout rows are empty")
    expect(isinstance(data.get("legend"), dict), "layout legend is not an object")
    expect(all(isinstance(row, str) for row in data["rows"]), "layout rows must be strings")
    expect(len(data.get("built_rows", [])) == len(data["rows"]), "built_rows length mismatch")
    expect(len(data.get("resource_rows", [])) == len(data["rows"]), "resource_rows length mismatch")
    expect(isinstance(data.get("overlaps"), list), "layout overlaps is not an array")
    return (f"{len(data['rows'])} rows x {len(data['rows'][0])} cols, "
            f"{len(data.get('entities', []))} entities, {len(data.get('overlaps', []))} overlaps")


def prototype_detail() -> str:
    data = data_value(client.observe_entity_prototype("stone-furnace"))
    expect(bool(data.get("name") or data.get("prototype")), "prototype has no name")
    return "stone-furnace"


def placement_detail(x: float, y: float) -> str:
    data = data_value(client.observe_placement([{"name": "stone-furnace", "anchor": {"x": x + 2, "y": y}, "direction": 0}]))
    expect(isinstance(data.get("results"), list), "placement results is not an array")
    return f"{len(data['results'])} placement result(s)"


def entity_detail(x: float, y: float) -> str:
    data = data_value(client.observe_entities([{"x": x, "y": y}]))
    expect(isinstance(data.get("results"), list), "entity results is not an array")
    return f"{len(data['results'])} entity result(s)"


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception:
        traceback.print_exc()
        raise SystemExit(1)
