"""Geometry lint: belts and inserters that point at nothing useful.

These are structural checks that need no recipe data:

  * belt dead end        a belt whose output tile has no belt, and no inserter
                         picks from the belt itself (items pile up for nothing)
  * belt into entity     a belt that points into a machine, chest or pole
                         (items stop; usually a rotated belt)
  * underground unpaired an underground entrance/exit with no partner in reach
  * splitter starved     a splitter with no belt feeding either input tile, or
                         no belt and no inserter on either output tile
  * inserter from empty  an inserter whose pickup tile holds nothing
  * inserter to ground   an inserter whose drop tile holds nothing (drops on the
                         ground; sometimes intentional at the end of a line)
  * inserter from/to     an inserter whose pickup or drop is a belt tile, a
    belt sanity          machine, or a chest is fine; an inserter picking from
                         a pole or lamp is not

Every finding carries an entity and a code so callers can filter.
"""
from .model import INSERTERS, Grid, inserter_ends, is_splitter, is_underground, kind, tile_of
from .trace import Tracer

USEFUL_TARGETS = {"belt", "crafter", "furnace", "chest", "other"}
USELESS_NAMES = {"small-lamp", "small-electric-pole", "medium-electric-pole", "big-electric-pole", "substation",
                 "pipe", "pipe-to-ground", "constant-combinator"}


def lint(grid):
    tr = Tracer(grid)
    findings = []
    picked_from = set()   # belt tiles some inserter picks from
    for e in grid.entities:
        if e["name"] in INSERTERS:
            pick, drop = inserter_ends(e)
            picked_from.add(pick)
            p = grid.at(*pick, exclude_kinds=("inserter",))
            d = grid.at(*drop, exclude_kinds=("inserter",))
            if not p:
                findings.append(("inserter-from-empty", e, "pickup tile %s is empty" % (pick,)))
            elif all(x["name"] in USELESS_NAMES for x in p):
                findings.append(("inserter-from-useless", e, "picks from %s" % grid.describe(p[0])))
            if not d:
                findings.append(("inserter-to-ground", e, "drop tile %s is empty" % (drop,)))
            elif all(x["name"] in USELESS_NAMES for x in d):
                findings.append(("inserter-to-useless", e, "drops onto %s" % grid.describe(d[0])))

    for e in grid.entities:
        if kind(e) != "belt":
            continue
        if is_underground(e):
            if tr.underground_pair(e) is None:
                findings.append(("underground-unpaired", e, "no matching %s within reach" %
                                 ("exit" if e.get("type") == "input" else "entrance")))
            continue
        if is_splitter(e):
            if not tr.upstream(e):
                findings.append(("splitter-no-input", e, "nothing feeds either input tile"))
            outs = tr.outputs(e)
            if not any(grid.belt_at(*o) for o in outs) and not any(o in picked_from for o in outs):
                findings.append(("splitter-no-output", e, "nothing on either output tile"))
            continue
        outs = tr.outputs(e)
        nxt = [grid.belt_at(*o) for o in outs]
        if any(nxt):
            continue
        here = tile_of(e)
        blockers = [x for o in outs for x in grid.at(*o, exclude_kinds=("inserter",))]
        if here in picked_from:
            continue  # terminal belt an inserter feeds from: fine
        if blockers:
            findings.append(("belt-into-entity", e, "points into %s" % grid.describe(blockers[0])))
        else:
            findings.append(("belt-dead-end", e, "output tile %s has nothing; nothing picks from this belt" % (outs[0],)))
    return findings


def format_lint(grid, findings, codes=None):
    rows = []
    counts = {}
    for code, e, msg in findings:
        counts[code] = counts.get(code, 0) + 1
        if codes and code not in codes:
            continue
        rows.append("  %-22s %s: %s" % (code, grid.describe(e), msg))
    head = ["lint: %d finding(s)" % len(findings)] + ["  %5d %s" % (n, c) for c, n in sorted(counts.items())]
    return "\n".join(head + rows)
