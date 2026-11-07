#!/usr/bin/env python3
"""Run the vendored factorio-blueprint-tools CLI (`fbp`).

Full upstream source lives in vendor/factorio-blueprint-tools (MIT).
"""
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "vendor" / "factorio-blueprint-tools"))

from fbp.cli import main  # noqa: E402

if __name__ == "__main__":
    main()
