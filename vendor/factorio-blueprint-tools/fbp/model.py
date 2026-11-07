"""Spatial model of a blueprint: footprints, a tile index, and inserter geometry.

Conventions (Factorio 2.0):
  * direction is 0..15 with 0 north, 4 east, 8 south, 12 west.
  * an inserter's direction points at its PICKUP tile; it drops on the opposite side.
  * long-handed inserters reach two tiles.
  * an entity's position is its centre; a 3x3 machine at (114.5, 77.5) covers
    x 113..115 and y 76..78.
"""
import math
from collections import defaultdict

DIRS = {0: (0, -1), 4: (1, 0), 8: (0, 1), 12: (-1, 0)}

# (width, height) when facing north. Anything not listed is 1x1. Overridden by
# collision boxes from the game data dump when one is available (see recipes.py).
FOOTPRINT = {
    "assembling-machine-1": (3, 3), "assembling-machine-2": (3, 3), "assembling-machine-3": (3, 3),
    "chemical-plant": (3, 3), "oil-refinery": (5, 5), "centrifuge": (3, 3), "lab": (3, 3),
    "beacon": (3, 3), "roboport": (4, 4), "radar": (3, 3), "rocket-silo": (9, 9),
    "stone-furnace": (2, 2), "steel-furnace": (2, 2), "electric-furnace": (3, 3),
    "storage-tank": (3, 3), "pumpjack": (3, 3), "electric-mining-drill": (3, 3),
    "big-mining-drill": (5, 5), "offshore-pump": (1, 2), "boiler": (3, 2), "steam-engine": (3, 5),
    "steam-turbine": (3, 5), "heat-exchanger": (3, 2), "nuclear-reactor": (5, 5),
    "big-electric-pole": (2, 2), "substation": (2, 2), "accumulator": (2, 2), "solar-panel": (3, 3),
    "splitter": (2, 1), "fast-splitter": (2, 1), "express-splitter": (2, 1), "turbo-splitter": (2, 1),
    "train-stop": (2, 2), "gun-turret": (2, 2), "laser-turret": (2, 2), "flamethrower-turret": (2, 3),
    "artillery-turret": (3, 3), "recycler": (2, 3), "electromagnetic-plant": (4, 4), "foundry": (4, 4),
    "biochamber": (3, 3), "cryogenic-plant": (5, 5), "agricultural-tower": (3, 3),
    "cargo-landing-pad": (8, 8), "space-platform-hub": (8, 8),
}
# Rails and rolling stock have footprints the tool does not model; they are indexed at one tile.
UNMODELLED = {"legacy-straight-rail", "legacy-curved-rail", "straight-rail", "curved-rail-a",
              "curved-rail-b", "half-diagonal-rail", "cargo-wagon", "locomotive", "fluid-wagon",
              "artillery-wagon", "elevated-straight-rail", "rail-ramp", "rail-support"}

BELTS = {"transport-belt", "fast-transport-belt", "express-transport-belt", "turbo-transport-belt",
         "underground-belt", "fast-underground-belt", "express-underground-belt", "turbo-underground-belt",
         "splitter", "fast-splitter", "express-splitter", "turbo-splitter"}
UNDERGROUND_REACH = {"underground-belt": 5, "fast-underground-belt": 7,
                     "express-underground-belt": 9, "turbo-underground-belt": 11}
INSERTERS = {"inserter", "fast-inserter", "long-handed-inserter", "bulk-inserter", "stack-inserter",
             "burner-inserter"}
CRAFTERS = {"assembling-machine-1", "assembling-machine-2", "assembling-machine-3", "chemical-plant",
            "oil-refinery", "centrifuge", "electromagnetic-plant", "foundry", "biochamber",
            "cryogenic-plant", "recycler"}
FURNACES = {"stone-furnace", "steel-furnace", "electric-furnace"}
CHESTS = {"wooden-chest", "iron-chest", "steel-chest", "passive-provider-chest", "active-provider-chest",
          "storage-chest", "buffer-chest", "requester-chest"}
POLES = {"small-electric-pole", "medium-electric-pole", "big-electric-pole", "substation"}


def kind(e):
    n = e["name"]
    if n in BELTS:
        return "belt"
    if n in INSERTERS:
        return "inserter"
    if n in CRAFTERS:
        return "crafter"
    if n in FURNACES:
        return "furnace"
    if n in CHESTS:
        return "chest"
    if n in POLES:
        return "pole"
    return "other"


def is_underground(e):
    return e["name"] in UNDERGROUND_REACH


def is_splitter(e):
    return e["name"].endswith("splitter")


def footprint(e, table=None):
    """Return the list of integer tiles covered by entity e."""
    p = e["position"]
    w, h = (table or FOOTPRINT).get(e["name"], (1, 1))
    if e.get("direction", 0) in (4, 12):
        w, h = h, w
    x0 = int(math.floor(p["x"] - w / 2.0))
    y0 = int(math.floor(p["y"] - h / 2.0))
    return [(x0 + dx, y0 + dy) for dx in range(w) for dy in range(h)]


def tile_of(e):
    p = e["position"]
    return (int(math.floor(p["x"])), int(math.floor(p["y"])))


def inserter_ends(e):
    """(pickup_tile, drop_tile) for an inserter entity."""
    dx, dy = DIRS[e.get("direction", 0) & 12]
    reach = 2 if e["name"] == "long-handed-inserter" else 1
    x, y = tile_of(e)
    return (x + dx * reach, y + dy * reach), (x - dx * reach, y - dy * reach)


class Grid:
    """Tile index over one blueprint's entities."""

    def __init__(self, bp, footprints=None):
        self.bp = bp
        self.footprints = footprints or FOOTPRINT
        self.entities = bp.get("entities", [])
        self.byid = {e["entity_number"]: e for e in self.entities}
        self.tiles = defaultdict(list)
        self.cells = {}
        for e in self.entities:
            cells = footprint(e, self.footprints)
            self.cells[e["entity_number"]] = cells
            for c in cells:
                self.tiles[c].append(e)

    def at(self, x, y, exclude_kinds=()):
        return [e for e in self.tiles.get((x, y), []) if kind(e) not in exclude_kinds]

    def belt_at(self, x, y):
        for e in self.tiles.get((x, y), []):
            if e["name"] in BELTS:
                return e
        return None

    def cells_of(self, e):
        return self.cells[e["entity_number"]]

    def bbox(self):
        xs = [c[0] for cells in self.cells.values() for c in cells]
        ys = [c[1] for cells in self.cells.values() for c in cells]
        return min(xs), min(ys), max(xs), max(ys)

    def describe(self, e):
        p = e["position"]
        s = "%s#%d@(%g,%g)" % (e["name"], e["entity_number"], p["x"], p["y"])
        if e.get("recipe"):
            s += " [%s]" % e["recipe"]
        return s

    def collisions(self, new_entity):
        """Entities already occupying any tile the new entity would cover."""
        hits = []
        for c in footprint(new_entity, self.footprints):
            hits.extend(self.tiles.get(c, []))
        return hits

    def find(self, name=None, recipe=None):
        for e in self.entities:
            if name and e["name"] != name:
                continue
            if recipe and e.get("recipe") != recipe:
                continue
            yield e
