const $ = (id) => document.getElementById(id);
const text = (tag, value, className) => {
  const node = document.createElement(tag);
  node.textContent = value;
  if (className) node.className = className;
  return node;
};

let optionSource = null;

function fillSelect(id, values) {
  const select = $(id);
  const current = select.value;
  select.replaceChildren(
    text("option", "All"),
    ...values.map((value) => {
      const option = text("option", value);
      option.value = value;
      return option;
    }),
  );
  select.firstChild.value = "";
  select.value = values.includes(current) ? current : "";
}

async function load() {
  const params = new URLSearchParams();
  const benchmark = $("filterBenchmark")?.value;
  const variant = $("filterVariant")?.value;
  const model = $("filterModel")?.value;
  if (benchmark) params.set("benchmark", benchmark);
  if (variant) params.set("variant", variant);
  if (model) params.set("model", model);
  const endpoint = params.size ? `/api/leaderboard?${params}` : "/api/leaderboard";
  const response = await fetch(endpoint);
  if (!response.ok) throw new Error(`leaderboard request failed (${response.status})`);
  const data = await response.json();
  if (!optionSource) {
    const all = await fetch("/api/leaderboard").then((entry) => entry.json());
    optionSource = all.groups || [];
    fillSelect("filterBenchmark", [...new Set(optionSource.map((group) => group.benchmark))].sort());
    fillSelect("filterVariant", [...new Set(optionSource.map((group) => group.variant))].sort());
    fillSelect(
      "filterModel",
      [
        ...new Set(optionSource.flatMap((group) => group.runs.map((run) => run.model)).filter(Boolean)),
      ].sort(),
    );
  }
  const root = $("leaderboard");
  root.replaceChildren(
    ...(data.groups || []).map((group) => {
      const section = document.createElement("section");
      section.className = "leaderboard-group";
      const title = document.createElement("div");
      title.className = "section-title";
      title.append(
        text("h2", group.variant || "legacy"),
        text(
          "span",
          `${group.benchmark} · ${group.construction_mode} · blueprints ${group.blueprint_policy}${group.ranked ? "" : " · unranked"}`,
          "muted",
        ),
      );
      const table = document.createElement("table");
      const thead = document.createElement("thead");
      const head = document.createElement("tr");
      for (const label of ["#", "Run", "Model", "State", "Capability", "Completion"]) {
        head.append(text("th", label));
      }
      thead.append(head);
      const tbody = document.createElement("tbody");
      for (const [index, run] of (group.runs || []).entries()) {
        const row = document.createElement("tr");
        const rank = text("td", String(index + 1));
        const linkCell = document.createElement("td");
        const link = text("a", run.name || run.id);
        link.href = `/run.html?run=${encodeURIComponent(run.id)}`;
        linkCell.append(link);
        const capability = run.score == null ? "—" : `${run.score} / 1000`;
        const completion = run.completed
          ? `${Math.round(Number(run.completion_seconds) || 0)}s`
          : "unfinished";
        row.append(
          rank,
          linkCell,
          text("td", run.model || "—"),
          text("td", run.state),
          text("td", capability),
          text("td", `${completion} · ${run.elapsed_seconds}s active`),
        );
        tbody.append(row);
      }
      table.append(thead, tbody);
      section.append(title, table);
      return section;
    }),
  );
  if (!data.groups?.length) root.append(text("p", "No evaluated runs yet.", "muted"));
}

load().catch((error) => {
  $("error").textContent = error.message;
});

for (const id of ["filterBenchmark", "filterVariant", "filterModel"]) {
  $(id)?.addEventListener("change", () => {
    load().catch((error) => {
      $("error").textContent = error.message;
    });
  });
}
