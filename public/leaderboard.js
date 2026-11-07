const $ = (id) => document.getElementById(id);
const text = (tag, value, className) => {
  const node = document.createElement(tag);
  node.textContent = value;
  if (className) node.className = className;
  return node;
};

async function load() {
  const response = await fetch("/api/leaderboard");
  if (!response.ok) throw new Error(`leaderboard request failed (${response.status})`);
  const data = await response.json();
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
