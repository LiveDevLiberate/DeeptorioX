#!/usr/bin/env python3
"""Decode a map exchange string with the vendored FactorioPreviewToolkit.

Dependency-free subset of the upstream preview-generator: it uses the dummy-save
+ control.lua pipeline to extract map-gen settings and available planets, then
writes JSON for autorio's Node map-preview generator.
"""
from __future__ import annotations

import argparse
import json
import sys
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "vendor" / "factorio-preview-toolkit"))

from src.FactorioPreviewToolkit.preview_generator.preview_generation_setup import (  # noqa: E402
    run_preview_setup_pipeline,
)
from src.FactorioPreviewToolkit.shared.shared_constants import constants  # noqa: E402
from src.FactorioPreviewToolkit.shared.utils import sanitize_map_string  # noqa: E402


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Decode a Factorio map exchange string")
    parser.add_argument("factorio_path", type=Path)
    parser.add_argument("map_string", type=str)
    parser.add_argument("--out", required=True, type=Path)
    args = parser.parse_args(argv)
    exchange = sanitize_map_string(args.map_string)
    if not exchange:
        print(json.dumps({"ok": False, "error": "invalid map exchange string"}))
        return 2
    if not args.factorio_path.exists():
        print(json.dumps({"ok": False, "error": f"Factorio executable not found: {args.factorio_path}"}))
        return 2
    try:
        run_preview_setup_pipeline(args.factorio_path, exchange)
        settings_path = Path(constants.MAP_GEN_SETTINGS_FILEPATH)
        settings = json.loads(settings_path.read_text(encoding="utf-8"))
        planet_path = Path(constants.SCRIPT_OUTPUT_DIR) / constants.PLANET_NAMES_REMOTE_FILENAME
        planets = json.loads(planet_path.read_text(encoding="utf-8"))
        if not isinstance(planets, list):
            planets = ["nauvis"]
        args.out.mkdir(parents=True, exist_ok=True)
        (args.out / "map-gen-settings.json").write_text(
            json.dumps(settings, indent=2), encoding="utf-8"
        )
        (args.out / "planets.json").write_text(json.dumps(planets, indent=2), encoding="utf-8")
        print(json.dumps({
            "ok": True,
            "seed": settings.get("seed"),
            "planets": planets,
            "map_gen": settings,
            "out": str(args.out),
        }, ensure_ascii=False))
        return 0
    except Exception as error:  # Return structured JSON for the manager.
        print(json.dumps({"ok": False, "error": str(error)}))
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
