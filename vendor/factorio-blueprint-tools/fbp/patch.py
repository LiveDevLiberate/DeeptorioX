"""Apply a JSON patch to a blueprint.

Patch format::

    {
      "remove": [1057, 885],
      "recipe": {"883": "copper-cable"},
      "add": [
        {"name": "inserter", "position": {"x": 113.5, "y": 75.5}, "direction": 0},
        {"name": "transport-belt", "position": {"x": 111.5, "y": 77.5}, "direction": 8}
      ]
    }

Entity numbers refer to the INPUT blueprint. After the patch every entity is
renumbered contiguously and wires are remapped. New entities may not overlap
existing ones; a removal that would strand a wire is refused unless the patch
sets "drop_wires": true.
"""
from .model import Grid, footprint


class PatchError(Exception):
    pass


def apply(obj_bp, patch, footprints=None, log=None):
    """Mutate blueprint dict obj_bp in place and return it."""
    log = log if log is not None else []
    grid = Grid(obj_bp, footprints)
    remove = set(int(x) for x in patch.get("remove", []))
    recipe = {int(k): v for k, v in patch.get("recipe", {}).items()}
    add = patch.get("add", [])

    for eid in remove | set(recipe):
        if eid not in grid.byid:
            raise PatchError("no entity #%d in blueprint" % eid)
    wires = obj_bp.get("wires", [])
    stranded = [w for w in wires if w[0] in remove or w[2] in remove]
    if stranded and not patch.get("drop_wires"):
        raise PatchError("removing %s would strand %d wire(s); set drop_wires to allow" %
                         (sorted({w[0] for w in stranded} | {w[2] for w in stranded}) , len(stranded)))

    for eid in sorted(remove):
        log.append("remove %s" % grid.describe(grid.byid[eid]))
    for eid, rec in recipe.items():
        e = grid.byid[eid]
        log.append("recipe %s -> %s" % (grid.describe(e), rec))
        e["recipe"] = rec
        e.setdefault("recipe_quality", "normal")

    kept = [e for e in obj_bp["entities"] if e["entity_number"] not in remove]
    occupied = {}
    for e in kept:
        for c in footprint(e, grid.footprints):
            occupied.setdefault(c, []).append(e)
    for n in add:
        for c in footprint(n, grid.footprints):
            if c in occupied:
                raise PatchError("%s at %s collides with %s" %
                                 (n["name"], n["position"], ", ".join(grid.describe(x) for x in occupied[c])))
        for c in footprint(n, grid.footprints):
            occupied.setdefault(c, []).append(n)
        log.append("add    %s @ (%g,%g) dir=%d %s" % (n["name"], n["position"]["x"], n["position"]["y"],
                                                    n.get("direction", 0), n.get("recipe", "")))
    kept.extend(add)

    remap = {}
    for i, e in enumerate(kept, 1):
        if "entity_number" in e:
            remap[e["entity_number"]] = i
        e["entity_number"] = i
    obj_bp["wires"] = [[remap[a], ca, remap[b], cb] for a, ca, b, cb in wires
                       if a in remap and b in remap]
    obj_bp["entities"] = kept
    return obj_bp


def crop(obj_bp, x0, y0, x1, y1, footprints=None):
    """New blueprint dict containing only entities fully inside the box."""
    grid = Grid(obj_bp, footprints)
    keep = [e for e in obj_bp["entities"]
            if all(x0 <= c[0] <= x1 and y0 <= c[1] <= y1 for c in grid.cells_of(e))]
    ids = {e["entity_number"] for e in keep}
    tiles = [t for t in obj_bp.get("tiles", []) if x0 <= t["position"]["x"] <= x1 and y0 <= t["position"]["y"] <= y1]
    import copy
    new = {k: copy.deepcopy(v) for k, v in obj_bp.items() if k not in ("entities", "wires", "tiles")}
    new["entities"] = copy.deepcopy(keep)
    new["wires"] = [list(w) for w in obj_bp.get("wires", []) if w[0] in ids and w[2] in ids]
    if tiles:
        new["tiles"] = copy.deepcopy(tiles)
    remap = {}
    for i, e in enumerate(new["entities"], 1):
        remap[e["entity_number"]] = i
        e["entity_number"] = i
    new["wires"] = [[remap[a], ca, remap[b], cb] for a, ca, b, cb in new["wires"]]
    return new
