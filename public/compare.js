import { $, api, text, duration, detailsUrl, displayModel } from "./run-view.js";
const ids = [...new Set((new URLSearchParams(location.search).get("runs") || "").split(",").filter(Boolean))];
try {
  if (ids.length < 2) throw new Error("Select at least two runs from the history to compare.");
  const runs = await Promise.all(ids.map((id) => api(`/api/runs/${encodeURIComponent(id)}`)));
  // Rank columns by capability (unranked/legacy runs keep their selection order at the end).
  const capabilityOf = (run) => {
    const value = Number(run.evaluation?.capability?.score);
    return Number.isFinite(value) ? value : -1;
  };
  runs.sort((left, right) => capabilityOf(right) - capabilityOf(left));
  const same =
    new Set(runs.map((r) => `${r.hashes?.benchmark}:${r.hashes?.baseline_save}:${r.hashes?.client}`)).size ===
    1;
  $("matching").textContent = same
    ? "Matching benchmark, starting save, and Python client."
    : "Different benchmark, starting save, or Python client; comparison is approximate.";
  const scoringKeys = new Set(
    runs.map((run) => `${run.scoring?.version ?? 0}:${run.scoring?.par_seconds ?? 0}`),
  );
  $("scoringNotice").textContent =
    scoringKeys.size > 1
      ? "Different scoring configuration (version/par) across the selected runs; capability scores are not directly comparable."
      : "";
  const header = document.createElement("tr");
  header.append(text("th", "Metric"));
  runs.forEach((run, index) => {
    const cell = document.createElement("th"),
      link = text("a", run.name || run.id);
    link.href = detailsUrl(run.id);
    cell.append(text("span", `#${index + 1} `, "rank"), link);
    header.append(cell);
  });
  const rows = [
    ["Agent", (r) => displayModel(r.model_label || r.model || r.agent)],
    ["Result", (r) => r.state],
    ["Failure kind", (r) => r.failure_kind || "—"],
    [
      "Capability",
      (r) => {
        const capability = r.evaluation?.capability;
        if (!capability) return "—";
        const suffix = capability.completed
          ? "completed"
          : `${Math.round((Number(capability.progress) || 0) * 100)}%`;
        return `${capability.score} / ${capability.max} · ${suffix}`;
      },
    ],
    [
      "Completion time",
      (r) => {
        const capability = r.evaluation?.capability;
        if (!capability?.completion_seconds) return "—";
        return `${duration(capability.completion_seconds)} (par ${capability.par_seconds}s)`;
      },
    ],
    [
      "Milestones (scored)",
      (r) => {
        const milestones = r.evaluation?.capability?.milestones;
        return milestones ? `${milestones.completed}/${milestones.total}` : "—";
      },
    ],
    [
      "Discipline flags",
      (r) => {
        const flags = r.evaluation?.discipline?.flags;
        return flags?.length ? flags.join(", ") : "—";
      },
    ],
    [
      "Manual mines/crafts",
      (r) => {
        const discipline = r.evaluation?.discipline;
        return discipline ? `${discipline.manual_mines} + ${discipline.manual_crafts}` : "—";
      },
    ],
    [
      "Blackouts",
      (r) =>
        r.evaluation?.discipline
          ? String(r.evaluation.discipline.blackouts)
          : r.automation?.blackouts
            ? String(r.automation.blackouts)
            : "—",
    ],
    [
      "STATE blocked",
      (r) => {
        const discipline = r.evaluation?.discipline;
        return discipline ? `${Math.round(discipline.state_blocked_seconds || 0)}s` : "—";
      },
    ],
    [
      "Refactor debt peak",
      (r) => {
        const discipline = r.evaluation?.discipline;
        return discipline ? String(discipline.refactor?.debt_peak ?? 0) : "—";
      },
    ],
    ["Automation score (legacy)", (r) => (r.automation?.score == null ? "—" : String(r.automation.score))],
    ["Active play time", (r) => duration(r.elapsed_seconds)],
    ["Input tokens", (r) => r.usage?.input_tokens?.toLocaleString() ?? "—"],
    ["Output tokens", (r) => r.usage?.output_tokens?.toLocaleString() ?? "—"],
  ];
  for (const milestone of new Set(runs.flatMap((r) => Object.keys(r.milestones))))
    rows.push([
      milestone,
      (r) => (r.milestones[milestone] ? `${r.milestones[milestone].wall_seconds.toFixed(1)}s` : "—"),
    ]);
  $("comparison").replaceChildren(
    header,
    ...rows.map(([label, value]) => {
      const row = document.createElement("tr");
      row.append(text("th", label), ...runs.map((r) => text("td", value(r))));
      return row;
    }),
  );
} catch (error) {
  $("error").textContent = error.message;
}
