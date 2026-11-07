#!/usr/bin/env python3
"""Render one map preview through the vendored FactorioPreviewToolkit runner.

Used by autorio's map-preview API so PNG generation goes through the ported
toolkit's Factorio interface (config/lock/low-priority subprocess handling).
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "vendor" / "factorio-preview-toolkit"))

from src.FactorioPreviewToolkit.shared.shared_constants import constants  # noqa: E402


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Render a map preview via the vendored toolkit")
    parser.add_argument("factorio", type=Path)
    parser.add_argument("settings", type=Path)
    parser.add_argument("output", type=Path)
    parser.add_argument("profile", type=Path)
    parser.add_argument("planet")
    parser.add_argument("size", type=int)
    args = parser.parse_args(argv)

    profile = args.profile.resolve()
    mods = profile / "mods"
    # Point the vendored runner at autorio's isolated preview profile.
    constants.FACTORIO_CONFIG_FILEPATH = profile / "config.ini"
    constants.FACTORIO_WRITE_DATA_DIR = profile
    constants.FACTORIO_LOCK_FILEPATH = profile / ".lock"

    from src.FactorioPreviewToolkit.preview_generator.factorio_interface import (  # noqa: E402
        run_factorio_command,
    )

    args.output.parent.mkdir(parents=True, exist_ok=True)
    run_factorio_command(
        args.factorio,
        [
            f"--mod-directory={mods}",
            f"--generate-map-preview={args.output}",
            f"--map-gen-settings={args.settings}",
            f"--map-preview-size={args.size}",
            f"--map-preview-planet={args.planet}",
        ],
    )
    if not args.output.exists() or args.output.stat().st_size == 0:
        print(json.dumps({"ok": False, "error": "toolkit runner produced no PNG"}))
        return 1
    print(json.dumps({"ok": True, "output": str(args.output), "size": args.output.stat().st_size}))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
