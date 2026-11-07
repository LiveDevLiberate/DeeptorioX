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
