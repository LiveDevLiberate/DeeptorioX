// Load a registry blueprint into the ported viewer via ?run=<id>&id=<blueprint-id>.
(async function () {
  const params = new URLSearchParams(location.search);
  const run = params.get("run");
  const blueprintId = params.get("id");
  if (!run || !blueprintId || typeof window.FBPViewerLoad !== "function") return;
  try {
    const response = await fetch(
      `/api/runs/${encodeURIComponent(run)}/blueprints/${encodeURIComponent(blueprintId)}`,
    );
    if (!response.ok) throw new Error(`blueprint HTTP ${response.status}`);
    const detail = await response.json();
    if (detail.wire) await window.FBPViewerLoad(detail.wire, detail.label || blueprintId);
  } catch (error) {
    const drop = document.getElementById("drop");
    if (drop) {
      drop.hidden = false;
      const mode = document.getElementById("mode");
      if (mode) mode.textContent = `Could not load blueprint: ${error.message}`;
    }
  }
})();
