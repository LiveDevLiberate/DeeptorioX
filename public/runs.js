import { $, api, text, duration, activeStates, renderProgress, detailsUrl } from "./run-view.js";
let runs = [],
  benchmarks = [],
  mapConfig = null,
  currentId,
  polling = false;
const FALLBACK_MAP_CONFIG = {
  resources: [
    { id: "iron-ore", label: "Iron ore" },
    { id: "copper-ore", label: "Copper ore" },
    { id: "coal", label: "Coal" },
    { id: "stone", label: "Stone" },
    { id: "crude-oil", label: "Crude oil" },
    { id: "uranium-ore", label: "Uranium ore" },
    { id: "water", label: "Water" },
    { id: "trees", label: "Trees" },
    { id: "rocks", label: "Rocks" },
    { id: "enemy-base", label: "Enemy bases" },
  ],
  presets: [
    { value: 0, label: "None" },
    { value: 0.5, label: "Very low" },
    { value: 0.75, label: "Low" },
    { value: 1, label: "Normal" },
    { value: 1.5, label: "High" },
    { value: 2, label: "Very high" },
    { value: 4, label: "Extreme" },
  ],
  fields: ["frequency", "size", "richness"],
  limits: { seed: { min: 0, max: 4294967295 }, starting_area: { min: 0.5, max: 10 } },
};
function mapConfigData() {
  return mapConfig?.resources?.length ? mapConfig : FALLBACK_MAP_CONFIG;
}
function selectedBenchmark() {
  return benchmarks.find((benchmark) => benchmark.id === $("benchmark").value);
}
function addMapOption(select, value, label) {
  const option = document.createElement("option");
  option.value = value;
  option.textContent = label;
  select.append(option);
}
function updateMapConfigSummary() {
  const seed = $("mapSeed").value || "—";
  const resources = new Set();
  for (const select of document.querySelectorAll("#mapResources select")) {
    if (select.value !== "") resources.add(select.dataset.resource);
  }
  $("mapConfigSummary").textContent =
    `seed ${seed} · ${resources.size} resource override${resources.size === 1 ? "" : "s"}`;
}
function renderMapConfig(benchmark) {
  const map = benchmark?.map_gen && typeof benchmark.map_gen === "object" ? benchmark.map_gen : {};
  const controls =
    map.autoplace_controls && typeof map.autoplace_controls === "object" ? map.autoplace_controls : {};
  $("mapSeed").value = map.seed != null ? String(map.seed) : "";
  $("mapPeaceful").checked = Boolean(map.peaceful_mode);
  $("mapStartingArea").value = map.starting_area != null ? String(map.starting_area) : "";
  const meta = mapConfigData();
  const resources = [...meta.resources];
  const known = new Set(resources.map((resource) => resource.id));
  for (const id of Object.keys(controls)) {
    if (!known.has(id)) resources.push({ id, label: id });
  }
  const rows = resources.map((resource) => {
    const row = document.createElement("tr");
    row.append(text("th", resource.label || resource.id));
    row.firstChild.scope = "row";
    for (const field of meta.fields) {
      const cell = document.createElement("td");
      const select = document.createElement("select");
      select.className = "map-control";
      select.dataset.resource = resource.id;
      select.dataset.field = field;
      select.setAttribute("aria-label", `${resource.label || resource.id} ${field}`);
      addMapOption(select, "", "Default");
      const presetValues = new Set();
      for (const preset of meta.presets) {
        presetValues.add(String(preset.value));
        addMapOption(select, String(preset.value), preset.label);
      }
      const current = controls[resource.id]?.[field];
      if (current != null && !presetValues.has(String(current))) {
        addMapOption(select, String(current), `Custom (${current})`);
      }
      select.value = current != null ? String(current) : "";
      select.onchange = updateMapConfigSummary;
      cell.append(select);
      row.append(cell);
    }
    return row;
  });
  $("mapResources").replaceChildren(...rows);
  updateMapConfigSummary();
}
function buildMapGen() {
  const benchmark = selectedBenchmark();
  if (!benchmark) throw new Error("Select a benchmark first");
  const seed = Number($("mapSeed").value);
  if (!Number.isInteger(seed) || seed < 0 || seed > 4294967295) {
    throw new Error("Seed must be an integer between 0 and 4294967295");
  }
  const mapGen = {
    ...(benchmark.map_gen && typeof benchmark.map_gen === "object" ? benchmark.map_gen : {}),
    seed,
  };
  mapGen.peaceful_mode = $("mapPeaceful").checked;
  const startingArea = $("mapStartingArea").value.trim();
  if (startingArea) {
    const value = Number(startingArea);
    if (!Number.isFinite(value) || value < 0.5 || value > 10) {
      throw new Error("Starting area must be a number between 0.5 and 10");
    }
    mapGen.starting_area = value;
  } else {
    delete mapGen.starting_area;
  }
  const controls = {};
  for (const select of document.querySelectorAll("#mapResources select")) {
    if (select.value === "") continue;
    const resource = select.dataset.resource;
    const field = select.dataset.field;
    if (!resource || !field) continue;
    controls[resource] ||= {};
    controls[resource][field] = Number(select.value);
  }
  mapGen.autoplace_controls = controls;
  return mapGen;
}
const checked = new Set();
function renderHistory() {
  $("runs").replaceChildren(
    ...runs.map((run) => {
      const row = document.createElement("tr"),
        box = document.createElement("input");
      box.type = "checkbox";
      box.checked = checked.has(run.id);
      box.setAttribute("aria-label", `Compare ${run.name || run.id}`);
      box.onchange = () => {
        if (box.checked) checked.add(run.id);
        else checked.delete(run.id);
        $("compare").disabled = checked.size < 2;
      };
      const select = document.createElement("td");
      select.append(box);
      row.append(select);
      const link = text("a", run.name || run.id);
      link.href = detailsUrl(run.id);
      link.title = run.id;
      const name = document.createElement("td");
      name.append(link);
      row.append(name);
      for (const value of [
        run.benchmark.id,
        run.model_label || run.model || run.agent,
        `${run.state}${run.failure_kind ? ` (${run.failure_kind})` : ""}`,
        duration(run.elapsed_seconds),
      ])
        row.append(text("td", value));
      return row;
    }),
  );
  $("emptyHistory").hidden = runs.length > 0;
  $("launch").disabled = runs.some((r) => activeStates.includes(r.state));
  $("compare").disabled = checked.size < 2;
}
async function refresh() {
  if (polling) return;
  polling = true;
  try {
    runs = (await api("/api/runs")).runs;
    for (const id of checked) if (!runs.some((r) => r.id === id)) checked.delete(id);
    renderHistory();
    const current = runs.find((r) => activeStates.includes(r.state)) || runs[0];
    currentId = current?.id;
    if (current) {
      renderProgress(current);
      $("detailsLink").href = detailsUrl(current.id);
      $("detailsLink").hidden = false;
    }
    const active = Boolean(current && activeStates.includes(current.state));
    $("pause").disabled = !current || current.state !== "running";
    $("pause").hidden = !active;
    $("stop").disabled = !active;
    $("resume").hidden = !current || !current.resumable;
    $("resume").disabled = !current?.resumable || current?.video?.state === "rendering";
    $("error").textContent = "";
  } catch (error) {
    $("error").textContent = error.message;
  } finally {
    polling = false;
  }
}
$("benchmark").onchange = () => {
  const benchmark = selectedBenchmark();
  if (!benchmark) return;
  $("task").textContent = benchmark.task;
  $("seconds").value = benchmark.max_seconds;
  renderMapConfig(benchmark);
};
$("mapReset").onclick = () => {
  const benchmark = selectedBenchmark();
  if (benchmark) renderMapConfig(benchmark);
};
for (const id of ["mapSeed", "mapStartingArea", "mapPeaceful"]) {
  $(id).addEventListener("input", updateMapConfigSummary);
  $(id).addEventListener("change", updateMapConfigSummary);
}
let launchMapViewer = null;
$("previewMap").onclick = async () => {
  const button = $("previewMap");
  button.disabled = true;
  $("launchMapPreviewStatus").textContent = "Generating 2048×2048 preview…";
  try {
    const result = await api("/api/map-preview", { map_gen: buildMapGen(), size: 2048 });
    $("launchMapPreview").hidden = false;
    if (!launchMapViewer) launchMapViewer = globalThis.createMapViewer($("launchMapPreview"), result.url);
    else launchMapViewer.setSource(result.url);
    $("launchMapPreviewStatus").textContent = `seed ${result.seed} · ${result.size}px`;
  } catch (error) {
    $("launchMapPreviewStatus").textContent = error.message;
  } finally {
    button.disabled = false;
  }
};
$("launchForm").onsubmit = async (event) => {
  event.preventDefault();
  $("launch").disabled = true;
  try {
    const preset = $("model").selectedOptions[0];
    await api("/api/runs", {
      benchmark: $("benchmark").value,
      model: preset.dataset.model,
      reasoning_effort: preset.dataset.thinking,
      max_seconds: Number($("seconds").value),
      agent: preset.dataset.agent || "opencode",
      terminal: false,
      capture_video: $("captureVideo").checked,
      map_gen: buildMapGen(),
    });
    await refresh();
  } catch (error) {
    $("error").textContent = error.message;
    $("launch").disabled = false;
  }
};
$("pause").onclick = async () => {
  if (!currentId) return;
  $("pause").disabled = true;
  try {
    await api(`/api/runs/${encodeURIComponent(currentId)}/pause`, {});
    await refresh();
  } catch (error) {
    $("error").textContent = error.message;
    $("pause").disabled = false;
  }
};
$("resume").onclick = async () => {
  if (!currentId) return;
  $("resume").disabled = true;
  try {
    await api(`/api/runs/${encodeURIComponent(currentId)}/resume`, {});
    await refresh();
  } catch (error) {
    $("error").textContent = error.message;
    $("resume").disabled = false;
  }
};
$("stop").onclick = async () => {
  if (!currentId) return;
  $("stop").disabled = true;
  try {
    await api(`/api/runs/${encodeURIComponent(currentId)}/stop`, {});
    await refresh();
  } catch (error) {
    $("error").textContent = error.message;
  }
};
$("compare").onclick = () => {
  if (checked.size >= 2)
    location.href = `/compare.html?runs=${[...checked].map(encodeURIComponent).join(",")}`;
};
try {
  benchmarks = (await api("/api/benchmarks")).benchmarks;
  try {
    mapConfig = await api("/api/map-config");
  } catch {
    mapConfig = null;
  }
  $("benchmark").replaceChildren(
    ...benchmarks.map((b) => {
      const option = text("option", b.title);
      option.value = b.id;
      return option;
    }),
  );
  $("benchmark").value = "smoke";
  $("benchmark").onchange();
  await refresh();
  setInterval(refresh, 1000);
} catch (error) {
  $("error").textContent = error.message;
}

void api("/api/obs/status")
  .then((status) => {
    $("captureVideo").checked = status.enabled;
    $("obsStatus").textContent = status.connected
      ? "OBS connected · 5 fps capture → 30 fps playback · silent 6× timelapse"
      : "OBS is not connected. Enable its authenticated WebSocket server to record timelapses.";
  })
  .catch(() => {
    $("obsStatus").textContent = "OBS status unavailable.";
  });
