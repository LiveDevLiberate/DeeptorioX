"""Blueprint string <-> JSON.

A blueprint string is a version byte ("0") followed by base64 of zlib-compressed
JSON. The JSON root is one of {"blueprint": ...}, {"blueprint_book": ...},
{"deconstruction_planner": ...} or {"upgrade_planner": ...}.
"""
import base64
import json
import zlib


def decode(text):
    text = text.strip()
    if not text or text[0] != "0":
        raise ValueError("not a Factorio blueprint string (expected leading version byte '0')")
    return json.loads(zlib.decompress(base64.b64decode(text[1:])))


def encode(obj):
    raw = json.dumps(obj, separators=(",", ":")).encode()
    return "0" + base64.b64encode(zlib.compress(raw, 9)).decode()


def load(path):
    """Load a blueprint string file or a decoded JSON file."""
    with open(path, encoding="utf-8") as handle:
        text = handle.read()
    if text.lstrip().startswith("{"):
        return json.loads(text)
    return decode(text)


def save(obj, path):
    text = encode(obj)
    with open(path, "w", encoding="utf-8") as handle:
        handle.write(text)
    return text


def blueprints(obj):
    """Yield (path, blueprint) for every blueprint in obj, descending into books."""
    if "blueprint" in obj:
        yield (obj["blueprint"].get("label", ""),), obj["blueprint"]
    elif "blueprint_book" in obj:
        book = obj["blueprint_book"]
        label = book.get("label", "book")
        for entry in book.get("blueprints", []):
            for path, bp in blueprints(entry):
                yield (label,) + path, bp


def first_blueprint(obj):
    for _, bp in blueprints(obj):
        return bp
    raise ValueError("no blueprint found in object")


def game_version(bp):
    v = bp.get("version", 0)
    return "%d.%d.%d" % (v >> 48, (v >> 32) & 0xFFFF, (v >> 16) & 0xFFFF)


def make_book(label, entries, icons=None):
    """Wrap several blueprint objects ({"blueprint": ...}) into a book object."""
    for i, entry in enumerate(entries):
        entry["index"] = i
    book = {"item": "blueprint-book", "label": label, "blueprints": entries, "active_index": 0}
    if icons:
        book["icons"] = icons
    version = max((first_blueprint(e).get("version", 0) for e in entries), default=0)
    book["version"] = version
    return {"blueprint_book": book}
