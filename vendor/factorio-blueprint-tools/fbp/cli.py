"""Command line interface. Run `fbp -h` or `python -m fbp -h`."""
import argparse
import json
import os
import sys
from collections import Counter

from . import __version__, codec, gamedata, patch, render
from .check import check, format_report
from .model import Grid, kind
from .trace import Tracer


def _grid(path, gd):
    obj = codec.load(path)
    bp = codec.first_blueprint(obj)
    return obj, bp, Grid(bp, gd.footprints())


def cmd_info(a, gd):
    obj = codec.load(a.file)
    for path, bp in codec.blueprints(obj):
        grid = Grid(bp, gd.footprints())
        ents = bp.get("entities", [])
        print("%s  game %s  entities %d  tiles %d  wires %d  bbox %s" %
              (" / ".join(p or "(unnamed)" for p in path), codec.game_version(bp), len(ents),
               len(bp.get("tiles", [])), len(bp.get("wires", [])), grid.bbox() if ents else "-"))
        if a.counts:
            for name, n in Counter(e["name"] for e in ents).most_common():
                print("  %5d %s" % (n, name))
        if a.recipes:
            for rec, n in Counter(e.get("recipe") for e in ents if e.get("recipe")).most_common():
                print("  %3d %s" % (n, rec))


def cmd_decode(a, gd):
    obj = codec.load(a.file)
    text = json.dumps(obj, indent=1)
    if a.out:
        open(a.out, "w", encoding="utf-8").write(text)
        print("wrote", a.out)
    else:
        print(text)


def cmd_encode(a, gd):
    obj = json.load(open(a.file, encoding="utf-8"))
    text = codec.encode(obj)
    if a.out:
        open(a.out, "w", encoding="utf-8").write(text)
        print("wrote %s (%d chars)" % (a.out, len(text)))
    else:
        print(text)


def cmd_render(a, gd):
    obj, bp, grid = _grid(a.file, gd)
    if a.png:
        print("wrote", render.png(grid, a.png, a.scale, a.x0, a.y0, a.x1, a.y1))
        return
    if None in (a.x0, a.y0, a.x1, a.y1):
        a.x0, a.y0, a.x1, a.y1 = grid.bbox()
    print(render.ascii_region(grid, a.x0, a.y0, a.x1, a.y1, legend=not a.no_legend))
    if a.entities:
        print()
        print(render.listing(grid, a.x0, a.y0, a.x1, a.y1))


def cmd_find(a, gd):
    obj, bp, grid = _grid(a.file, gd)
    for e in grid.find(name=a.name, recipe=a.recipe):
        extra = {k: v for k, v in e.items() if k not in ("entity_number", "name", "position", "recipe", "recipe_quality")}
        print(grid.describe(e), json.dumps(extra) if a.verbose and extra else "")


def cmd_trace(a, gd):
    obj, bp, grid = _grid(a.file, gd)
    tr = Tracer(grid, gd)
    if a.at:
        x, y = a.at
        b = grid.belt_at(x, y)
        if not b:
            sys.exit("no belt at (%d,%d)" % (x, y))
        print("belt", grid.describe(b), "direction", b.get("direction", 0))
        print("upstream  :", json.dumps(tr.summarize_line(b), default=str))
        belts, cells = tr.line(b, "downstream")
        cons = Counter(d.get("recipe") or d["name"] for ins, dsts in tr.consumers(cells) for d in dsts if kind(d) != "belt")
        xs = [c[0] for c in cells]; ys = [c[1] for c in cells]
        print("downstream: %d belts, x%d-%d y%d-%d, consumers %s" % (len(belts), min(xs), max(xs), min(ys), max(ys), dict(cons)))
        return
    targets = [grid.byid[i] for i in a.id] if a.id else list(grid.find(recipe=a.recipe, name=a.name))
    if not targets:
        sys.exit("nothing matched")
    for m in targets:
        if kind(m) in ("crafter", "furnace"):
            print(tr.format_machine(m))
        elif kind(m) == "belt":
            print(grid.describe(m), json.dumps(tr.summarize_line(m), default=str))
        else:
            print(grid.describe(m), "is not a machine or belt")
        print()


def cmd_check(a, gd):
    from .check import lane_mix, format_lane_mix
    obj, bp, grid = _grid(a.file, gd)
    findings, inconclusive, unknown = check(grid, gd, a.recipe)
    print(format_report(grid, findings, inconclusive, unknown, gd.source))
    if not a.recipe:
        print(format_lane_mix(grid, lane_mix(grid, gd)))
    sys.exit(1 if findings else 0)


def cmd_lint(a, gd):
    from .lint import lint, format_lint
    obj, bp, grid = _grid(a.file, gd)
    findings = lint(grid)
    print(format_lint(grid, findings, set(a.only) if a.only else None))
    sys.exit(1 if findings and a.strict else 0)


def cmd_flow(a, gd):
    from .flow import Flow, feeds_path, load_feeds
    obj, bp, grid = _grid(a.file, gd)
    fp = a.feeds or feeds_path(a.file)
    feeds = load_feeds(fp)
    flow = Flow(grid, gd, feeds).run()
    if a.json:
        json.dump(flow.as_json(), open(a.json, "w", encoding="utf-8"))
        print("wrote", a.json)
        return
    if a.at:
        L = flow.at(*a.at)
        if L is None:
            sys.exit("no belt at %s" % (tuple(a.at),))
        print("belt (%d,%d): left lane %s | right lane %s" % (a.at[0], a.at[1], sorted(L["left"]) or "-", sorted(L["right"]) or "-"))
        return
    print("feeds: %s (%d)" % (fp if feeds else "none", len(feeds)))
    counts = Counter()
    for L in flow.lanes.values():
        for i in L["left"] | L["right"]:
            counts[i] += 1
    print("items on belts (belt entities carrying each):")
    for i, n in counts.most_common():
        print("  %5d %s" % (n, i))
    empty = sum(1 for b in grid.entities if kind(b) == "belt" and not (flow.lanes_of(b)["left"] or flow.lanes_of(b)["right"]))
    print("belts with nothing known on them: %d (declare edge feeds to resolve)" % empty)


def cmd_diff(a, gd):
    from .diff import compare
    bp_a = codec.first_blueprint(codec.load(a.a))
    bp_b = codec.first_blueprint(codec.load(a.b))
    text, changed, regressions = compare(bp_a, bp_b, gd)
    print(text)
    sys.exit(1 if regressions else 0)


def cmd_patch(a, gd):
    obj = codec.load(a.file)
    bp = codec.first_blueprint(obj)
    p = json.load(open(a.patch, encoding="utf-8"))
    log = []
    patch.apply(bp, p, gd.footprints(), log)
    print("\n".join(log))
    if a.label:
        bp["label"] = a.label
    codec.save(obj, a.out)
    print("wrote", a.out)


def cmd_crop(a, gd):
    obj = codec.load(a.file)
    bp = codec.first_blueprint(obj)
    new = patch.crop(bp, a.x0, a.y0, a.x1, a.y1, gd.footprints())
    if a.label:
        new["label"] = a.label
    codec.save({"blueprint": new}, a.out)
    print("wrote %s: %d entities" % (a.out, len(new["entities"])))


def cmd_gamedata(a, gd):
    slim, path = gamedata.build_slim(a.dump)
    print("wrote %s: %d recipes, %d footprints" % (path, len(slim["recipes"]), len(slim["footprints"])))


def cmd_icons(a, gd):
    from . import icons
    root = icons.find_factorio(a.factorio)
    dump_path = a.dump or gamedata._dump_path()
    if not dump_path or not os.path.exists(dump_path):
        sys.exit("data-raw-dump.json not found; run `factorio --dump-data` with the game closed, or pass --dump")
    with open(dump_path, encoding="utf-8") as handle:
        dump = json.load(handle)
    media = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "vscode", "media")
    n, skipped, png = icons.build(dump, root, os.path.join(media, "icons.png"),
                                  os.path.join(media, "icons.js"), size=a.size)
    print("wrote %s and icons.js: %d icons at %dpx from %s" % (png, n, a.size, root))


def cmd_recipe(a, gd):
    for name in a.name:
        r = gd.recipes.get(name)
        print(name, json.dumps(r) if r else "UNKNOWN (source: %s)" % gd.source)


def main(argv=None):
    ap = argparse.ArgumentParser(prog="fbp", description="Factorio 2.0 blueprint tools (%s)" % __version__)
    sub = ap.add_subparsers(dest="cmd", required=True)

    s = sub.add_parser("info", help="summary of a blueprint or book"); s.add_argument("file")
    s.add_argument("--counts", action="store_true", help="entity counts"); s.add_argument("--recipes", action="store_true")
    s.set_defaults(fn=cmd_info)

    s = sub.add_parser("decode", help="blueprint string -> JSON"); s.add_argument("file"); s.add_argument("-o", "--out")
    s.set_defaults(fn=cmd_decode)
    s = sub.add_parser("encode", help="JSON -> blueprint string"); s.add_argument("file"); s.add_argument("-o", "--out")
    s.set_defaults(fn=cmd_encode)

    s = sub.add_parser("render", help="ASCII map of a region, or PNG of the whole print")
    s.add_argument("file"); s.add_argument("x0", type=int, nargs="?"); s.add_argument("y0", type=int, nargs="?")
    s.add_argument("x1", type=int, nargs="?"); s.add_argument("y1", type=int, nargs="?")
    s.add_argument("--entities", action="store_true", help="list machines, inserters and chests in the region")
    s.add_argument("--no-legend", action="store_true"); s.add_argument("--png"); s.add_argument("--scale", type=int, default=6)
    s.set_defaults(fn=cmd_render)

    s = sub.add_parser("find", help="list entities by name or recipe"); s.add_argument("file")
    s.add_argument("--name"); s.add_argument("--recipe"); s.add_argument("-v", "--verbose", action="store_true")
    s.set_defaults(fn=cmd_find)

    s = sub.add_parser("trace", help="inputs, outputs and belt lines of machines"); s.add_argument("file")
    s.add_argument("--recipe"); s.add_argument("--name"); s.add_argument("--id", type=int, nargs="*")
    s.add_argument("--at", type=int, nargs=2, metavar=("X", "Y"), help="belt tile: show what flows in and where it goes")
    s.set_defaults(fn=cmd_trace)

    s = sub.add_parser("check", help="flag crafters with an ingredient nothing nearby supplies"); s.add_argument("file")
    s.add_argument("--recipe"); s.set_defaults(fn=cmd_check)

    s = sub.add_parser("lint", help="belts and inserters that point at nothing useful"); s.add_argument("file")
    s.add_argument("--only", nargs="*", help="show only these finding codes"); s.add_argument("--strict", action="store_true")
    s.set_defaults(fn=cmd_lint)

    s = sub.add_parser("flow", help="what can be on each belt lane; declare edge inputs in <name>.feeds.json")
    s.add_argument("file"); s.add_argument("--feeds", help="feeds JSON (default <name>.feeds.json)")
    s.add_argument("--at", type=int, nargs=2, metavar=("X", "Y")); s.add_argument("--json", help="write full lane map to this file")
    s.set_defaults(fn=cmd_flow)

    s = sub.add_parser("diff", help="what changed between two versions: machines, check, lint, lane mix")
    s.add_argument("a"); s.add_argument("b"); s.set_defaults(fn=cmd_diff)

    s = sub.add_parser("patch", help="apply a JSON patch and write a new string"); s.add_argument("file")
    s.add_argument("patch"); s.add_argument("-o", "--out", required=True); s.add_argument("--label")
    s.set_defaults(fn=cmd_patch)

    s = sub.add_parser("crop", help="cut a region out into its own blueprint"); s.add_argument("file")
    for n in ("x0", "y0", "x1", "y1"):
        s.add_argument(n, type=int)
    s.add_argument("-o", "--out", required=True); s.add_argument("--label"); s.set_defaults(fn=cmd_crop)

    s = sub.add_parser("gamedata", help="build data/gamedata.json from the game's data-raw dump")
    s.add_argument("--dump", help="path to data-raw-dump.json (default: script-output)"); s.set_defaults(fn=cmd_gamedata)

    s = sub.add_parser("icons", help="build the viewer's icon atlas from your Factorio installation")
    s.add_argument("--factorio", help="installation directory (default: FBP_FACTORIO_DIR or the usual places)")
    s.add_argument("--dump", help="path to data-raw-dump.json")
    s.add_argument("--size", type=int, default=48, help="pixels per icon in the atlas (default 48)")
    s.set_defaults(fn=cmd_icons)

    s = sub.add_parser("recipe", help="show recipe(s) from the loaded data"); s.add_argument("name", nargs="+")
    s.set_defaults(fn=cmd_recipe)

    a = ap.parse_args(argv)
    gd = None if a.cmd in ("gamedata", "icons") else gamedata.GameData()
    a.fn(a, gd)


if __name__ == "__main__":
    main()
