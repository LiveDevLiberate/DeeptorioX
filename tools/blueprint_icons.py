#!/usr/bin/env python3
"""Build an fbp icon atlas from the local Factorio installation.

Icons are Wube's artwork; this script writes them only into the local,
git-ignored data directory so they can be served to the viewer at runtime.
"""
from __future__ import annotations

import argparse
import json
import os
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "vendor" / "factorio-blueprint-tools"))

from fbp import gamedata, icons  # noqa: E402


def find_install(explicit: str | None = None) -> str:
    candidates = [explicit, os.environ.get("FBP_FACTORIO_DIR")]
    data = os.environ.get("FACTORIO_DATA")
    if data:
        candidates.append(str(Path(data).parent))
    binary = os.environ.get("FACTORIO_BIN")
    if binary:
        # .../Factorio/bin/x64/factorio.exe -> installation root
        candidates.append(str(Path(binary).resolve().parents[2]))
    for candidate in candidates:
        if candidate and os.path.isdir(os.path.join(candidate, "data", "base")):
            return candidate
    return icons.find_factorio(explicit)


def find_dump(explicit: str | None = None) -> str:
    candidates = [explicit, os.environ.get("FBP_DATA_DUMP")]
    appdata = os.environ.get("APPDATA")
    if appdata:
        candidates.append(os.path.join(appdata, "Factorio", "script-output", "data-raw-dump.json"))
    try:
        found = gamedata._dump_path()
    except Exception:
        found = None
    candidates.append(found)
    for candidate in candidates:
        if candidate and os.path.exists(candidate):
            return str(candidate)
    raise FileNotFoundError(
        "data-raw-dump.json not found; run `factorio --dump-data` with the game closed "
        "or pass --dump")


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Build the autoria blueprint icon atlas")
    parser.add_argument("--out-dir", required=True)
    parser.add_argument("--factorio-dir")
    parser.add_argument("--dump")
    parser.add_argument("--size", type=int, default=48)
    args = parser.parse_args(argv)
    try:
        root = find_install(args.factorio_dir)
        dump_path = find_dump(args.dump)
        with open(dump_path, encoding="utf-8") as handle:
            dump = json.load(handle)
        out_dir = Path(args.out_dir)
        out_dir.mkdir(parents=True, exist_ok=True)
        png = out_dir / "icons.png"
        js = out_dir / "icons.js"
        count, skipped, _ = icons.build(dump, root, str(png), str(js), size=args.size, quiet=True)
        # The viewer fetches the atlas through the manager API, not a relative file.
        text = js.read_text(encoding="utf-8")
        text = text.replace('"file":"icons.png"', '"file":"/api/blueprint-icons.png"')
        text = text.replace('"file": "icons.png"', '"file": "/api/blueprint-icons.png"')
        js.write_text(text, encoding="utf-8")
        print(json.dumps({
            "ok": True,
            "count": count,
            "skipped": skipped,
            "factorio": root,
            "dump": dump_path,
            "png": str(png),
            "js": str(js),
        }))
        return 0
    except Exception as error:
        print(json.dumps({"ok": False, "error": str(error)}))
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
