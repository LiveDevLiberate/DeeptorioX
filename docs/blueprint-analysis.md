# Blueprint analysis

`blueprint_analysis/` is adapted from the MIT-licensed
[factorio-blueprint-tools](https://github.com/chrisjmendoza/factorio-blueprint-tools).

## What it analyses

- entity footprints, tile index, inserter pickup/drop geometry;
- underground pairing, belt upstream/downstream and head-on/sideload rules;
- lane-level item sets (`left`/`right`) via a worklist fixed point;
- machine supply: `ok` / `missing` / `unknown`;
- structural lint (dead ends, unpaired undergrounds, useless inserters, ...);
- lane-mix warnings;
- blueprint version diff.

It is a **possibility** analysis: it never simulates item consumption and does
not model throughput or fluids.

## CLI

```bash
factorio.py blueprint-analyze --blueprint-file plan.txt
factorio.py blueprint-analyze --id <registry-id>
factorio.py blueprint-diff --before-file v1.txt --after-file v2.txt
```

## Attribution

See `blueprint_analysis/NOTICE.md` and
`blueprint_analysis/LICENSE.factorio-blueprint-tools` (MIT).

The bundled `data/gamedata.json` is from factorio-blueprint-tools
(Factorio 2.0.77 + Space Age) and should be regenerated from the local install
before relying on current-version recipes/footprints.

## Viewer

`public/blueprint-viewer/` is a full port of the MIT factorio-blueprint-tools
viewer (canvas pan/zoom, belt tiers, underground pairing, inserter pickup/drop,
splitter filtering, lane flow, edit/patch/export features). It is linked from
the run page blueprint cards and the main navigation as **Blueprint viewer**.
Open a registry blueprint via:

```text
/blueprint-viewer/viewer.html?run=<run-id>&id=<blueprint-id>
```

`gamedata.js` is generated from the local Factorio 2.1.24 `--dump-data` file.
