"""Recipe and footprint data.

Source of truth is the game's own prototype dump, produced by running
``factorio --dump-data`` with the game closed. That writes
``%APPDATA%\\Factorio\\script-output\\data-raw-dump.json`` (about 28 MB). The
``fbp gamedata`` command boils it down to ``data/gamedata.json`` (a few hundred
KB) which ships with the tool, so nothing needs the full dump at run time.

If neither file is available a small built-in table covers the recipes most
likely to matter in a mall; anything outside it is reported as unknown rather
than guessed.
"""
import json
import math
import os

HERE = os.path.dirname(os.path.abspath(__file__))
SLIM_PATH = os.path.join(os.path.dirname(HERE), "data", "gamedata.json")

# Minimal fallback. Values are Factorio 2.0.x. Kept short on purpose: this is a
# safety net, not a database.
FALLBACK = {
    "recipes": {
        "copper-cable": {"ingredients": {"copper-plate": 1}, "results": {"copper-cable": 2}},
        "iron-stick": {"ingredients": {"iron-plate": 1}, "results": {"iron-stick": 2}},
        "iron-gear-wheel": {"ingredients": {"iron-plate": 2}, "results": {"iron-gear-wheel": 1}},
        "electronic-circuit": {"ingredients": {"iron-plate": 1, "copper-cable": 3},
                               "results": {"electronic-circuit": 1}},
        "advanced-circuit": {"ingredients": {"electronic-circuit": 2, "plastic-bar": 2, "copper-cable": 4},
                             "results": {"advanced-circuit": 1}},
        "big-electric-pole": {"ingredients": {"iron-stick": 8, "steel-plate": 5, "copper-cable": 4},
                              "results": {"big-electric-pole": 1}},
        "medium-electric-pole": {"ingredients": {"iron-stick": 4, "steel-plate": 2, "copper-plate": 2},
                                 "results": {"medium-electric-pole": 1}},
        "substation": {"ingredients": {"steel-plate": 10, "advanced-circuit": 5, "copper-cable": 6},
                       "results": {"substation": 1}},
        "steel-plate": {"ingredients": {"iron-plate": 5}, "results": {"steel-plate": 1}, "category": "smelting"},
        "iron-plate": {"ingredients": {"iron-ore": 1}, "results": {"iron-plate": 1}, "category": "smelting"},
        "copper-plate": {"ingredients": {"copper-ore": 1}, "results": {"copper-plate": 1}, "category": "smelting"},
        "stone-brick": {"ingredients": {"stone": 2}, "results": {"stone-brick": 1}, "category": "smelting"},
    },
    "footprints": {},
    "source": "built-in fallback",
}


def _dump_path():
    env = os.environ.get("FBP_DATA_DUMP")
    if env:
        return env
    appdata = os.environ.get("APPDATA")
    if appdata:
        return os.path.join(appdata, "Factorio", "script-output", "data-raw-dump.json")
    return None


def _amounts(entries):
    out = {}
    for entry in entries or []:
        name = entry.get("name")
        if not name:
            continue
        amount = entry.get("amount")
        if amount is None:
            amount = entry.get("amount_max", entry.get("amount_min", 1))
        out[name] = out.get(name, 0) + amount
    return out


def slim_from_dump(dump):
    """Reduce a full data-raw dump to what the tool needs."""
    recipes = {}
    for name, r in dump.get("recipe", {}).items():
        rec = {"ingredients": _amounts(r.get("ingredients")), "results": _amounts(r.get("results"))}
        fluids = [i["name"] for i in r.get("ingredients") or [] if i.get("type") == "fluid"]
        if fluids:
            rec["fluid_ingredients"] = fluids
        fluid_results = [i["name"] for i in r.get("results") or [] if i.get("type") == "fluid"]
        if fluid_results:
            rec["fluid_results"] = fluid_results
        if r.get("category"):
            rec["category"] = r["category"]
        recipes[name] = rec
    footprints: dict = {}
    categories: dict = {}
    for protos in dump.values():
        if not isinstance(protos, dict):
            continue
        for name, p in protos.items():
            if not isinstance(p, dict):
                continue
            box = p.get("collision_box")
            if box and isinstance(box, list) and len(box) == 2:
                (x0, y0), (x1, y1) = box[0][:2], box[1][:2]
                w = max(1, int(math.ceil(round(x1 - x0, 3))))
                h = max(1, int(math.ceil(round(y1 - y0, 3))))
                if (w, h) != (1, 1):
                    footprints[name] = [w, h]
            if p.get("crafting_categories"):
                categories[name] = p["crafting_categories"]
    return {"recipes": recipes, "footprints": footprints, "crafting_categories": categories,
            "source": "factorio --dump-data"}


def build_slim(dump_path=None, out_path=SLIM_PATH):
    path = dump_path or _dump_path()
    if not path or not os.path.exists(path):
        raise FileNotFoundError("data-raw-dump.json not found; run `factorio --dump-data` with the game closed"
                                " or set FBP_DATA_DUMP")
    with open(path, encoding="utf-8") as handle:
        dump = json.load(handle)
    slim = slim_from_dump(dump)
    os.makedirs(os.path.dirname(out_path), exist_ok=True)
    with open(out_path, "w", encoding="utf-8") as handle:
        json.dump(slim, handle, indent=0, sort_keys=True)
    write_js(slim)
    return slim, out_path


JS_PATH = os.path.join(os.path.dirname(HERE), "vscode", "media", "gamedata.js")


def write_js(slim, js_path=JS_PATH):
    """The viewer loads game data with a <script> tag so it also works as a plain file in a browser,
    where fetch() of a sibling JSON file is blocked."""
    body = json.dumps({"recipes": slim["recipes"], "footprints": slim.get("footprints", {}),
                       "crafting_categories": slim.get("crafting_categories", {})},
                      separators=(",", ":"), sort_keys=True)
    with open(js_path, "w", encoding="utf-8") as handle:
        handle.write("// generated by `fbp gamedata` from data/gamedata.json; do not edit\nwindow.FBP_GAMEDATA = " + body + ";\n")
    return js_path


_CACHE = None


def load():
    """Return the game data table, preferring the slim file, then the dump, then the fallback."""
    global _CACHE
    if _CACHE is not None:
        return _CACHE
    if os.path.exists(SLIM_PATH):
        with open(SLIM_PATH, encoding="utf-8") as handle:
            _CACHE = json.load(handle)
        return _CACHE
    path = _dump_path()
    if path and os.path.exists(path):
        with open(path, encoding="utf-8") as handle:
            _CACHE = slim_from_dump(json.load(handle))
        return _CACHE
    _CACHE = FALLBACK
    return _CACHE


class GameData:
    def __init__(self, table=None):
        self.table = table or load()
        self.recipes = self.table["recipes"]
        self.source = self.table.get("source", "?")

    def known(self, recipe):
        return recipe in self.recipes

    def ingredients(self, recipe):
        """Item ingredients only (fluids arrive by pipe and are not traced)."""
        r = self.recipes.get(recipe)
        if not r:
            return None
        fluids = set(r.get("fluid_ingredients", []))
        return {k: v for k, v in r["ingredients"].items() if k not in fluids}

    def products(self, recipe):
        """Item products only."""
        r = self.recipes.get(recipe)
        if not r:
            return {recipe}
        fluids = set(r.get("fluid_results", []))
        return {k for k in r["results"] if k not in fluids} or ({recipe} if not fluids else set())

    def has_item_results(self, recipe):
        r = self.recipes.get(recipe)
        return r is None or bool(self.products(recipe))

    def smelted_items(self):
        return {p for name, r in self.recipes.items() if r.get("category") == "smelting" for p in r["results"]}

    def footprints(self):
        from .model import FOOTPRINT
        table = dict(FOOTPRINT)
        for name, wh in self.table.get("footprints", {}).items():
            table[name] = tuple(wh)
        return table
