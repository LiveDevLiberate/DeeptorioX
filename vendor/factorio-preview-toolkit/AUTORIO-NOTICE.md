# Autorios vendored copy

Source: https://github.com/AntiElitz/FactorioPreviewToolkit (MIT), version tag
v0.1.74.

The upstream source, assets, viewer and config are vendored verbatim under this
directory. The bundled rclone binaries (`third_party/rclone/*/<arch>/`) are NOT
committed because they total ~370 MB; only the rclone LICENSE is retained.
Use `rclone_executable = auto` with an installed rclone, or place binaries here.

Runtime dependencies are the upstream pyproject dependencies (Pillow, psutil,
pydantic, pygame, pyperclip, pywin32/pyobjc). They are not required by autorio's
own map-preview API; they are required for the full clipboard/window/uploader
toolkit. Install them in the Python environment used to run
`tools/preview_toolkit_cli.py`.

The `viewer/` directory is the upstream static viewer. autorio hosts its own
simplified map viewer for generated PNGs; the full viewer can be served
separately from this vendored directory.
