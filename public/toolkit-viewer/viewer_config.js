// autorio default: one generated preview, optionally selected by query.
const _params = new URLSearchParams(location.search);
const _image = _params.get("image");
const _imagesRaw = _params.get("images");
const _planet = _params.get("planet") || "nauvis";
let _sources = {};
if (_imagesRaw) {
  try {
    _sources = JSON.parse(_imagesRaw);
  } catch {
    _sources = {};
  }
}
if (!Object.keys(_sources).length && _image) _sources = { [_planet]: _image };
if (!Object.keys(_sources).length) _sources = { nauvis: "/api/map-previews/16612810cb57bdcb.png" };
const viewerConfig = {
  planetPreviewSources: _sources,
  planetNamesSource: "/toolkit-viewer/planet_names.js",
};
