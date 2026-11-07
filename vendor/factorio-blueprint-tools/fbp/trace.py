"""Belt graph and machine input/output tracing.

Belts are followed tile to tile, through underground pairs and splitters. A
"line" is everything upstream of a belt tile; feeders are inserters dropping
onto it, consumers are inserters picking from it. What a belt carries is
inferred from its feeders: an assembler feeds its recipe products, a furnace
feeds "smelted" output, a chest or an unknown source feeds anything.
"""
from collections import Counter

from .model import (DIRS, INSERTERS, UNDERGROUND_REACH, Grid, inserter_ends, is_splitter,
                    is_underground, kind, tile_of)


class Tracer:
    def __init__(self, grid, gamedata=None):
        self.g = grid
        self.gd = gamedata

    # -- belt geometry ---------------------------------------------------
    def outputs(self, b):
        """Tiles a belt entity delivers items to."""
        dr = b.get("direction", 0) & 12
        dx, dy = DIRS[dr]
        if is_splitter(b):
            return [(c[0] + dx, c[1] + dy) for c in self.g.cells_of(b)]
        x, y = tile_of(b)
        if is_underground(b) and b.get("type") == "input":
            pair = self.underground_pair(b)
            return [tile_of(pair)] if pair else []
        return [(x + dx, y + dy)]

    def underground_pair(self, b):
        dr = b.get("direction", 0) & 12
        dx, dy = DIRS[dr]
        x, y = tile_of(b)
        want = "output" if b.get("type") == "input" else "input"
        step = 1 if want == "output" else -1
        for k in range(1, UNDERGROUND_REACH.get(b["name"], 5) + 1):
            q = (x + dx * k * step, y + dy * k * step)
            for f in self.g.tiles.get(q, []):
                if f["name"] == b["name"] and f.get("type") == want and (f.get("direction", 0) & 12) == dr:
                    return f
        return None

    def _same_axis(self, a, b):
        return ((a.get("direction", 0) & 12) % 8) == ((b.get("direction", 0) & 12) % 8)

    def _opposed(self, a, b):
        """a points straight at b and b points straight back: a head-on meeting."""
        return ((a.get("direction", 0) & 12) + 8) % 16 == (b.get("direction", 0) & 12)

    def upstream(self, b):
        """Belt entities that deliver into b.

        An underground exit receives from its entrance through the tunnel, and also from belts
        running into its SIDE (only the lane aligned with the open half gets through; the flow
        applies that filter). Nothing can feed it along its own axis except the tunnel.

        Two belts facing each other never connect: a belt running head-on into the hood of an
        underground entrance, or into the front of any belt, just piles its items up at its end."""
        found = {}
        exit_ = is_underground(b) and b.get("type") == "output"
        if exit_:
            pair = self.underground_pair(b)
            if pair:
                found[pair["entity_number"]] = pair
        for (x, y) in self.g.cells_of(b):
            for dx, dy in DIRS.values():
                f = self.g.belt_at(x + dx, y + dy)
                if f is None or f is b:
                    continue
                if exit_ and self._same_axis(f, b):
                    continue
                if self._opposed(f, b):
                    continue
                if (x, y) in self.outputs(f):
                    found[f["entity_number"]] = f
        return list(found.values())

    def downstream(self, b):
        found = {}
        for q in self.outputs(b):
            f = self.g.belt_at(*q)
            if f is not None and f is not b:
                if is_underground(f) and f.get("type") == "output" and self._same_axis(b, f) \
                        and not (is_underground(b) and b.get("type") == "input"):
                    continue  # the back of an underground exit does not accept items; its sides do
                if self._opposed(b, f):
                    continue  # head-on: b dead-ends against f
                found[f["entity_number"]] = f
        return list(found.values())

    def line(self, start, direction="upstream", limit=2000):
        step = self.upstream if direction == "upstream" else self.downstream
        seen, stack, belts = set(), [start], []
        while stack and len(seen) < limit:
            b = stack.pop()
            if b["entity_number"] in seen:
                continue
            seen.add(b["entity_number"])
            belts.append(b)
            stack.extend(step(b))
        cells = set()
        for b in belts:
            cells.update(self.g.cells_of(b))
        return belts, cells

    # -- inserters -------------------------------------------------------
    def inserters(self):
        return [e for e in self.g.entities if e["name"] in INSERTERS]

    def feeders(self, cells):
        out = []
        for ins in self.inserters():
            pick, drop = inserter_ends(ins)
            if drop in cells:
                out.append((ins, self.g.at(*pick, exclude_kinds=("inserter",))))
        return out

    def consumers(self, cells):
        out = []
        for ins in self.inserters():
            pick, drop = inserter_ends(ins)
            if pick in cells:
                out.append((ins, self.g.at(*drop, exclude_kinds=("inserter",))))
        return out

    # -- item inference --------------------------------------------------
    def items_from(self, sources):
        """Items available from a list of source entities. Returns (items, unknown)."""
        items, unknown = set(), False
        for s in sources:
            k = kind(s)
            if k == "crafter":
                if s.get("recipe"):
                    items |= self.gd.products(s["recipe"]) if self.gd else {s["recipe"]}
                else:
                    unknown = True
            elif k == "furnace":
                items |= self.gd.smelted_items() if self.gd else {"iron-plate", "copper-plate", "steel-plate", "stone-brick"}
            elif k == "belt":
                li, lu = self.line_items(s)
                items |= li
                unknown = unknown or lu
            elif k == "chest":
                filters = [f["name"] for sec in s.get("request_filters", {}).get("sections", [])
                           for f in sec.get("filters", [])]
                if filters:
                    items |= set(filters)
                else:
                    unknown = True
            else:
                unknown = True
        return items, unknown

    _line_cache = None

    def line_items(self, belt):
        if self._line_cache is None:
            self._line_cache = {}
        key = belt["entity_number"]
        if key in self._line_cache:
            return self._line_cache[key]
        self._line_cache[key] = (set(), True)  # guard against cycles
        belts, cells = self.line(belt)
        items, unknown = set(), False
        feeds = self.feeders(cells)
        if not feeds:
            unknown = True  # fed from outside the blueprint
        for ins, sources in feeds:
            src = [s for s in sources if kind(s) != "belt"]
            i, u = self.items_from(src)
            items |= i
            unknown = unknown or u or not src
        self._line_cache[key] = (items, unknown)
        return items, unknown

    def summarize_line(self, belt):
        belts, cells = self.line(belt)
        xs = [c[0] for c in cells]
        ys = [c[1] for c in cells]
        fed = Counter()
        for ins, srcs in self.feeders(cells):
            for s in srcs:
                if kind(s) != "belt":
                    fed[s.get("recipe") or s["name"]] += 1
        used = Counter()
        for ins, dsts in self.consumers(cells):
            for d in dsts:
                if kind(d) != "belt":
                    used[d.get("recipe") or d["name"]] += 1
        items, unknown = self.line_items(belt)
        return {"belts": len(belts), "bbox": (min(xs), min(ys), max(xs), max(ys)), "fed_by": dict(fed),
                "consumed_by": dict(used), "items": sorted(items), "unknown_sources": unknown}

    # -- machines --------------------------------------------------------
    def machine_io(self, machine):
        """Inputs and outputs of a crafter/furnace: lists of dicts."""
        cells = set(self.g.cells_of(machine))
        inputs, outputs = [], []
        for ins in self.inserters():
            pick, drop = inserter_ends(ins)
            if drop in cells:
                sources = self.g.at(*pick, exclude_kinds=("inserter",))
                items, unknown = self.items_from(sources)
                entry = {"inserter": ins, "tile": pick, "sources": sources, "items": items, "unknown": unknown}
                belts = [s for s in sources if kind(s) == "belt"]
                if belts:
                    entry["line"] = self.summarize_line(belts[0])
                inputs.append(entry)
            elif pick in cells:
                targets = self.g.at(*drop, exclude_kinds=("inserter",))
                outputs.append({"inserter": ins, "tile": drop, "targets": targets})
        return inputs, outputs

    def format_machine(self, machine):
        g = self.g
        inputs, outputs = self.machine_io(machine)
        lines = [g.describe(machine)]
        for i in inputs:
            src = ", ".join(g.describe(s) for s in i["sources"]) or "NOTHING"
            lines.append("  IN  %s#%d @%s <- %s" % (i["inserter"]["name"], i["inserter"]["entity_number"], i["tile"], src))
            if "line" in i:
                L = i["line"]
                x0, y0, x1, y1 = L["bbox"]
                lines.append("      line: %d belts, x%d-%d y%d-%d" % (L["belts"], x0, x1, y0, y1))
                lines.append("      fed by %s" % (L["fed_by"] or "nothing inside the blueprint"))
                lines.append("      consumed by %s" % (L["consumed_by"] or "nothing"))
                lines.append("      carries %s%s" % (", ".join(L["items"]) or "?", " (+unknown)" if L["unknown_sources"] else ""))
        for o in outputs:
            dst = ", ".join(g.describe(t) for t in o["targets"]) or "GROUND"
            lines.append("  OUT %s#%d @%s -> %s" % (o["inserter"]["name"], o["inserter"]["entity_number"], o["tile"], dst))
        return "\n".join(lines)
