"""Lane-level item flow: what can be on each lane of every belt.

This is a static "could be here" analysis, not a simulation. Item sets only
grow along the graph and the computation runs to a fixed point with a
worklist, so it is linear in the size of the print rather than in the length
of its longest belt:

  * an inserter dropping onto a belt puts its source's items on the FAR lane
  * belts keep lanes through straights and curves
  * a belt entering the SIDE of another belt sideloads: both of its lanes land
    on the target's NEAR lane (a curve is a single input with nothing behind)
  * a sideload into an underground tile passes only the feeder lane aligned
    with the open half: the back half for an entrance, the front half for an
    exit (docs/belt-patterns.md section 1)
  * splitters keep lanes and send everything to both outputs, unless a filter
    is set: then the filtered item goes only to the priority output and the
    rest only to the other one
  * a crafter emits its recipe's item products; a furnace emits the smelting
    result of whatever reaches it (or "smelted?" when its input is unknown)
  * a chest holds whatever is dropped into it; inserters picking from it carry
    that on

Edge feeders let the user declare items entering from outside the print:
[{"x": 23, "y": 86, "items": ["iron-ore"], "lane": "both"}], stored beside
the blueprint as <name>.feeds.json.
"""
import json
import os
from collections import defaultdict, deque

from .model import DIRS, INSERTERS, inserter_ends, is_splitter, is_underground, kind, tile_of
from .trace import Tracer

UNKNOWN_SMELT = "smelted?"


def feeds_path(blueprint_path):
    stem, _ = os.path.splitext(blueprint_path)
    return stem + ".feeds.json"


def load_feeds(path):
    if path and os.path.exists(path):
        with open(path, encoding="utf-8") as handle:
            return json.load(handle)
    return []


def save_feeds(path, feeds):
    with open(path, "w", encoding="utf-8") as handle:
        json.dump(feeds, handle, indent=1)


def left_of(direction):
    dx, dy = DIRS[direction & 12]
    return (dy, -dx)


class Flow:
    def __init__(self, grid, gamedata, feeds=()):
        self.g = grid
        self.gd = gamedata
        self.tr = Tracer(grid, gamedata)
        self.feeds = list(feeds)
        self.lanes = {}        # belt id -> {"left": set, "right": set}
        self.machine_in = {}   # machine id -> set
        self.machine_out = {}  # machine id -> set
        self.chest = {}        # chest id -> set
        self.smelt = self._smelting_map()
        self._build_graph()

    def _smelting_map(self):
        out = {}
        for name, r in self.gd.recipes.items():
            if r.get("category") == "smelting":
                for ing in r["ingredients"]:
                    out.setdefault(ing, set()).update(r["results"])
        return out

    # -- static graph -------------------------------------------------------
    def _build_graph(self):
        g, tr = self.g, self.tr
        self.belt_in = defaultdict(list)      # belt id -> [(feeder, cell)]
        self.belt_out = defaultdict(set)      # belt id -> {downstream belt ids}
        for b in g.entities:
            if kind(b) != "belt":
                continue
            for cell in g.cells_of(b):
                for f in tr.upstream(b):
                    if cell in tr.outputs(f):
                        self.belt_in[b["entity_number"]].append((f, cell))
                        self.belt_out[f["entity_number"]].add(b["entity_number"])
        self.ins_pick = {}                    # inserter id -> [source entities]
        self.ins_drop = {}                    # inserter id -> [(target entity, drop cell)]
        self.picked_by = defaultdict(list)    # source id -> [inserter]
        self.machine_ins = defaultdict(list)  # machine id -> [inserter dropping into it]
        for ins in g.entities:
            if ins["name"] not in INSERTERS:
                continue
            pick, drop = inserter_ends(ins)
            srcs = g.at(*pick, exclude_kinds=("inserter",))
            tgts = g.at(*drop, exclude_kinds=("inserter",))
            self.ins_pick[ins["entity_number"]] = srcs
            self.ins_drop[ins["entity_number"]] = [(t, drop) for t in tgts]
            for s in srcs:
                self.picked_by[s["entity_number"]].append(ins)
            for t in tgts:
                if kind(t) in ("crafter", "furnace"):
                    self.machine_ins[t["entity_number"]].append(ins)

    # -- lane helpers --------------------------------------------------------
    def lanes_of(self, b):
        return self.lanes.setdefault(b["entity_number"], {"left": set(), "right": set()})

    def _feeder_side(self, f, b_dir, cell):
        fd = f.get("direction", 0) & 12
        if fd == (b_dir & 12):
            return "behind"
        if is_splitter(f):
            dx, dy = DIRS[fd]
            fx, fy = next((c for c in self.g.cells_of(f) if (c[0] + dx, c[1] + dy) == cell), self.g.cells_of(f)[0])
        else:
            fx, fy = tile_of(f)
        rel = (fx - cell[0], fy - cell[1])
        return "left" if rel == left_of(b_dir) else "right"

    def _splitter_sides(self, s):
        cells = self.g.cells_of(s)
        lv = left_of(s.get("direction", 0))
        return sorted(cells, key=lambda c: -(c[0] * lv[0] + c[1] * lv[1]))

    def _out_lanes(self, f, cell):
        """Lane sets leaving feeder f toward `cell` (splitter filters applied here)."""
        FL = self.lanes_of(f)
        if not is_splitter(f):
            return {"left": FL["left"], "right": FL["right"]}
        flt = (f.get("filter") or {}).get("name")
        prio = f.get("output_priority")
        if not flt or prio not in ("left", "right"):
            return {"left": FL["left"], "right": FL["right"]}
        left_cell, right_cell = self._splitter_sides(f)
        dx, dy = DIRS[f.get("direction", 0) & 12]
        out_side = "left" if (left_cell[0] + dx, left_cell[1] + dy) == cell else "right"
        keep = (lambda s: {i for i in s if i == flt}) if out_side == prio else (lambda s: {i for i in s if i != flt})
        return {"left": keep(FL["left"]), "right": keep(FL["right"])}

    def _underground_filter(self, f, u, FL):
        ud = u.get("direction", 0) & 12
        fwd = DIRS[ud]
        back = (-fwd[0], -fwd[1])
        open_side = back if u.get("type") == "input" else fwd
        return FL["left"] if left_of(f.get("direction", 0)) == open_side else FL["right"]

    def _drop_lane(self, ins, belt, drop_cell):
        ix, iy = tile_of(ins)
        lv = left_of(belt.get("direction", 0))
        rel = (ix - drop_cell[0], iy - drop_cell[1])
        rel = ((rel[0] > 0) - (rel[0] < 0), (rel[1] > 0) - (rel[1] < 0))   # long-handed inserters stand 2 tiles away
        if rel == lv:
            return "right"       # standing on the belt's left: items land on the far (right) lane
        if rel == (-lv[0], -lv[1]):
            return "left"
        return "right"           # inline: the game uses the belt's right lane

    def _source_items(self, sources):
        items = set()
        for s in sources:
            k = kind(s)
            if k == "belt":
                L = self.lanes_of(s); items |= L["left"] | L["right"]
            elif k in ("crafter", "furnace"):
                items |= self.machine_out.get(s["entity_number"], set())
            elif k == "chest":
                items |= self.chest.get(s["entity_number"], set())
                for sec in s.get("request_filters", {}).get("sections", []):
                    items |= {flt["name"] for flt in sec.get("filters", []) if flt.get("name")}
        return items

    # -- worklist fixed point -----------------------------------------------
    def run(self):
        """Fixed point, repeated so that "smelted?" placeholders do not survive on furnaces whose
        input turned out to be known: each pass records which furnaces resolved, the next pass
        starts clean and lets those furnaces emit only real plates. Converges in 2-3 passes."""
        self._resolved = set()
        while True:
            self.lanes.clear(); self.machine_in.clear(); self.machine_out.clear(); self.chest.clear()
            self._run_once()
            resolved = {eid for eid, mi in self.machine_in.items()
                        if kind(self.g.byid[eid]) == "furnace" and any(i in self.smelt for i in mi)}
            if resolved <= self._resolved:
                return self
            self._resolved |= resolved

    def _run_once(self):
        g = self.g
        work = deque()
        queued = set()

        def push(eid):
            if eid not in queued:
                queued.add(eid); work.append(eid)

        def add_lane(b, lane, items):
            L = self.lanes_of(b)
            new = items - L[lane]
            if new:
                L[lane] |= new
                bid = b["entity_number"]
                for d in self.belt_out[bid]:
                    push(d)
                for ins in self.picked_by[bid]:
                    push(ins["entity_number"])

        for f in self.feeds:
            b = g.belt_at(int(f["x"]), int(f["y"]))
            if b:
                for lane in (("left", "right") if f.get("lane", "both") == "both" else (f["lane"],)):
                    add_lane(b, lane, set(f.get("items", [])))
        for m in g.entities:                      # machines emit products even before inputs are known
            if kind(m) in ("crafter", "furnace"):
                push(m["entity_number"])

        while work:
            eid = work.popleft(); queued.discard(eid)
            e = g.byid.get(eid)
            if e is None:
                continue
            k = kind(e)
            if k == "belt":
                d = e.get("direction", 0)
                for cell in g.cells_of(e):
                    feeders = [(f, c) for f, c in self.belt_in[eid] if c == cell]
                    if not feeders:
                        continue
                    behind = [f for f, c in feeders if self._feeder_side(f, d, cell) == "behind"]
                    sides = [f for f, c in feeders if f not in behind]
                    curve = not behind and len(sides) == 1 and not is_underground(e) and not is_splitter(e)
                    for f in behind:
                        FL = self._out_lanes(f, cell)
                        add_lane(e, "left", FL["left"]); add_lane(e, "right", FL["right"])
                    for f in sides:
                        FL = self._out_lanes(f, cell)
                        if curve:
                            add_lane(e, "left", FL["left"]); add_lane(e, "right", FL["right"])
                        else:
                            incoming = self._underground_filter(f, e, FL) if is_underground(e) else (FL["left"] | FL["right"])
                            add_lane(e, self._feeder_side(f, d, cell), incoming)
            elif e["name"] in INSERTERS:
                items = self._source_items(self.ins_pick.get(eid, []))
                if not items:
                    continue
                for t, drop in self.ins_drop.get(eid, []):
                    tk = kind(t)
                    if tk == "belt":
                        add_lane(t, self._drop_lane(e, t, drop), items)
                    elif tk == "chest":
                        c = self.chest.setdefault(t["entity_number"], set())
                        new = items - c
                        if new:
                            c |= new
                            for ins in self.picked_by[t["entity_number"]]:
                                push(ins["entity_number"])
                    elif tk in ("crafter", "furnace"):
                        push(t["entity_number"])
            elif k in ("crafter", "furnace"):
                mi = self.machine_in.setdefault(eid, set())
                for ins in self.machine_ins[eid]:
                    mi |= self._source_items(self.ins_pick.get(ins["entity_number"], []))
                if k == "crafter":
                    out = set(self.gd.products(e["recipe"])) if e.get("recipe") else set()
                else:
                    out = set()
                    for i in mi:
                        out |= self.smelt.get(i, set())
                    if not out and eid not in self._resolved:
                        out = {UNKNOWN_SMELT}
                mo = self.machine_out.setdefault(eid, set())
                new = out - mo
                if new:
                    mo |= new
                    for ins in self.picked_by[eid]:
                        push(ins["entity_number"])
        return self

    # -- results ----------------------------------------------------------
    def machine_status(self, m):
        """('ok'|'missing'|'unknown'|'none', missing_items). 'unknown' when a furnace of
        unresolved input could be supplying the missing plates; 'none' for no recipe."""
        k = kind(m)
        mi = self.machine_in.get(m["entity_number"], set())
        if k == "furnace":
            known = mi - {UNKNOWN_SMELT}
            if known:
                return ("ok", []) if any(i in self.smelt for i in known) else ("missing", sorted(known))
            return ("unknown", [])
        if not m.get("recipe"):
            return ("none", [])
        needs = self.gd.ingredients(m["recipe"])
        if needs is None:
            return ("unknown", [])
        missing = [i for i in needs if i not in mi]
        if not missing:
            return ("ok", [])
        plates = set().union(*self.smelt.values()) if self.smelt else set()
        if UNKNOWN_SMELT in mi and all(i in plates for i in missing):
            return ("unknown", missing)
        return ("missing", missing)

    def items_seen(self):
        seen = set()
        for L in self.lanes.values():
            seen |= L["left"] | L["right"]
        return seen

    def as_json(self):
        machines = {}
        for m in self.g.entities:
            if kind(m) in ("crafter", "furnace"):
                status, missing = self.machine_status(m)
                machines[str(m["entity_number"])] = {"in": sorted(self.machine_in.get(m["entity_number"], ())),
                                                     "out": sorted(self.machine_out.get(m["entity_number"], ())),
                                                     "status": status, "missing": missing}
        return {"lanes": {str(k): {"left": sorted(v["left"]), "right": sorted(v["right"])}
                          for k, v in self.lanes.items() if v["left"] or v["right"]},
                "machines": machines,
                "chests": {str(k): sorted(v) for k, v in self.chest.items()},
                "feeds": self.feeds,
                "items": sorted(self.items_seen())}

    def at(self, x, y):
        b = self.g.belt_at(x, y)
        if not b:
            return None
        return self.lanes_of(b)
