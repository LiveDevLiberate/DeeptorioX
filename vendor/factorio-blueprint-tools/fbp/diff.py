"""Compare two versions of a blueprint: what changed for every machine, and
which check, lint and lane-mix findings appeared or disappeared.

Machines are matched by position, not entity number, since patches renumber.
Use this after every patch: the intended machines should be the only ones
whose inputs changed, and no new findings should appear.
"""
from .check import check, lane_mix
from .lint import lint
from .model import Grid, kind
from .trace import Tracer


def snapshot(grid, gamedata):
    tr = Tracer(grid, gamedata)
    machines = {}
    for m in grid.entities:
        if kind(m) not in ("crafter", "furnace"):
            continue
        inputs, outputs = tr.machine_io(m)
        items = set().union(*(i["items"] for i in inputs)) if inputs else set()
        machines[(m["position"]["x"], m["position"]["y"])] = {
            "name": m["name"], "recipe": m.get("recipe"), "n_in": len(inputs), "items": items,
            "unknown": any(i["unknown"] for i in inputs),
            "outs": tuple(sorted(t["name"] + ("[" + t["recipe"] + "]" if t.get("recipe") else "")
                                 for o in outputs for t in o["targets"])),
        }
    findings, inconclusive, unknown = check(grid, gamedata)
    problems = {(grid.describe(f["machine"]).split("#")[0] + str(f["machine"]["position"]), f["reason"], tuple(f["missing"]))
                for f in findings}
    lints = {(code, e["name"], e["position"]["x"], e["position"]["y"]) for code, e, msg in lint(grid)}
    lanes = {(w["lane"], tuple(sorted(w["items"])), w["bbox"]) for w in lane_mix(grid, gamedata)}
    return {"machines": machines, "problems": problems, "lints": lints, "lanes": lanes,
            "entities": len(grid.entities), "wires": len(grid.bp.get("wires", []))}


def compare(bp_a, bp_b, gamedata):
    fp = gamedata.footprints()
    A = snapshot(Grid(bp_a, fp), gamedata)
    B = snapshot(Grid(bp_b, fp), gamedata)
    out = []
    out.append("entities %d -> %d, wires %d -> %d" % (A["entities"], B["entities"], A["wires"], B["wires"]))
    ma, mb = A["machines"], B["machines"]
    for k in sorted(set(ma) - set(mb)):
        out.append("REMOVED machine %s %s [%s]" % (k, ma[k]["name"], ma[k]["recipe"]))
    for k in sorted(set(mb) - set(ma)):
        out.append("ADDED   machine %s %s [%s]" % (k, mb[k]["name"], mb[k]["recipe"]))
    changed = 0
    for k in sorted(set(ma) & set(mb)):
        a, b = ma[k], mb[k]
        d = []
        if a["recipe"] != b["recipe"]:
            d.append("recipe %s -> %s" % (a["recipe"], b["recipe"]))
        if a["n_in"] != b["n_in"]:
            d.append("inputs %d -> %d" % (a["n_in"], b["n_in"]))
        if b["items"] - a["items"]:
            d.append("gains " + ",".join(sorted(b["items"] - a["items"])))
        if a["items"] - b["items"]:
            d.append("loses " + ",".join(sorted(a["items"] - b["items"])))
        if a["outs"] != b["outs"]:
            d.append("outputs %s -> %s" % (a["outs"], b["outs"]))
        if d:
            changed += 1
            need = gamedata.ingredients(b["recipe"]) or {} if b["recipe"] else {}
            missing = [i for i in need if i not in b["items"]]
            status = "OK" if not missing else ("MISSING " + ",".join(missing) + (" (unknown sources)" if b["unknown"] else ""))
            out.append("CHANGED machine %s %s [%s]: %s  => %s" % (k, b["name"], b["recipe"], "; ".join(d), status))
    out.append("machines changed: %d of %d" % (changed, len(ma)))
    for label, key in (("check problem", "problems"), ("lint finding", "lints"), ("lane mix", "lanes")):
        gone, new = A[key] - B[key], B[key] - A[key]
        out.append("%s: %d -> %d (%d fixed, %d new)" % (label, len(A[key]), len(B[key]), len(gone), len(new)))
        for x in sorted(gone, key=str):
            out.append("  fixed: %s" % (x,))
        for x in sorted(new, key=str):
            out.append("  NEW:   %s" % (x,))
    return "\n".join(out), changed, len(B["problems"] - A["problems"]) + len(B["lanes"] - A["lanes"])
