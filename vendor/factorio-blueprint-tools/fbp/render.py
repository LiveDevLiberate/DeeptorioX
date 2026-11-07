"""ASCII and PNG renders of a blueprint region."""
from .model import Grid, kind, is_underground, is_splitter, footprint

ARROW = {0: "^", 4: ">", 8: "v", 12: "<"}

LEGEND = """legend: A crafter  F furnace  L lab  R roboport  C chemical plant  O refinery  T tank
        ^>v< belt   u/U underground in/out   S splitter   i inserter  l long inserter  f fast inserter
        c chest  P provider  Q requester  p pole  = pipe  _ pipe-to-ground  * lamp  K combinator  . empty"""

CHAR = {
    "inserter": "i", "fast-inserter": "f", "long-handed-inserter": "l", "bulk-inserter": "b",
    "pipe": "=", "pipe-to-ground": "_", "small-lamp": "*", "constant-combinator": "K",
    "arithmetic-combinator": "K", "decider-combinator": "K", "requester-chest": "Q",
    "passive-provider-chest": "P", "active-provider-chest": "P", "storage-chest": "P", "buffer-chest": "Q",
    "lab": "L", "roboport": "R", "chemical-plant": "C", "oil-refinery": "O", "storage-tank": "T",
    "pumpjack": "J", "pump": "m",
}


def glyph(e):
    n = e["name"]
    if n in CHAR:
        return CHAR[n]
    k = kind(e)
    if k == "belt":
        if is_underground(e):
            return "u" if e.get("type") == "input" else "U"
        if is_splitter(e):
            return "S"
        return ARROW.get(e.get("direction", 0) & 12, "?")
    if k == "crafter":
        return "A"
    if k == "furnace":
        return "F"
    if k == "chest":
        return "c"
    if k == "pole":
        return "p"
    if k == "inserter":
        return "i"
    return "?"


def ascii_region(grid, x0, y0, x1, y1, legend=False):
    cells = {}
    for e in grid.entities:
        g = glyph(e)
        for c in grid.cells_of(e):
            if x0 <= c[0] <= x1 and y0 <= c[1] <= y1:
                cells[c] = g
    lines = ["     " + "".join(str(x % 10) for x in range(x0, x1 + 1))]
    for y in range(y0, y1 + 1):
        lines.append("%4d " % y + "".join(cells.get((x, y), ".") for x in range(x0, x1 + 1)))
    if legend:
        lines.append(LEGEND)
    return "\n".join(lines)


def listing(grid, x0, y0, x1, y1, kinds=("crafter", "furnace", "inserter", "chest")):
    rows = []
    for e in grid.entities:
        p = e["position"]
        if x0 <= p["x"] <= x1 and y0 <= p["y"] <= y1 and kind(e) in kinds:
            extra = {k: v for k, v in e.items() if k not in ("entity_number", "name", "position", "recipe_quality")}
            rows.append("%5d %-24s (%6.1f,%6.1f) %s" % (e["entity_number"], e["name"], p["x"], p["y"], extra))
    return "\n".join(rows)


COLORS = {
    "belt": (200, 170, 60), "inserter": (90, 140, 220), "crafter": (120, 180, 120), "furnace": (200, 110, 70),
    "chest": (170, 130, 200), "pole": (230, 230, 230), "other": (120, 120, 120),
}


def png(grid, path, scale=6, x0=None, y0=None, x1=None, y1=None):
    """Tile-coloured PNG. Requires Pillow."""
    from PIL import Image, ImageDraw
    bx0, by0, bx1, by1 = grid.bbox()
    x0 = bx0 if x0 is None else x0
    y0 = by0 if y0 is None else y0
    x1 = bx1 if x1 is None else x1
    y1 = by1 if y1 is None else y1
    w, h = (x1 - x0 + 1) * scale, (y1 - y0 + 1) * scale
    img = Image.new("RGB", (w, h), (28, 28, 30))
    draw = ImageDraw.Draw(img)
    tier_col = {"fast-": (210, 74, 58), "express-": (59, 127, 214), "turbo-": (63, 191, 107)}
    for e in grid.entities:
        col = COLORS.get(kind(e), COLORS["other"])
        if e["name"] == "small-lamp":
            col = (250, 240, 150)
        if kind(e) == "belt":
            for prefix, c in tier_col.items():
                if e["name"].startswith(prefix):
                    col = c
            if is_underground(e):
                col = tuple(int(v * 0.6) for v in col)
        for cx, cy in grid.cells_of(e):
            if x0 <= cx <= x1 and y0 <= cy <= y1:
                px, py = (cx - x0) * scale, (cy - y0) * scale
                draw.rectangle([px, py, px + scale - 1, py + scale - 1], fill=col)
    img.save(path)
    return path
