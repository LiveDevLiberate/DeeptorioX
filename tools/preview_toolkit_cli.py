#!/usr/bin/env python3
"""Run the vendored FactorioPreviewToolkit preview generator.

Full upstream source lives in vendor/factorio-preview-toolkit (MIT).
This entry point mirrors its `--preview-generator-mode`; the toolkit's optional
clipboard/uploader dependencies are listed in its pyproject/requirements.
"""
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "vendor" / "factorio-preview-toolkit"))

from src.FactorioPreviewToolkit.preview_generator.__main__ import main  # noqa: E402

if __name__ == "__main__":
    main(sys.argv[1:])
