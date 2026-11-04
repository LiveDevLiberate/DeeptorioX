#!/usr/bin/env python3
"""Generate the checked-in agent tool manifest from source code.

The manifest is the single discovery document agents fetch at runtime
(`GET /api/agent/tools` or `factorio.py tools`) and is generated from
`factorio.py` (FactorioClient signatures/docstrings + CLI usage) and the agent
HTTP routes in `src/api/agent.ts`. This keeps discovery in sync with the code
instead of requiring agents to read implementation files.
"""

from __future__ import annotations

import hashlib
import json
import pathlib
import re
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

import factorio  # noqa: E402  (needs the ROOT import path above)

MANIFEST_PATH = ROOT / "public" / "tool-manifest.json"
API_SOURCES = sorted((ROOT / "src" / "api").glob("*.ts"))
ENDPOINT_PATTERN = re.compile(
    r'method:\s*"(GET|POST|PUT|PATCH|DELETE)"\s*,\s*(?:\r?\n\s*)?path:\s*"(/api/agent/[^"]+)"'
)


def source_hash(path: pathlib.Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def manager_endpoints() -> list[dict[str, str]]:
    endpoints: dict[tuple[str, str], dict[str, str]] = {}
    for path in API_SOURCES:
        source = path.read_text(encoding="utf-8")
        for method, endpoint in ENDPOINT_PATTERN.findall(source):
            endpoints[(method, endpoint)] = {"method": method, "path": endpoint}
    return sorted(endpoints.values(), key=lambda item: (item["path"], item["method"]))


def build_manifest() -> dict:
    manifest = factorio.tool_manifest()
    manifest["manager_endpoints"] = manager_endpoints()
    manifest["sources"] = {
        "factorio.py": source_hash(ROOT / "factorio.py"),
        **{
            str(path.relative_to(ROOT)).replace("\\", "/"): source_hash(path)
            for path in API_SOURCES
        },
    }
    return manifest


def render(manifest: dict) -> str:
    return json.dumps(manifest, indent=2, sort_keys=True, ensure_ascii=False) + "\n"


def main(argv: list[str]) -> int:
    manifest = build_manifest()
    rendered = render(manifest)
    if "--check" in argv:
        try:
            current = MANIFEST_PATH.read_text(encoding="utf-8")
        except FileNotFoundError:
            current = ""
        if current != rendered:
            print(
                "tool manifest is stale: run `npm run tools:manifest` "
                "(or python3 scripts/generate-tool-manifest.py)",
                file=sys.stderr,
            )
            return 1
        print("tool manifest is current")
        return 0
    MANIFEST_PATH.parent.mkdir(parents=True, exist_ok=True)
    MANIFEST_PATH.write_text(rendered, encoding="utf-8")
    print(f"wrote {MANIFEST_PATH.relative_to(ROOT)} ({len(rendered)} bytes)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
