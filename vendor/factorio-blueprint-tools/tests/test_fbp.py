"""Tests against tests/fixtures/mall.txt, a crop of a real 2.0.77 mall.

The fixture contains a big-electric-pole assembler fed copper plate (the 2.0.7
recipe wants copper cable) with a steel-furnace assembler directly north of it.
"""
import json
import os

import pytest

from fbp import codec, gamedata, patch, render
from fbp.check import check
from fbp.model import Grid, footprint, inserter_ends
from fbp.trace import Tracer

HERE = os.path.dirname(os.path.abspath(__file__))
FIXTURE = os.path.join(HERE, "fixtures", "mall.txt")


@pytest.fixture
def gd():
    return gamedata.GameData()


@pytest.fixture
def bp():
    return codec.first_blueprint(codec.load(FIXTURE))


def by_pos(grid, name, x, y):
    for e in grid.find(name=name):
        if e["position"] == {"x": x, "y": y}:
            return e
    raise AssertionError("no %s at (%s,%s)" % (name, x, y))


def by_recipe(grid, recipe):
    found = list(grid.find(recipe=recipe))
    assert len(found) == 1, recipe
    return found[0]


# -- codec -----------------------------------------------------------------

def test_roundtrip_is_lossless():
    text = open(FIXTURE, encoding="utf-8").read().strip()
    obj = codec.decode(text)
    again = codec.decode(codec.encode(obj))
    assert obj == again
    assert codec.encode(obj)[0] == "0"


def test_version_decodes(bp):
    assert codec.game_version(bp) == "2.0.77"


def test_book_wraps_and_indexes(bp):
    book = codec.make_book("Test book", [{"blueprint": bp}, {"blueprint": dict(bp, label="two")}])
    paths = [p for p, _ in codec.blueprints(book)]
    assert paths == [("Test book", "Mall fixture"), ("Test book", "two")]
    assert [e["index"] for e in book["blueprint_book"]["blueprints"]] == [0, 1]


# -- model -----------------------------------------------------------------

def test_footprint_centres():
    asm = {"name": "assembling-machine-1", "position": {"x": 114.5, "y": 77.5}}
    assert set(footprint(asm)) == {(x, y) for x in (113, 114, 115) for y in (76, 77, 78)}
    pole = {"name": "big-electric-pole", "position": {"x": -6, "y": -6}}
    assert set(footprint(pole)) == {(-7, -7), (-6, -7), (-7, -6), (-6, -6)}
    belt = {"name": "transport-belt", "position": {"x": 111.5, "y": 79.5}}
    assert footprint(belt) == [(111, 79)]
    splitter = {"name": "splitter", "position": {"x": 111, "y": 75.5}, "direction": 0}
    assert set(footprint(splitter)) == {(110, 75), (111, 75)}


def test_inserter_direction_points_at_pickup():
    ins = {"name": "inserter", "position": {"x": 112.5, "y": 80.5}, "direction": 4}
    assert inserter_ends(ins) == ((113, 80), (111, 80))
    long = {"name": "long-handed-inserter", "position": {"x": 111.5, "y": 79.5}, "direction": 12}
    assert inserter_ends(long) == ((109, 79), (113, 79))


def test_gamedata_has_2_0_recipes(gd):
    assert gd.ingredients("big-electric-pole")["copper-cable"] == 4
    assert gd.ingredients("substation")["copper-cable"] == 6
    assert "sulfuric-acid" not in gd.ingredients("processing-unit")  # fluids are not traced
    assert gd.products("copper-cable") == {"copper-cable"}
    assert "iron-plate" in gd.smelted_items()


# -- trace -----------------------------------------------------------------

def test_trace_big_pole_inputs(bp, gd):
    grid = Grid(bp, gd.footprints())
    tr = Tracer(grid, gd)
    pole = by_recipe(grid, "big-electric-pole")
    inputs, outputs = tr.machine_io(pole)
    items = set().union(*(i["items"] for i in inputs))
    assert "iron-stick" in items            # direct from the iron-stick assembler
    assert "copper-cable" not in items      # the bug
    # the plate belts leave the cropped area, so they are unknown, not empty
    belt_inputs = [i for i in inputs if "line" in i]
    assert len(belt_inputs) == 2 and all(i["unknown"] for i in belt_inputs)
    assert len(outputs) == 1 and outputs[0]["targets"][0]["name"] == "steel-chest"


def test_underground_pairs_are_followed(bp, gd):
    grid = Grid(bp, gd.footprints())
    tr = Tracer(grid, gd)
    entrance = by_pos(grid, "underground-belt", 109.5, 84.5)
    exit_ = by_pos(grid, "underground-belt", 109.5, 79.5)
    assert tr.underground_pair(entrance) is exit_
    assert tr.upstream(exit_) == [entrance]


# -- check -----------------------------------------------------------------

def test_check_big_pole_is_inconclusive_in_cropped_fixture(bp, gd):
    # The crop severs the main bus, so its belts are fed from outside the print
    # and the tool must say "inconclusive", not "problem".
    grid = Grid(bp, gd.footprints())
    findings, inconclusive, unknown = check(grid, gd, recipe="big-electric-pole")
    assert findings == []
    assert len(inconclusive) == 1
    assert set(inconclusive[0]["missing"]) == {"copper-cable", "steel-plate"}
    assert unknown == []


def synthetic():
    """A big-pole assembler fed iron sticks directly and plates from a furnace, no copper cable."""
    ents = [
        {"entity_number": 1, "name": "assembling-machine-1", "position": {"x": 5.5, "y": 5.5},
         "recipe": "big-electric-pole"},
        {"entity_number": 2, "name": "assembling-machine-1", "position": {"x": 1.5, "y": 5.5}, "recipe": "iron-stick"},
        {"entity_number": 3, "name": "inserter", "position": {"x": 3.5, "y": 5.5}, "direction": 12},
        {"entity_number": 4, "name": "stone-furnace", "position": {"x": 5, "y": 2}},
        {"entity_number": 5, "name": "inserter", "position": {"x": 4.5, "y": 3.5}, "direction": 0},
        {"entity_number": 6, "name": "inserter", "position": {"x": 7.5, "y": 5.5}, "direction": 12},
        {"entity_number": 7, "name": "iron-chest", "position": {"x": 8.5, "y": 5.5}},
    ]
    return {"entities": ents, "wires": []}


def test_check_reports_definite_problem(gd):
    grid = Grid(synthetic(), gd.footprints())
    findings, inconclusive, unknown = check(grid, gd, recipe="big-electric-pole")
    assert [f["missing"] for f in findings] == [["copper-cable"]]
    assert inconclusive == []


def test_check_passes_when_cable_arrives(gd):
    bp = synthetic()
    bp["entities"][1]["recipe"] = "copper-cable"          # sticks no longer arrive, cable does
    bp["entities"].append({"entity_number": 8, "name": "assembling-machine-1",
                           "position": {"x": 5.5, "y": 9.5}, "recipe": "iron-stick"})
    bp["entities"].append({"entity_number": 9, "name": "inserter", "position": {"x": 5.5, "y": 7.5},
                           "direction": 8})
    grid = Grid(bp, gd.footprints())
    findings, inconclusive, unknown = check(grid, gd, recipe="big-electric-pole")
    assert findings == [] and inconclusive == []


def test_check_does_not_flag_fluid_only_machines(gd):
    bp = {"entities": [{"entity_number": 1, "name": "chemical-plant", "position": {"x": 1.5, "y": 1.5},
                        "recipe": "sulfur"}], "wires": []}
    grid = Grid(bp, gd.footprints())
    findings, inconclusive, unknown = check(grid, gd)
    assert findings == [] or all(f["reason"] != "no input inserters" for f in findings)


# -- patch -----------------------------------------------------------------

def test_patch_fixes_big_pole(bp, gd):
    grid = Grid(bp, gd.footprints())
    pole = by_recipe(grid, "big-electric-pole")
    cable_asm = by_recipe(grid, "steel-furnace")
    p = {
        "remove": [by_pos(grid, "long-handed-inserter", 111.5, 79.5)["entity_number"],
                   by_pos(grid, "long-handed-inserter", 117.5, 77.5)["entity_number"],
                   by_pos(grid, "inserter", 116.5, 78.5)["entity_number"],
                   by_pos(grid, "steel-chest", 111.5, 77.5)["entity_number"]],
        "recipe": {str(cable_asm["entity_number"]): "copper-cable"},
        "add": [
            {"name": "inserter", "position": {"x": 113.5, "y": 75.5}, "direction": 0},
            {"name": "transport-belt", "position": {"x": 111.5, "y": 77.5}, "direction": 8},
            {"name": "transport-belt", "position": {"x": 111.5, "y": 78.5}, "direction": 8},
            {"name": "transport-belt", "position": {"x": 111.5, "y": 79.5}, "direction": 4},
            {"name": "inserter", "position": {"x": 112.5, "y": 79.5}, "direction": 12},
        ],
    }
    before = len(bp["entities"])
    log = []
    patch.apply(bp, p, gd.footprints(), log)
    assert len(bp["entities"]) == before - 4 + 5
    assert [e["entity_number"] for e in bp["entities"]] == list(range(1, len(bp["entities"]) + 1))
    grid2 = Grid(bp, gd.footprints())
    findings, inconclusive, _ = check(grid2, gd, recipe="big-electric-pole")
    assert findings == []
    # cable now has a definite adjacent source; only the severed steel belt stays unknown
    assert [f["missing"] for f in inconclusive] == [["steel-plate"]]
    assert any("copper-cable" in line for line in log)


def test_patch_refuses_collisions(bp, gd):
    with pytest.raises(patch.PatchError):
        patch.apply(bp, {"add": [{"name": "inserter", "position": {"x": 114.5, "y": 80.5}}]}, gd.footprints())


def test_patch_refuses_stranding_wires(bp, gd):
    wired = {bp["wires"][0][0]} if bp.get("wires") else set()
    if not wired:
        pytest.skip("fixture has no wires")
    with pytest.raises(patch.PatchError):
        patch.apply(bp, {"remove": list(wired)}, gd.footprints())


def test_crop_keeps_only_fully_inside(bp, gd):
    new = patch.crop(bp, 104, 76, 122, 86, gd.footprints())
    grid = Grid(new, gd.footprints())
    x0, y0, x1, y1 = grid.bbox()
    assert x0 >= 104 and y0 >= 76 and x1 <= 122 and y1 <= 86
    assert [e["entity_number"] for e in new["entities"]] == list(range(1, len(new["entities"]) + 1))


# -- render ----------------------------------------------------------------

def test_ascii_render_marks_machines_and_belts(bp, gd):
    grid = Grid(bp, gd.footprints())
    text = render.ascii_region(grid, 108, 74, 118, 82)
    assert "A" in text and ">" in text and "i" in text
    assert text.splitlines()[1].startswith("  74 ")


# -- lint / lane mix / diff -------------------------------------------------

from fbp.lint import lint
from fbp.check import lane_mix, drop_lane


def test_lint_geometry(gd):
    bp = {"entities": [
        {"entity_number": 1, "name": "transport-belt", "position": {"x": 0.5, "y": 0.5}, "direction": 4},   # dead end
        {"entity_number": 2, "name": "underground-belt", "position": {"x": 5.5, "y": 0.5}, "direction": 8, "type": "input"},
        {"entity_number": 3, "name": "inserter", "position": {"x": 8.5, "y": 8.5}, "direction": 0},           # nothing either side
        {"entity_number": 4, "name": "transport-belt", "position": {"x": 0.5, "y": 5.5}, "direction": 4},   # into a chest
        {"entity_number": 5, "name": "iron-chest", "position": {"x": 1.5, "y": 5.5}},
        {"entity_number": 6, "name": "transport-belt", "position": {"x": 0.5, "y": 9.5}, "direction": 4},   # terminal, picked
        {"entity_number": 7, "name": "inserter", "position": {"x": 0.5, "y": 10.5}, "direction": 0},
        {"entity_number": 8, "name": "iron-chest", "position": {"x": 0.5, "y": 11.5}},
    ], "wires": []}
    codes = sorted(code for code, e, msg in lint(Grid(bp, gd.footprints())))
    assert codes == ["belt-dead-end", "belt-into-entity", "inserter-from-empty", "inserter-to-ground", "underground-unpaired"]


def test_drop_lane_is_far_side():
    belt = {"name": "transport-belt", "position": {"x": 3.5, "y": 3.5}, "direction": 8}   # travelling south
    east = {"name": "inserter", "position": {"x": 4.5, "y": 3.5}, "direction": 4}           # stands east, drops west onto belt
    west = {"name": "inserter", "position": {"x": 2.5, "y": 3.5}, "direction": 12}
    # travelling south: left lane is the east side. Inserter on the east drops on the far = west = right lane.
    assert drop_lane(east, belt) == "right"
    assert drop_lane(west, belt) == "left"


def test_lane_mix_flags_second_item_on_a_lane(gd):
    # A belt running south; a copper-cable maker and an iron-stick maker both drop from the east onto the same lane.
    bp = {"entities": [
        {"entity_number": 1, "name": "transport-belt", "position": {"x": 3.5, "y": 1.5}, "direction": 8},
        {"entity_number": 2, "name": "transport-belt", "position": {"x": 3.5, "y": 2.5}, "direction": 8},
        {"entity_number": 3, "name": "transport-belt", "position": {"x": 3.5, "y": 3.5}, "direction": 8},
        {"entity_number": 4, "name": "transport-belt", "position": {"x": 3.5, "y": 4.5}, "direction": 8},
        {"entity_number": 5, "name": "assembling-machine-1", "position": {"x": 6.5, "y": 1.5}, "recipe": "copper-cable"},
        {"entity_number": 6, "name": "inserter", "position": {"x": 4.5, "y": 1.5}, "direction": 4},
        {"entity_number": 7, "name": "assembling-machine-1", "position": {"x": 6.5, "y": 4.5}, "recipe": "iron-stick"},
        {"entity_number": 8, "name": "inserter", "position": {"x": 4.5, "y": 4.5}, "direction": 4},
    ], "wires": []}
    w = lane_mix(Grid(bp, gd.footprints()), gd)
    assert len(w) == 1 and w[0]["lane"] == "right" and set(w[0]["items"]) == {"copper-cable", "iron-stick"}
    # move the stick inserter to the west side: now one item per lane, no warning
    bp["entities"][7]["position"] = {"x": 2.5, "y": 4.5}; bp["entities"][7]["direction"] = 12
    bp["entities"][6]["position"] = {"x": 0.5, "y": 4.5}
    assert lane_mix(Grid(bp, gd.footprints()), gd) == []


def test_diff_reports_only_changed_machines(bp, gd):
    import copy
    from fbp.diff import compare
    before = copy.deepcopy(bp)
    grid = Grid(bp, gd.footprints())
    cable_asm = by_recipe(grid, "steel-furnace")
    patch.apply(bp, {"recipe": {str(cable_asm["entity_number"]): "copper-cable"}}, gd.footprints())
    text, changed, regressions = compare(before, bp, gd)
    assert changed == 1 and "steel-furnace -> copper-cable" in text
    assert "REMOVED" not in text and "ADDED" not in text


# -- flow --------------------------------------------------------------------

from fbp.flow import Flow, UNKNOWN_SMELT


def flow_bp():
    """Ore belt (west->east along y=1) -> inserter -> furnace -> inserter -> plate belt (east along y=5),
    plus a gear assembler pulling from the plate belt and dropping gears on a third belt."""
    ents = [
        {"entity_number": 1, "name": "transport-belt", "position": {"x": 0.5, "y": 1.5}, "direction": 4},
        {"entity_number": 2, "name": "transport-belt", "position": {"x": 1.5, "y": 1.5}, "direction": 4},
        {"entity_number": 3, "name": "transport-belt", "position": {"x": 2.5, "y": 1.5}, "direction": 4},
        {"entity_number": 4, "name": "inserter", "position": {"x": 1.5, "y": 2.5}, "direction": 0},   # picks belt (1,1), drops (1,3)
        {"entity_number": 5, "name": "stone-furnace", "position": {"x": 2, "y": 4}},                   # covers 1-2, 3-4
        {"entity_number": 6, "name": "inserter", "position": {"x": 1.5, "y": 5.5}, "direction": 0},   # picks furnace (1,4), drops (1,6)
        {"entity_number": 7, "name": "transport-belt", "position": {"x": 1.5, "y": 6.5}, "direction": 4},
        {"entity_number": 8, "name": "transport-belt", "position": {"x": 2.5, "y": 6.5}, "direction": 4},
        {"entity_number": 9, "name": "transport-belt", "position": {"x": 3.5, "y": 6.5}, "direction": 4},
        {"entity_number": 10, "name": "inserter", "position": {"x": 3.5, "y": 7.5}, "direction": 0},  # picks (3,6), drops (3,8)
        {"entity_number": 11, "name": "assembling-machine-1", "position": {"x": 3.5, "y": 9.5}, "recipe": "iron-gear-wheel"},
        {"entity_number": 12, "name": "inserter", "position": {"x": 3.5, "y": 11.5}, "direction": 0}, # picks (3,10), drops (3,12)
        {"entity_number": 13, "name": "transport-belt", "position": {"x": 3.5, "y": 12.5}, "direction": 4},
    ]
    return {"entities": ents, "wires": []}


def test_flow_unknown_without_feed(gd):
    f = Flow(Grid(flow_bp(), gd.footprints()), gd).run()
    assert f.lanes_of(f.g.byid[8]) == {"left": set(), "right": {UNKNOWN_SMELT}}
    status, _ = f.machine_status(f.g.byid[11])
    assert status == "unknown"


def test_flow_resolves_with_edge_feed(gd):
    f = Flow(Grid(flow_bp(), gd.footprints()), gd, feeds=[{"x": 0, "y": 1, "items": ["iron-ore"], "lane": "both"}]).run()
    plate = f.lanes_of(f.g.byid[9])
    assert "iron-plate" in plate["left"] | plate["right"] and UNKNOWN_SMELT not in plate["left"] | plate["right"]
    assert f.machine_out[11] == {"iron-gear-wheel"}
    assert f.machine_status(f.g.byid[11]) == ("ok", [])
    gears = f.lanes_of(f.g.byid[13])
    assert "iron-gear-wheel" in gears["left"] | gears["right"]


def test_flow_inserter_drops_on_far_lane(gd):
    # east-travelling belt: left lane is north. Inserter 6 stands NORTH of belt 7 (it drops southward onto it),
    # so its items land on the far = south = right lane.
    f = Flow(Grid(flow_bp(), gd.footprints()), gd, feeds=[{"x": 0, "y": 1, "items": ["iron-ore"], "lane": "both"}]).run()
    plate = f.lanes_of(f.g.byid[7])
    assert plate["right"] == {"iron-plate"} and plate["left"] == set()


def test_flow_sideload_lands_on_near_lane(gd):
    # a north belt at x=5 fed from the west by an east belt carrying gears on both lanes (sideload, since a belt behind it exists)
    bp = {"entities": [
        {"entity_number": 1, "name": "transport-belt", "position": {"x": 5.5, "y": 6.5}, "direction": 0},
        {"entity_number": 2, "name": "transport-belt", "position": {"x": 5.5, "y": 5.5}, "direction": 0},
        {"entity_number": 3, "name": "transport-belt", "position": {"x": 5.5, "y": 4.5}, "direction": 0},
        {"entity_number": 4, "name": "transport-belt", "position": {"x": 4.5, "y": 5.5}, "direction": 4},
    ], "wires": []}
    feeds = [{"x": 4, "y": 5, "items": ["iron-gear-wheel"], "lane": "both"}, {"x": 5, "y": 6, "items": ["pipe"], "lane": "both"}]
    f = Flow(Grid(bp, gd.footprints()), gd, feeds).run()
    top = f.lanes_of(f.g.byid[3])
    # travelling north, the west side is the LEFT lane: gears sideload onto left only; pipes stay on both
    assert top["left"] == {"iron-gear-wheel", "pipe"} and top["right"] == {"pipe"}


def test_flow_curve_keeps_lanes(gd):
    bp = {"entities": [
        {"entity_number": 1, "name": "transport-belt", "position": {"x": 4.5, "y": 5.5}, "direction": 4},
        {"entity_number": 2, "name": "transport-belt", "position": {"x": 5.5, "y": 5.5}, "direction": 0},   # curve: nothing behind it
        {"entity_number": 3, "name": "transport-belt", "position": {"x": 5.5, "y": 4.5}, "direction": 0},
    ], "wires": []}
    f = Flow(Grid(bp, gd.footprints()), gd, [{"x": 4, "y": 5, "items": ["pipe"], "lane": "left"}]).run()
    assert f.lanes_of(f.g.byid[3]) == {"left": {"pipe"}, "right": set()}


def test_js_flow_matches_python(gd, tmp_path):
    """vscode/media/flow.js is a port of fbp/flow.py; they must agree on a real print with feeds."""
    import shutil, subprocess
    node = shutil.which("node")
    if not node:
        pytest.skip("node not available")
    feeds = [{"x": 109, "y": 84, "items": ["iron-plate", "copper-plate"], "lane": "both"},
             {"x": 103, "y": 76, "items": ["steel-plate"], "lane": "both"}]
    fpath = tmp_path / "f.json"; fpath.write_text(json.dumps(feeds))
    root = os.path.dirname(HERE)
    js = subprocess.run([node, os.path.join(root, "vscode", "media", "flow_cli.js"), FIXTURE,
                         os.path.join(root, "data", "gamedata.json"), str(fpath)], capture_output=True, text=True, check=True)
    a = json.loads(js.stdout)
    bp = codec.first_blueprint(codec.load(FIXTURE))
    b = Flow(Grid(bp, gd.footprints()), gd, feeds).run().as_json()
    assert a["lanes"] == b["lanes"]
    assert a["machines"] == b["machines"]
    assert a["chests"] == b["chests"]


def test_flow_long_inserter_drops_on_far_lane(gd):
    # eastbound belt; a long-handed inserter two tiles SOUTH drops on the far = north = left lane
    bp = {"entities": [
        {"entity_number": 1, "name": "transport-belt", "position": {"x": 5.5, "y": 2.5}, "direction": 4},
        {"entity_number": 2, "name": "transport-belt", "position": {"x": 6.5, "y": 2.5}, "direction": 4},
        {"entity_number": 3, "name": "long-handed-inserter", "position": {"x": 5.5, "y": 4.5}, "direction": 8},   # picks (5,6), drops (5,2)
        {"entity_number": 4, "name": "assembling-machine-1", "position": {"x": 5.5, "y": 7.5}, "recipe": "battery"},
    ], "wires": []}
    f = Flow(Grid(bp, gd.footprints()), gd).run()
    assert f.lanes_of(f.g.byid[2]) == {"left": {"battery"}, "right": set()}


def test_flow_sideload_into_underground_exit_passes_one_lane(gd):
    # A southbound belt carrying frames (right/west lane) and batteries (left/east lane) runs into the side of a
    # west-facing underground EXIT. Only the west half of the exit is open belt, so frames pass and batteries stop.
    bp = {"entities": [
        {"entity_number": 1, "name": "transport-belt", "position": {"x": 4.5, "y": 1.5}, "direction": 8},
        {"entity_number": 2, "name": "transport-belt", "position": {"x": 4.5, "y": 2.5}, "direction": 8},
        {"entity_number": 3, "name": "underground-belt", "position": {"x": 8.5, "y": 3.5}, "direction": 12, "type": "input"},
        {"entity_number": 4, "name": "underground-belt", "position": {"x": 4.5, "y": 3.5}, "direction": 12, "type": "output"},
        {"entity_number": 5, "name": "transport-belt", "position": {"x": 3.5, "y": 3.5}, "direction": 12},
    ], "wires": []}
    feeds = [{"x": 4, "y": 1, "items": ["flying-robot-frame"], "lane": "right"}, {"x": 4, "y": 1, "items": ["battery"], "lane": "left"}]
    f = Flow(Grid(bp, gd.footprints()), gd, feeds).run()
    out = f.lanes_of(f.g.byid[5])
    assert "flying-robot-frame" in out["left"] | out["right"]
    assert "battery" not in out["left"] | out["right"]
    # the exit still receives through its tunnel
    f2 = Flow(Grid(bp, gd.footprints()), gd, [{"x": 8, "y": 3, "items": ["pipe"], "lane": "both"}]).run()
    assert "pipe" in f2.lanes_of(f2.g.byid[5])["left"]


def test_flow_head_on_belts_do_not_connect(gd):
    # Row 90 of the base: belts run WEST head-on into the hood of an EAST-facing underground entrance, while a
    # northbound belt sideloads iron into the entrance's south side. In game the westbound copper piles up at
    # the end of its belt and never enters the tunnel; the exit carries iron on its right lane and nothing else.
    bp = {"entities": [
        {"entity_number": 1, "name": "underground-belt", "position": {"x": 4.5, "y": 3.5}, "direction": 4, "type": "input"},
        {"entity_number": 2, "name": "underground-belt", "position": {"x": 8.5, "y": 3.5}, "direction": 4, "type": "output"},
        {"entity_number": 3, "name": "transport-belt", "position": {"x": 5.5, "y": 3.5}, "direction": 12},   # head-on into the hood
        {"entity_number": 4, "name": "transport-belt", "position": {"x": 6.5, "y": 3.5}, "direction": 12},
        {"entity_number": 5, "name": "transport-belt", "position": {"x": 4.5, "y": 4.5}, "direction": 0},    # sideloads from the south
        {"entity_number": 6, "name": "transport-belt", "position": {"x": 9.5, "y": 3.5}, "direction": 4},
    ], "wires": []}
    feeds = [{"x": 6, "y": 3, "items": ["copper-plate"], "lane": "both"}, {"x": 4, "y": 4, "items": ["iron-plate"], "lane": "left"}]
    f = Flow(Grid(bp, gd.footprints()), gd, feeds).run()
    for eid in (1, 2, 6):
        L = f.lanes_of(f.g.byid[eid])
        assert "copper-plate" not in L["left"] | L["right"], eid
    assert f.lanes_of(f.g.byid[6]) == {"left": set(), "right": {"iron-plate"}}
    tr = Tracer(f.g, gd)
    assert tr.downstream(f.g.byid[3]) == []          # the westbound belt dead-ends
    assert f.g.byid[3] not in tr.upstream(f.g.byid[1])

    # Plain belts facing each other: neither feeds the other.
    bp2 = {"entities": [
        {"entity_number": 1, "name": "transport-belt", "position": {"x": 0.5, "y": 0.5}, "direction": 4},
        {"entity_number": 2, "name": "transport-belt", "position": {"x": 1.5, "y": 0.5}, "direction": 12},
    ], "wires": []}
    f2 = Flow(Grid(bp2, gd.footprints()), gd, [{"x": 0, "y": 0, "items": ["coal"], "lane": "both"}]).run()
    assert f2.lanes_of(f2.g.byid[2]) == {"left": set(), "right": set()}
    assert Tracer(f2.g, gd).downstream(f2.g.byid[1]) == []


def test_icons_collects_every_item_like_prototype():
    """Science packs are `tool`, ammo is `ammo`, modules are `module`: an item group is anything
    whose prototypes carry a stack size, so none of them need listing by name."""
    from fbp import icons
    dump = {
        "item": {"iron-plate": {"icon": "__base__/a.png", "icon_size": 64, "stack_size": 100}},
        "tool": {"automation-science-pack": {"icon": "__base__/b.png", "icon_size": 64, "stack_size": 200}},
        "ammo": {"firearm-magazine": {"icon": "__base__/c.png", "stack_size": 200}},
        "module": {"speed-module": {"icon": "__base__/d.png", "stack_size": 50}},
        "fluid": {"lubricant": {"icon": "__base__/e.png"}},
        "radar": {"radar": {"icon": "__base__/f.png", "icon_size": 64}},
        "technology": {"automation-science-pack": {"icon": "__base__/wrong.png"}},   # same name, tech artwork
        "recipe": {"iron-plate": {"icon": "__base__/wrong.png"}},
        "tile": {"concrete": {"icon": "__base__/g.png"}},
    }
    got = icons.collect(dump)
    for name in ("iron-plate", "automation-science-pack", "firearm-magazine", "speed-module", "lubricant", "radar"):
        assert name in got, name
    assert "concrete" not in got                       # tiles are not items and the viewer never draws them
    assert got["automation-science-pack"][0] == "__base__/b.png"   # the item icon, not the technology's
    assert got["iron-plate"][0] == "__base__/a.png"                # the item icon, not the recipe's
    assert got["firearm-magazine"][1] == 64                        # default icon size when the proto omits it


def test_icons_layered_icon_uses_first_layer():
    from fbp import icons
    assert icons.icon_of({"icons": [{"icon": "__base__/a.png", "icon_size": 32}, {"icon": "__base__/b.png"}]}) == ("__base__/a.png", 32)
    assert icons.icon_of({"icon": "__base__/c.png"}) == ("__base__/c.png", 64)
    assert icons.icon_of({}) == (None, 64)
