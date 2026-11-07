# Vendored MIT toolkits

## FactorioPreviewToolkit

Full upstream source, assets, config and viewer are under
`vendor/factorio-preview-toolkit/` (MIT, v0.1.74). The bundled rclone binaries
are omitted due size; install rclone or point `rclone_executable` at it.

`tools/preview_toolkit_cli.py` runs the upstream preview generator. Its optional
runtime dependencies are listed in `tools/requirements-preview-toolkit.txt`.
autorio's own map preview API (`src/map-preview.ts`) is independent and already
usable without these dependencies.

The upstream viewer is hosted at `/toolkit-viewer/index.html` with a default
Nauvis preview; its `viewer_config.js` can hold multi-planet URLs.

## factorio-blueprint-tools

Full upstream `fbp` source, tests, docs, VS Code assets and viewer are under
`vendor/factorio-blueprint-tools/` (MIT). `tools/fbp_cli.py` runs all upstream
commands:

```bash
python3 tools/fbp_cli.py info public/blueprint-viewer/sample.txt --counts
python3 tools/fbp_cli.py flow public/blueprint-viewer/sample.txt --json /tmp/flow.json
python3 tools/fbp_cli.py render public/blueprint-viewer/sample.txt --png /tmp/mall.png
python3 tools/fbp_cli.py patch <in.txt> patch.json -o out.txt
```

`blueprint_analysis/` is autorio's integrated subset used by `factorio.py`;
`public/blueprint-viewer/` hosts the full viewer.

## Map exchange strings

`tools/preview_toolkit_exchange.py` runs the vendored dummy-save + control.lua
pipeline to extract map-gen settings and planets. The manager exposes:

```http
POST /api/map-preview/exchange
{"map_string": ">>>eN...<<<", "size": 2048}
```

It returns one PNG per planet (`nauvis`, `vulcanus`, `gleba`, `fulgora`,
`aquilo`) using a separate Space Age preview profile. The launch page has an
**Import map exchange string** section and planet tabs; it can be opened
directly with `?exchange=<urlencoded string>`.

Python:

```bash
factorio.py map-preview-exchange --string-file map.txt --size 2048
```

## Launchers

```bash
python3 tools/preview_toolkit_cli.py --info          # paths, config, dependency status
python3 tools/preview_toolkit_cli.py --config --json # vendored config.ini
python3 tools/preview_toolkit_cli.py --preview-generator-mode <factorio> <map_string>
python3 tools/preview_toolkit_cli.py --uploader-mode
```

The full controller/clipboard mode needs the optional dependencies in
`tools/requirements-preview-toolkit.txt`; `--info` and `--config` are
dependency-free. rclone binaries are intentionally absent; install rclone or
place it under `vendor/factorio-preview-toolkit/third_party/rclone/`.

`factorio.py blueprint-tools <args>` is a passthrough to the complete vendored
`fbp` CLI, e.g.:

```bash
factorio.py blueprint-tools info FILE --counts
factorio.py blueprint-tools flow FILE --json out.json
factorio.py blueprint-tools render FILE --png out.png
factorio.py blueprint-tools patch FILE patch.json -o out.txt
```
