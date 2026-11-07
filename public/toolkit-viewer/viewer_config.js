// autorio default: one generated preview, optionally selected by query.
const _params = new URLSearchParams(location.search);
const _image = _params.get("image");
const _planet = _params.get("planet") || "nauvis";
const viewerConfig = {
  planetPreviewSources: _image
    ? { [_planet]: _image }
    : {
        nauvis: "/api/map-previews/16612810cb57bdcb.png",
      },
  planetNamesSource: "/toolkit-viewer/planet_names.js",
};
