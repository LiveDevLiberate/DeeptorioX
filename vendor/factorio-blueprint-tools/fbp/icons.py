"""Build an icon atlas from a local Factorio installation.

Factorio's artwork belongs to Wube Software and may not be redistributed, so no
icon is committed to this repository. Instead `fbp icons` reads them from the
copy of the game you already own and writes two files the viewer picks up if
they are present:

    vscode/media/icons.png   a grid of every icon, one cell each
    vscode/media/icons.js    window.FBP_ICONS = {size, cols, names: {name: [col, row]}}

Both are ignored by git. Without them the viewer falls back to coloured tiles.

Icon files in 2.0 hold the base image followed by its mipmaps on one row
(64 + 32 + 16 + 8 = 120 px wide for a 64 px icon), so only the leading square is
taken. Layered icons use their first layer, which is the recognisable one.
"""
import json
import os

# Mod names whose graphics ship inside the installation's data folder. Anything
# else lives in a zip in the mods folder and is skipped rather than guessed at.
SHIPPED = ("core", "base", "space-age", "elevated-rails", "quality")

CANDIDATE_DIRS = (
    r"C:\Program Files (x86)\Steam\steamapps\common\Factorio",
    r"C:\Program Files\Factorio",
    r"C:\Games\Steam\steamapps\common\Factorio",
    r"D:\SteamLibrary\steamapps\common\Factorio",
    os.path.expanduser("~/.steam/steam/steamapps/common/Factorio"),
    os.path.expanduser("~/Library/Application Support/Steam/steamapps/common/Factorio"),
    "/Applications/factorio.app/Contents",
)


def find_factorio(explicit=None):
    """Installation directory: the one given, then FBP_FACTORIO_DIR, then the usual places."""
    for candidate in (explicit, os.environ.get("FBP_FACTORIO_DIR")) + CANDIDATE_DIRS:
        if candidate and os.path.isdir(os.path.join(candidate, "data", "base")):
            return candidate
    raise FileNotFoundError(
        "could not find a Factorio installation; pass --factorio DIR or set FBP_FACTORIO_DIR")


def resolve(icon_path, root):
    """'__base__/graphics/icons/inserter.png' -> absolute path, or None for a mod we cannot read."""
    if not isinstance(icon_path, str) or not icon_path.startswith("__"):
        return None
    mod, _, rest = icon_path[2:].partition("__/")
    if mod not in SHIPPED:
        return None
    return os.path.join(root, "data", mod, *rest.split("/"))


def icon_of(proto):
    """(path, icon_size) for a prototype, following the first layer of a layered icon."""
    icon, size = proto.get("icon"), proto.get("icon_size")
    if not isinstance(icon, str):
        layers = proto.get("icons")
        if isinstance(layers, list) and layers and isinstance(layers[0], dict):
            icon, size = layers[0].get("icon"), layers[0].get("icon_size", size)
    return (icon, size or 64) if isinstance(icon, str) else (None, 64)


# Groups that are not items but are worth an icon: fluids show up as recipe
# products (oil processing, lubricant) and on the machines that make them.
EXTRA_TYPES = ("fluid",)

# Prototype groups worth drawing: everything that can sit on a belt or in a chest,
# plus the buildings the viewer renders. Item-like groups are found by duck typing
# (see `collect`), so science packs, ammo, modules, armour and the rest come along
# without listing every prototype type Factorio has.
ENTITY_TYPES = (
    "transport-belt", "underground-belt", "splitter", "inserter", "assembling-machine", "furnace",
    "lab", "container", "logistic-container", "electric-pole", "pipe", "pipe-to-ground", "pump",
    "storage-tank", "lamp", "radar", "roboport", "mining-drill", "offshore-pump", "boiler",
    "generator", "reactor", "beacon", "solar-panel", "accumulator", "wall", "gate", "ammo-turret",
    "electric-turret", "fluid-turret", "arithmetic-combinator", "decider-combinator",
    "constant-combinator", "train-stop", "rail-signal", "rail-chain-signal", "rocket-silo",
    "agricultural-tower", "asteroid-collector", "thruster", "cargo-landing-pad", "space-platform-hub",
    "artillery-turret", "nuclear-reactor", "heat-pipe", "loader", "loader-1x1", "linked-belt",
    "power-switch", "programmable-speaker", "display-panel", "selector-combinator", "land-mine",
    "lightning-attractor", "fusion-reactor", "fusion-generator", "electric-energy-interface",
    "infinity-container", "infinity-pipe", "simple-entity-with-owner", "car", "spider-vehicle",
    "locomotive", "cargo-wagon", "fluid-wagon", "artillery-wagon", "curved-rail-a", "curved-rail-b",
    "straight-rail", "half-diagonal-rail", "rail-ramp", "rail-support", "elevated-straight-rail",
)


def _is_item_group(protos):
    """True for a group of item prototypes. Items carry a stack size; entities,
    recipes and technologies do not, so this catches `tool` (science packs),
    `ammo`, `module`, `capsule`, `armor`, `gun` and anything a mod adds."""
    for proto in protos.values():
        if isinstance(proto, dict) and "stack_size" in proto:
            return True
    return False


def collect(dump):
    """name -> (icon path, icon size) for items and the entities the viewer draws."""
    out = {}
    groups = [k for k, v in dump.items()
              if k in ENTITY_TYPES or k in EXTRA_TYPES or (isinstance(v, dict) and _is_item_group(v))]
    for group in groups:
        protos = dump.get(group)
        if not isinstance(protos, dict):
            continue
        for name, proto in protos.items():
            if not isinstance(proto, dict) or name in out:
                continue
            path, size = icon_of(proto)
            if path:
                out[name] = (path, size)
    return out


def build(dump, root, out_png, out_js, size=48, quiet=False):
    """Write the atlas and its manifest. Returns (count, skipped, out_png)."""
    from PIL import Image

    wanted = collect(dump)
    cells, skipped = [], []
    for name in sorted(wanted):
        path, icon_size = wanted[name]
        full = resolve(path, root)
        if not full or not os.path.exists(full):
            skipped.append(name)
            continue
        try:
            with Image.open(full) as im:
                im = im.convert("RGBA")
                # keep only the leading square; the rest of the row is mipmaps
                side = min(icon_size, im.width, im.height)
                cells.append((name, im.crop((0, 0, side, side)).resize((size, size), Image.LANCZOS)))
        except Exception:
            skipped.append(name)

    if not cells:
        raise RuntimeError("no icons could be read from %s" % root)

    cols = max(1, int(len(cells) ** 0.5 + 0.999))
    rows = (len(cells) + cols - 1) // cols
    atlas = Image.new("RGBA", (cols * size, rows * size), (0, 0, 0, 0))
    names = {}
    for i, (name, im) in enumerate(cells):
        col, row = i % cols, i // cols
        atlas.paste(im, (col * size, row * size))
        names[name] = [col, row]

    os.makedirs(os.path.dirname(out_png), exist_ok=True)
    atlas.save(out_png, optimize=True)
    manifest = {"size": size, "cols": cols, "rows": rows, "file": os.path.basename(out_png), "names": names}
    with open(out_js, "w", encoding="utf-8") as handle:
        handle.write("// generated by `fbp icons` from a local Factorio installation; not redistributable\n"
                     "window.FBP_ICONS = " + json.dumps(manifest, separators=(",", ":"), sort_keys=True) + ";\n")
    if not quiet and skipped:
        print("skipped %d icon(s) that live in mod archives: %s%s"
              % (len(skipped), ", ".join(skipped[:6]), " …" if len(skipped) > 6 else ""))
    return len(cells), len(skipped), out_png
