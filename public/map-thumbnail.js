// Compact charted-map thumbnail shared by the recording and run pages.
// Fetches /api/agent/observe/map-overview and paints its ASCII rows on a canvas.
(function () {
  const COLORS = {
    "?": "#111a1e",
    "~": "#2e698a",
    ".": "#354a3b",
    "#": "#c7a35a",
    "*": "#d6b54b",
    "@": "#e8664f",
  };
  const DEFAULT_LABELS = {
    "?": "uncharted",
    "~": "water",
    ".": "land",
    "#": "player entity",
    "*": "resource",
    "@": "player",
  };
  function text(tag, value, className) {
    const node = document.createElement(tag);
    if (value) node.textContent = value;
    if (className) node.className = className;
    return node;
  }
  function canvasFor(rows) {
    if (!Array.isArray(rows) || !rows.length) return null;
    const width = Math.max(1, ...rows.map((row) => row.length));
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = rows.length;
    canvas.className = "map-thumbnail-canvas";
    canvas.setAttribute("role", "img");
    canvas.setAttribute("aria-label", "Charted map thumbnail");
    const context = canvas.getContext("2d");
    if (!context) return null;
    context.fillStyle = COLORS["?"];
    context.fillRect(0, 0, canvas.width, canvas.height);
    for (let y = 0; y < rows.length; y += 1) {
      const row = rows[y];
      for (let x = 0; x < row.length; x += 1) {
        context.fillStyle = COLORS[row[x]] || "#42525a";
        context.fillRect(x, y, 1, 1);
      }
    }
    return canvas;
  }
  async function renderMapThumbnail(container, options) {
    if (!container) return;
    const settings = options || {};
    const loading = text("p", settings.loading || "Loading map…", "map-thumbnail-note");
    container.replaceChildren(loading);
    container.hidden = false;
    try {
      const response = await fetch("/api/agent/observe/map-overview", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          window: {
            x: Number(settings.x) || 0,
            y: Number(settings.y) || 0,
            radius: Number(settings.radius) || 256,
          },
          size: Number(settings.size) || 96,
        }),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok || !payload.ok) {
        throw new Error(payload.error || "Map unavailable");
      }
      const data = payload.data || {};
      const canvas = canvasFor(data.rows);
      if (!canvas) throw new Error("Map is empty");
      const labels = { ...DEFAULT_LABELS, ...(settings.labels || {}) };
      const legend = document.createElement("div");
      legend.className = "map-thumbnail-legend";
      for (const [glyph, label] of Object.entries(labels)) {
        const item = text("span", `${glyph} ${label}`, "map-thumbnail-legend-item");
        item.style.setProperty("--map-color", COLORS[glyph] || "#42525a");
        legend.append(item);
      }
      const meta = text(
        "p",
        `${data.charted_samples || 0}/${data.samples || 0} charted · radius ${settings.radius || 256} · ${data.step || 1}-tile cells`,
        "map-thumbnail-note",
      );
      container.replaceChildren(canvas, legend, meta);
    } catch (error) {
      container.replaceChildren(
        text("p", settings.unavailable || "Map thumbnail is unavailable.", "map-thumbnail-note"),
      );
    }
  }
  globalThis.renderMapThumbnail = renderMapThumbnail;
})();
