# Changelog

All notable changes to fbp are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added
- `fbp icons` builds an icon atlas from a local Factorio installation, and the
  viewer draws real item and machine icons: the product on each machine, the
  items on each belt lane once zoomed in, and icons in the legend, the
  missing-inputs list and the recipe picker. The game's art is not
  redistributable, so the atlas is generated locally and git-ignored, and the
  viewer falls back to coloured tiles without it.
- The side panel leads with the machine's recipe: the current recipe, the flow
  verdict beneath it, and a search box listing only the recipes that machine's
  crafting categories allow, so an assembler is never offered a smelting recipe.
- `fbp gamedata` also writes crafting categories for the viewer.
- Hovering an inserter in the viewer highlights the tile it picks up from in
  blue and the tile it drops onto in green, outlining the chest or machine on
  each; a long-handed inserter also shows the tile it reaches over, dashed.
  A drop onto a belt highlights only the lane the items land on, using the same
  rule the flow uses (now exported from `flow.js`, so the two cannot disagree).
- `fbp icons` finds every item-like prototype instead of only `item` groups, so
  science packs, ammo, modules, capsules, armour, guns and equipment now have
  icons, along with fluids and more buildings: 395 icons for a Space Age install
  where there were 258. Mod items are picked up the same way.
- The viewer draws an icon for any building the atlas knows, not just crafters
  and furnaces, so radars, roboports, tanks and turrets are recognisable; 1x1
  entities (chests, poles, lamps, pipes, combinators) get theirs once tiles are
  at least 12 px. Belts and inserters keep their arrows.

- Filtered and priority splitters are marked in the viewer: a bar across the
  preferred output edge, drawn in the filtered item's colour with that item's
  icon on the cell it leaves by, and a dimmer bar on a preferred input. The side
  panel lists the filter and the priorities, and points out a filter with no
  output priority, which does nothing. The drawing uses the same left/right rule
  as the flow, and the smoke test checks the mark lands on the cell the flow
  sends the filtered item out of.

- `scripts/build-web.sh` and `vercel.json` publish the viewer as a static site:
  `viewer.html` becomes `index.html`, the example blueprint ships as
  `sample.txt` behind a **load an example blueprint** button, and the icon atlas
  is replaced by a stub, since Factorio's art is not ours to redistribute. The
  smoke test runs against the built bundle as well as the source folder.

- The viewer takes an icon atlas by hand: **icons…** loads the `icons.png` and
  `icons.js` that `fbp icons` built on your machine and keeps them in IndexedDB,
  which is how the hosted page gets icons without anyone serving Wube's art.

### Changed
- Zoomed in past 8 px a tile the map reads more like the game: belts are a dark
  track under two bright chevrons a tile instead of a flat tile with one
  triangle, and multi-tile machines get a lit top-left edge and a shaded
  bottom-right one. Zoomed out, belts stay solid tier colours.
- Underground tunnel lines are drawn a segment per tile and dim themselves only
  where they need to: solid over belts and open ground, faint across a machine,
  chest or pole so the icon and text underneath stay readable. The dash is the
  tier's light colour over a dark casing, since a yellow dash on a yellow belt
  could not be seen at all, and hovering either end draws the whole run solid.

### Fixed
- Two belts facing each other no longer connect in the flow or in `fbp trace`.
  A belt running head-on into the hood of an underground entrance (or into the
  front of any belt) was treated as a sideload, so its items leaked into the
  tunnel and onto every belt downstream; in game they pile up at the end of the
  belt. Same fix in the viewer's JavaScript port.

## [0.2.0] - 2026-09-12

### Added
- `fbp flow`: lane-level item flow. Computes what can be on the left and right
  lane of every belt from inserter drops (far lane), curves, sideloads (near
  lane), underground half-blocking, splitter filters, crafter products, furnace
  smelting and chest relays, to a fixed point with a worklist. Machines get a
  status: ok, missing inputs, or unknown.
- Edge feeds: declare items entering the print from outside in
  `<name>.feeds.json` (`{"x","y","items","lane"}`), so a furnace column fed iron
  ore resolves to iron plate all the way down the bus.
- `fbp diff A B`: compares two versions by machine position and reports changed
  recipes, inputs and outputs with ingredient status, plus check problems, lint
  findings and lane-mix warnings that appeared or went away. Exit code 1 when
  anything new appears.
- `fbp lint`: geometry checks that need no recipe data — belt dead ends, belts
  pointing into machines, unpaired undergrounds, starved splitters, inserters
  that pick from or drop onto nothing or onto poles and lamps.
- `fbp trace --at X Y`: for a belt tile, the upstream line and every consumer
  downstream through undergrounds and splitters.
- Lane-mix warnings in `fbp check`: inserters putting two different items on the
  same lane of one belt line, with the inserter counts per item.
- **VS Code extension** in `vscode/`: pan-and-zoom canvas viewer with hover
  details, click-to-pin with copy id/position/JSON, search highlighting, a wire
  overlay, recipe labels, a tile grid and an on-map legend. Commands to run
  `check` and `trace` from the editor into an output channel.
- Viewer edit mode: remove, rotate, flip underground ends, change a machine's
  recipe from a searchable list, and place belts, undergrounds, splitters,
  inserters, chests, poles, machines and pipes from a palette with a placement
  ghost, shift-drag painting, per-edit revert and undo. Edits accumulate as a
  patch in the `fbp patch` format; the page never mutates the blueprint.
- Viewer export: writes the patch beside the source under `patches/`, runs `fbp
  patch` into a new `<name> - edit N.txt` (never overwriting the source), then
  `fbp diff` and `fbp check`, and reloads the viewer on the result.
- The viewer computes flow in the page (`vscode/media/flow.js`, a port of
  `fbp/flow.py` checked against it by a test), with game data shipped as
  `gamedata.js`. Flow, feeds, editing and rendering therefore work in any
  browser, not only in the VS Code panel.
- Belts, undergrounds and splitters are coloured by tier (yellow, red, blue,
  green for turbo); undergrounds draw a dashed tunnel to their partner, unpaired
  ends are outlined red, and hovering one shades every tile it can reach.
  Inserters are coloured by type and drawn as an arrow in the direction the item
  travels. Red machines are labelled with what they are missing.
- `docs/belt-patterns.md`: sourced reference on lane mechanics, sideloading, the
  underground lane filter, splitter filters and mall belt conventions.
- `tests/test_viewer_assets.py`: checks that every id the viewer script looks up
  exists in the page, every control is read by the script, every class is
  styled, and the layout uses flex rather than hardcoded heights.

### Fixed
- Flow: a belt running into the side of an underground *exit* now feeds it, with
  only the lane aligned with the open half passing. Previously exits received
  from their tunnel only, so lines that end this way appeared empty and dozens of
  well-fed machines were reported as missing inputs.
- Flow and lane-mix: long-handed inserters were assigned the wrong lane because
  a two-tile offset was compared against a unit vector.
- Viewer: the flow was computed before the entity list was rebuilt on load, so it
  ran on an empty layout and produced no lanes.
- Viewer: the side panel was pushed off-screen by the canvas, and the toolbars
  were clipped whenever a bar wrapped; the layout is now a flex column.
- Viewer: the palette direction now means the direction items move, for
  inserters too, rather than the stored pickup side.
- `fbp check` reported fluid-only recipes (refineries, cracking, sulfur, acid) as
  missing inserters. Recipes with no item ingredients or no item results are now
  skipped on that side.
- `fbp trace` printed belt bounding boxes with x and y interleaved.

## [0.1.0] - 2026-09-12

### Added
- `fbp` command line: `info`, `decode`, `encode`, `render` (ASCII and PNG),
  `find`, `trace`, `check`, `patch`, `crop`, `gamedata`, `recipe`.
- Belt graph tracer that follows underground pairs and splitters and infers what
  a belt carries from its producers.
- Supply check that flags crafters with an ingredient nothing adjacent can
  supply, and reports externally fed belts as inconclusive rather than clean.
- JSON patch format for remove / re-recipe / add with collision and wire checks
  and contiguous renumbering.
- Game data boiled down from `factorio --dump-data` into `data/gamedata.json`
  (668 recipes, 396 footprints from Factorio 2.0.77 with Space Age).
- Test suite with a cropped real mall as fixture.

[Unreleased]: https://github.com/chrisjmendoza/factorio-blueprint-tools/compare/v0.2.0...HEAD
[0.2.0]: https://github.com/chrisjmendoza/factorio-blueprint-tools/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/chrisjmendoza/factorio-blueprint-tools/releases/tag/v0.1.0
