#!/usr/bin/env python3
"""Render a blueprint registry wire string to a small PNG thumbnail.

Uses the vendored factorio-blueprint-tools codec/Grid/render implementation.
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "vendor" / "factorio-blueprint-tools"))

from fbp import codec, gamedata, render  # noqa: E402
from fbp.model import Grid  # noqa: E402


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Render a blueprint PNG thumbnail")
    parser.add_argument("--wire-file", required=True)
    parser.add_argument("--out", required=True)
    parser.add_argument("--scale", type=int, default=6)
    parser.add_argument("--max-width", type=int, default=480)
    parser.add_argument("--max-height", type=int, default=320)
    args = parser.parse_args(argv)
    try:
        wire = Path(args.wire_file).read_text(encoding="utf-8")
        obj = codec.decode(wire)
        bp = codec.first_blueprint(obj)
        if not bp:
            raise ValueError("no blueprint in wire")
        gd = gamedata.GameData()
        grid = Grid(bp, gd.footprints())
        out = Path(args.out)
        out.parent.mkdir(parents=True, exist_ok=True)
        render.png(grid, str(out), scale=args.scale)
        from PIL import Image
        with Image.open(out) as image:
            image.thumbnail((args.max_width, args.max_height))
            image.save(out, optimize=True)
            width, height = image.size
        print(json.dumps({"ok": True, "out": str(out), "bytes": out.stat().st_size,
                          "width": width, "height": height}))
        return 0
    except Exception as error:
        print(json.dumps({"ok": False, "error": str(error)}))
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
