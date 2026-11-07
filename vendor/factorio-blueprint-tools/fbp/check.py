"""Supply check: does every crafter have a plausible source for each item ingredient?

A finding is raised when an ingredient is not produced by anything adjacent
to the machine's input inserters, and none of those inputs is an unknown
source (a chest without filters, or a belt fed from outside the blueprint).
Unknown sources make the check inconclusive rather than clean, and are
reported separately.
"""
from .model import DIRS, inserter_ends, is_splitter, kind, tile_of
from .trace import Tracer


def drop_lane(inserter, belt):
    """Which lane of `belt` an inserter fills: 'left'/'right' relative to belt travel, or 'both' if inline."""
    pick, drop = inserter_ends(inserter)
    ix, iy = tile_of(inserter)
    dx, dy = DIRS[belt.get("direction", 0) & 12]
    rel = (ix - drop[0], iy - drop[1])
    rel = ((rel[0] > 0) - (rel[0] < 0), (rel[1] > 0) - (rel[1] < 0))   # long-handed inserters stand 2 tiles away
    if rel == (dy, -dx):        # inserter stands on the belt's left: items land on the far (right) lane
        return "right"
    if rel == (-dy, dx):
        return "left"
    return "both"


def lane_mix(grid, gamedata):
    """Lanes that receive two different items from inserters.

    A mall belt is meant to carry one item per lane. When a second item is
    dropped onto a lane that already carries something else, the lane fills
    with whichever item is consumed least and everything downstream loses that
    lane. Furnace output counts as one item ("smelted") because the tool cannot
    tell which plate a furnace makes.
    """
    tr = Tracer(grid, gamedata)
    terminals = [b for b in grid.entities if kind(b) == "belt" and not is_splitter(b) and not tr.downstream(b)]
    seen, warnings = set(), []
    for t in terminals:
        belts, cells = tr.line(t)
        key = frozenset(b["entity_number"] for b in belts)
        if key in seen:
            continue
        seen.add(key)
        lanes = {"left": {}, "right": {}}
        for ins, sources in tr.feeders(cells):
            pick, drop = inserter_ends(ins)
            belt = grid.belt_at(*drop)
            for s in sources:
                k = kind(s)
                if k == "furnace":
                    item = "smelted"
                elif k == "crafter" and s.get("recipe"):
                    prods = sorted(gamedata.products(s["recipe"]))
                    item = prods[0] if prods else s["recipe"]
                else:
                    continue
                lane = drop_lane(ins, belt)
                for L in (("left", "right") if lane == "both" else (lane,)):
                    lanes[L].setdefault(item, []).append(ins)
        for L, items in lanes.items():
            if len(items) > 1:
                xs = [c[0] for c in cells]
                ys = [c[1] for c in cells]
                cons = sum(1 for _ in tr.consumers(cells))
                warnings.append({"terminal": t, "lane": L, "items": {i: len(v) for i, v in items.items()},
                                 "belts": len(belts), "bbox": (min(xs), min(ys), max(xs), max(ys)), "consumers": cons})
    return warnings


def format_lane_mix(grid, warnings):
    if not warnings:
        return "LANE MIX: none"
    lines = ["LANE MIX (%d): a lane fed two different items" % len(warnings)]
    for w in warnings:
        x0, y0, x1, y1 = w["bbox"]
        lines.append("  line ending at %s (%d belts, x%d-%d y%d-%d, %d consumers): %s lane gets %s" % (
            grid.describe(w["terminal"]), w["belts"], x0, x1, y0, y1, w["consumers"], w["lane"],
            ", ".join("%s (%d inserters)" % kv for kv in sorted(w["items"].items()))))
    return "\n".join(lines)


def check(grid, gamedata, recipe=None):
    tr = Tracer(grid, gamedata)
    findings, inconclusive, unknown_recipes = [], [], set()
    for m in grid.entities:
        if kind(m) != "crafter" or not m.get("recipe"):
            continue
        if recipe and m["recipe"] != recipe:
            continue
        needs = gamedata.ingredients(m["recipe"])
        if needs is None:
            unknown_recipes.add(m["recipe"])
            continue
        inputs, outputs = tr.machine_io(m)
        available = set()
        any_unknown = False
        for i in inputs:
            available |= i["items"]
            any_unknown = any_unknown or i["unknown"]
        missing = [item for item in needs if item not in available]
        if needs and not inputs:
            findings.append({"machine": m, "missing": list(needs), "reason": "no input inserters"})
        elif missing and not any_unknown:
            findings.append({"machine": m, "missing": missing, "reason": "no adjacent source"})
        elif missing:
            inconclusive.append({"machine": m, "missing": missing, "reason": "only unknown sources could supply these"})
        if not outputs and gamedata.has_item_results(m["recipe"]):
            findings.append({"machine": m, "missing": [], "reason": "no output inserter"})
    return findings, inconclusive, sorted(unknown_recipes)


def format_report(grid, findings, inconclusive, unknown_recipes, source):
    lines = ["recipe data: %s" % source]
    if findings:
        lines.append("PROBLEMS (%d):" % len(findings))
        for f in findings:
            lines.append("  %s: %s%s" % (grid.describe(f["machine"]), f["reason"],
                                       (" -> missing " + ", ".join(f["missing"])) if f["missing"] else ""))
    else:
        lines.append("PROBLEMS: none")
    if inconclusive:
        lines.append("INCONCLUSIVE (%d):" % len(inconclusive))
        for f in inconclusive:
            lines.append("  %s: %s -> %s" % (grid.describe(f["machine"]), f["reason"], ", ".join(f["missing"])))
    if unknown_recipes:
        lines.append("UNKNOWN RECIPES (not in data): " + ", ".join(unknown_recipes))
    return "\n".join(lines)
