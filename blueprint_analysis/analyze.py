"""High-level blueprint analysis used by the autorio Python client."""
from __future__ import annotations

from typing import Any

from .check import check, lane_mix
from .diff import compare
from .gamedata import GameData
from .lint import lint
from .model import Grid, kind
from .flow import Flow


def _first_blueprint(payload: dict[str, Any]) -> dict[str, Any]:
    if isinstance(payload.get("blueprint"), dict):
        return payload["blueprint"]
    book = payload.get("blueprint_book")
    if isinstance(book, dict):
        for entry in book.get("blueprints", []):
            if isinstance(entry, dict):
                try:
                    return _first_blueprint(entry)
                except ValueError:
                    continue
    raise ValueError("blueprint payload has no 'blueprint' object")


def _entity(e: dict[str, Any]) -> dict[str, Any]:
    pos = e.get("position", {})
    out = {
        "entity_number": e.get("entity_number"),
        "name": e.get("name"),
        "x": pos.get("x"),
        "y": pos.get("y"),
    }
    if e.get("recipe"):
        out["recipe"] = e["recipe"]
    if e.get("direction") is not None:
        out["direction"] = e["direction"]
    return out


def analyze_blueprint_payload(payload: dict[str, Any]) -> dict[str, Any]:
    bp = _first_blueprint(payload)
    gd = GameData()
    grid = Grid(bp, gd.footprints())
    tracer_flow = Flow(grid, gd).run()
    flow_json = tracer_flow.as_json()
    findings, inconclusive, unknown_recipes = check(grid, gd)
    lint_findings = lint(grid)
    mixes = lane_mix(grid, gd)
    return {
        "ok": True,
        "summary": {
            "entities": len(grid.entities),
            "recipes": sorted({e["recipe"] for e in grid.entities if e.get("recipe")}),
            "machine_status": {
                status: sum(1 for m in grid.entities if kind(m) in ("crafter", "furnace")
                            and tracer_flow.machine_status(m)[0] == status)
                for status in ("ok", "missing", "unknown", "none")
            },
            "wires": len(bp.get("wires", [])),
            "game_data": gd.source,
        },
        "flow": flow_json,
        "check": {
            "problems": [
                {"machine": _entity(f["machine"]), "reason": f["reason"], "missing": f["missing"]}
                for f in findings
            ],
            "inconclusive": [
                {"machine": _entity(f["machine"]), "reason": f["reason"], "missing": f["missing"]}
                for f in inconclusive
            ],
            "unknown_recipes": unknown_recipes,
        },
        "lint": [
            {"code": code, "entity": _entity(e), "message": message}
            for code, e, message in lint_findings
        ],
        "lane_mix": [
            {
                "lane": m["lane"],
                "items": m["items"],
                "belts": m["belts"],
                "bbox": list(m["bbox"]),
                "consumers": m["consumers"],
                "terminal": _entity(m["terminal"]),
            }
            for m in mixes
        ],
    }


def diff_blueprint_payloads(before: dict[str, Any], after: dict[str, Any]) -> dict[str, Any]:
    gd = GameData()
    text, changed, new_problems = compare(_first_blueprint(before), _first_blueprint(after), gd)
    return {"ok": True, "text": text, "machines_changed": changed, "new_problems_or_lanes": new_problems}
