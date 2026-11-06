# Map generation preview

Pre-game terrain previews are generated with Factorio's own CLI using an isolated
profile, based on the approach used by
[AntiElitz/FactorioPreviewToolkit](https://github.com/AntiElitz/FactorioPreviewToolkit)
(MIT). We do not parse save files; Factorio renders the PNG.

## Flow

1. `POST /api/map-preview` with the launch form's `map_gen`, or
   `POST /api/runs/:id/map-preview` for a recorded run.
2. `generateMapPreview` writes map-gen settings and runs:

   ```text
   factorio --config <isolated>/config.ini --mod-directory <isolated>/mods
     --generate-map-preview=<out>.png
     --map-gen-settings=<settings>.json
     --map-preview-size=2048
     --map-preview-planet=nauvis
   ```

3. The PNG is cached under `.autorio/map-previews/<hash>.png` and served at
   `/api/map-previews/<hash>.png`.
4. `public/map-viewer.js` provides wheel zoom, drag pan, arrow/WASD pan and
   double-click reset. It is adapted from the MIT-licensed toolkit viewer.

## UI

- Launch page: **Preview map** button beside **Start run**.
- Run page: **Seed map preview** section with **Generate preview**.
- The preview uses the selected benchmark and current map-generation settings;
  it does not include buildings or live factory state.

## Isolation

The preview uses `.autorio/map-preview-profile` as its own Factorio config and
write-data directory, so it does not share the running game's save/lock paths.
