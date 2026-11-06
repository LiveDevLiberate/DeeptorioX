const $ = (id) => document.getElementById(id);

function text(tag, value, className = "") {
  const node = document.createElement(tag);
  node.textContent = value == null ? "—" : String(value);
  if (className) node.className = className;
  return node;
}

function card(title, lines) {
  const section = document.createElement("div");
  section.className = "pipeline-card";
  section.append(text("h3", title));
  const pre = document.createElement("pre");
  pre.textContent = lines.join("\n");
  section.append(pre);
  return section;
}

function render(data) {
  const counts = data.counts || {};
  const countBox = $("pipelineCounts");
  countBox.replaceChildren(...Object.entries(counts).map(([key, value]) => card(key, [String(value)])));

  const bottlenecks = data.bottlenecks || [];
  const table = document.createElement("table");
  const head = document.createElement("tr");
  head.append(
    text("th", "severity"),
    text("th", "kind"),
    text("th", "count"),
    text("th", "node"),
    text("th", "action"),
  );
  table.append(head);
  for (const entry of bottlenecks.slice(0, 30)) {
    const row = document.createElement("tr");
    row.append(
      text("td", entry.severity, entry.severity === "critical" ? "sev-critical" : "sev-warning"),
      text("td", entry.kind),
      text("td", entry.count),
      text("td", entry.node),
      text("td", entry.action),
    );
    table.append(row);
  }
  $("pipelineBottlenecks").replaceChildren(text("h2", `Bottlenecks (${bottlenecks.length})`), table);

  const details = $("pipelineDetails");
  details.replaceChildren(
    card(
      "Machines",
      (data.machines || [])
        .slice(0, 12)
        .map(
          (machine) =>
            `${machine.name} @ ${machine.x},${machine.y} · ${machine.status || "?"} · in ${machine.input_count} / out ${machine.output_count}`,
        ),
    ),
    card(
      "Power networks",
      (data.power_network_groups || [])
        .slice(0, 8)
        .map((network) => `network ${network.id}: ${network.count} poles`),
    ),
    card(
      "Belt segments",
      (data.belt_segments || [])
        .slice(0, 12)
        .map(
          (segment) =>
            `${segment.length} tiles ${segment.head?.x},${segment.head?.y} → ${segment.tail?.x},${segment.tail?.y}`,
        ),
    ),
  );
  $("pipelineContent").hidden = false;
  $("summary").textContent = `window (${data.window?.x}, ${data.window?.y}) radius ${data.window?.radius}`;
}

async function loadPipeline() {
  $("error").textContent = "";
  const x = Number($("centerX").value);
  const y = Number($("centerY").value);
  const radius = Number($("radius").value);
  $("summary").textContent = "Loading pipeline graph…";
  try {
    const response = await fetch("/api/agent/observe/pipeline", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ window: { x, y, radius } }),
    });
    const payload = await response.json();
    if (!response.ok || payload.error) throw new Error(payload.error || `HTTP ${response.status}`);
    render(payload.data || payload);
  } catch (error) {
    $("error").textContent = error instanceof Error ? error.message : String(error);
    $("summary").textContent = "Pipeline graph unavailable. Is the game/RCON running?";
  }
}

$("pipelineForm").addEventListener("submit", (event) => {
  event.preventDefault();
  void loadPipeline();
});
