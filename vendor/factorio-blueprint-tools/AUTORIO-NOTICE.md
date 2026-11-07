# Autorios vendored copy

Source: https://github.com/chrisjmendoza/factorio-blueprint-tools (MIT).

Full upstream `fbp` source, tests, docs, VS Code assets and viewer are vendored
under this directory. `data/gamedata.json` is replaced with data generated from
the local Factorio 2.1.24 `--dump-data`.

Run the full CLI with:

```bash
python3 tools/fbp_cli.py info <blueprint.txt> --counts
python3 tools/fbp_cli.py flow <blueprint.txt> --json out.json
python3 tools/fbp_cli.py render <blueprint.txt> --png out.png
python3 tools/fbp_cli.py patch <blueprint.txt> patch.json -o out.txt
```

`blueprint_analysis/` is the adapted integration layer used by `factorio.py`;
the vendored upstream remains available for commands not yet wrapped.
