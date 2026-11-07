#!/usr/bin/env python3
"""Extract technology/item/fluid/entity names from the local Factorio locale."""
from __future__ import annotations

import argparse
import json
import os
import re
import sys
from pathlib import Path

SECTIONS = {
    "item-name": "item",
    "fluid-name": "fluid",
    "entity-name": "entity",
    "recipe-name": "recipe",
    "technology-name": "technology",
}
SECTION_HEADER = re.compile(r"^\[([^\]]+)\]$")
DOTTED = re.compile(r"^(item-name|fluid-name|entity-name|recipe-name|technology-name)\.([^=]+)=(.*)$")


def find_install(explicit: str | None = None) -> Path:
    candidates = [explicit, os.environ.get("FBP_FACTORIO_DIR")]
    data = os.environ.get("FACTORIO_DATA")
    if data:
        candidates.append(str(Path(data).parent))
    binary = os.environ.get("FACTORIO_BIN")
    if binary:
        candidates.append(str(Path(binary).resolve().parents[2]))
    candidates.extend([
        r"C:\Program Files (x86)\Steam\steamapps\common\Factorio",
        r"C:\Program Files\Factorio",
        os.path.expanduser("~/.steam/steam/steamapps/common/Factorio"),
    ])
    for candidate in candidates:
        if candidate and (Path(candidate) / "data" / "base").is_dir():
            return Path(candidate)
    raise FileNotFoundError("could not find Factorio installation")


def parse_file(path: Path, target: dict[str, dict[str, str]]) -> None:
    section = ""
    try:
        lines = path.read_text(encoding="utf-8", errors="replace").splitlines()
    except OSError:
        return
    for raw in lines:
        line = raw.strip()
        if not line or line.startswith(("#", ";")):
            continue
        header = SECTION_HEADER.match(line)
        if header:
            section = header.group(1)
            continue
        dotted = DOTTED.match(line)
        if dotted:
            kind = SECTIONS.get(dotted.group(1))
            if kind:
                target.setdefault(kind, {})[dotted.group(2)] = dotted.group(3)
            continue
        kind = SECTIONS.get(section)
        if not kind or "=" not in line:
            continue
        key, value = line.split("=", 1)
        if key.strip():
            target.setdefault(kind, {})[key.strip()] = value


def collect(root: Path, lang: str) -> dict[str, dict[str, str]]:
    result: dict[str, dict[str, str]] = {}
    data_dir = root / "data"
    for mod_dir in sorted(data_dir.iterdir()):
        locale_dir = mod_dir / "locale" / lang
        if not locale_dir.is_dir():
            continue
        for path in sorted(locale_dir.glob("*.cfg")):
            parse_file(path, result)
    return result


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--out", required=True)
    parser.add_argument("--factorio-dir")
    parser.add_argument("--langs", default="en,zh-CN")
    args = parser.parse_args(argv)
    try:
        root = find_install(args.factorio_dir)
        langs = [lang.strip() for lang in args.langs.split(",") if lang.strip()]
        payload = {"schema_version": 1, "factorio": str(root), "languages": langs}
        for lang in langs:
            payload[lang] = collect(root, lang)
        out = Path(args.out)
        out.parent.mkdir(parents=True, exist_ok=True)
        out.write_text(json.dumps(payload, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
        print(json.dumps({
            "ok": True,
            "factorio": str(root),
            "languages": langs,
            "counts": {lang: {kind: len(values) for kind, values in payload[lang].items()} for lang in langs},
            "bytes": out.stat().st_size,
        }, ensure_ascii=False))
        return 0
    except Exception as error:
        print(json.dumps({"ok": False, "error": str(error)}, ensure_ascii=False))
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
