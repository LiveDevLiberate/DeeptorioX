#!/usr/bin/env python3
"""Launcher for the vendored FactorioPreviewToolkit.

Modes:
  --info                 show vendored paths/config/dependency status (no deps)
  --config [--json]      parse vendor/config.ini (no deps)
  --preview-generator-mode <factorio> <map_string>
  --uploader-mode
  (no args)              upstream controller/clipboard mode

Full modes require the optional upstream dependencies; autorio's own
/api/map-preview endpoints do not.
"""
from __future__ import annotations

import argparse
import configparser
import importlib.util
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
VENDOR = ROOT / "vendor" / "factorio-preview-toolkit"
sys.path.insert(0, str(VENDOR))

REQUIRED = ["pydantic", "psutil", "pygame", "pyperclip", "PIL"]
OPTIONAL_WIN = ["win32api"]


def dependency_status() -> dict[str, bool]:
    status = {name: importlib.util.find_spec(name) is not None for name in REQUIRED}
    if sys.platform == "win32":
        status.update({name: importlib.util.find_spec(name) is not None for name in OPTIONAL_WIN})
    return status


def print_info() -> int:
    config = VENDOR / "config.ini"
    payload = {
        "vendor": str(VENDOR),
        "config": str(config),
        "config_exists": config.exists(),
        "source": str(VENDOR / "src" / "FactorioPreviewToolkit"),
        "viewer": str(VENDOR / "viewer"),
        "assets": str(VENDOR / "assets"),
        "rclone_binaries_vendored": any((VENDOR / "third_party" / "rclone").glob("*/*/*")),
        "dependencies": dependency_status(),
        "requirements": str(ROOT / "tools" / "requirements-preview-toolkit.txt"),
    }
    print(json.dumps(payload, indent=2))
    return 0


def print_config(as_json: bool) -> int:
    parser = configparser.ConfigParser()
    config = VENDOR / "config.ini"
    if config.exists():
        parser.read(config, encoding="utf-8")
    data = {section: dict(parser.items(section)) for section in parser.sections()}
    print(json.dumps(data, indent=2) if as_json else "\n".join(
        f"[{section}]\n" + "\n".join(f"{k} = {v}" for k, v in values.items())
        for section, values in data.items()
    ))
    return 0


def require_deps() -> None:
    missing = [name for name, present in dependency_status().items() if not present]
    if missing:
        print(
            "Missing FactorioPreviewToolkit optional dependencies: " + ", ".join(missing) +
            "\nInstall with: python -m pip install -r tools/requirements-preview-toolkit.txt",
            file=sys.stderr,
        )
        raise SystemExit(2)


def main(argv: list[str] | None = None) -> int:
    args = list(sys.argv[1:] if argv is None else argv)
    if not args or "--info" in args:
        return print_info()
    if "--config" in args:
        return print_config("--json" in args)
    if "--preview-generator-mode" in args:
        require_deps()
        from src.FactorioPreviewToolkit.preview_generator.__main__ import main as generator_main
        generator_main(args)
        return 0
    if "--uploader-mode" in args:
        require_deps()
        from src.FactorioPreviewToolkit.uploader.__main__ import main as uploader_main
        uploader_main(args)
        return 0
    require_deps()
    from src.FactorioPreviewToolkit.__main__ import PreviewController
    controller = PreviewController()
    controller.start()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
