import { ProductionChart } from "./production-chart.js";
import { $, api, apiRequest, text, renderProgress, recordingUrl, displayModel } from "./run-view.js";
const id = new URLSearchParams(location.search).get("run"),
  chart = new ProductionChart();
let offset = 0,
  polling = false;
let videoSegments = [],
  selectedVideoSegment = null;
let blueprints = [];
let blueprintsLoaded = false;
let blueprintsLoading = false;
let toolCalls = null;
let toolCallsLoading = false;
let toolCallsError = false;
let stateHistory = null;
let stateHistoryLoading = false;
function closePreview() {
  $("previewOverlay").hidden = true;
  $("previewBody").replaceChildren();
}
function openPreview(url, title, kind = "iframe") {
  $("previewTitle").textContent = title || "Preview";
  $("previewNewTab").href = url;
  $("previewBody").replaceChildren();
  $("previewOverlay").hidden = false;
  if (kind === "image") {
    const host = document.createElement("div");
    host.className = "map-viewer";
    $("previewBody").append(host);
    globalThis.createMapViewer(host, url);
  } else {
    const frame = document.createElement("iframe");
    frame.src = url;
    frame.title = title || "Preview";
    frame.loading = "eager";
    $("previewBody").append(frame);
  }
}
$("previewClose").onclick = closePreview;
$("previewOverlay").addEventListener("click", (event) => {
  if (event.target === $("previewOverlay")) closePreview();
});
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && !$("previewOverlay").hidden) closePreview();
});

function renderVideo() {
  const segment = videoSegments.find((segment) => String(segment.index) === selectedVideoSegment);
  const video = segment?.video;
  $("videoStatus").textContent = video
    ? video.error || `${video.state} · 5 fps capture → 30 fps playback · silent 6× speed`
    : "";
  const ready = video?.state === "ready";
  $("runVideo").hidden = !ready;
  $("videoDownload").hidden = !ready;
  if (ready) {
    const url = `/api/runs/${encodeURIComponent(id)}/video${segment.index ? `?segment=${segment.index}` : ""}`;
    if ($("runVideo").getAttribute("src") !== url) $("runVideo").src = url;
    $("videoDownload").href = url;
    $("videoDownload").download = `${id}${segment.index ? `-segment-${segment.index}` : ""}-6x.mp4`;
  } else if ($("runVideo").hasAttribute("src")) {
    $("runVideo").pause();
    $("runVideo").removeAttribute("src");
    $("runVideo").load();
  }
}
$("videoSegment").onchange = () => {
  selectedVideoSegment = $("videoSegment").value;
  renderVideo();
};
function renderBlueprints() {
  const count = $("blueprintCount");
  count.textContent = String(blueprints.length);
  $("blueprintsSummary").textContent = blueprints.length ? `${blueprints.length} available to the agent` : "";
  $("blueprintsNote").hidden = blueprints.length > 0;
  $("blueprintsNote").textContent = blueprints.length
    ? ""
    : "No blueprints saved yet. The agent can save one with factorio.py or the blueprint tools.";
  const list = $("blueprintList");
  list.replaceChildren(
    ...blueprints.map((blueprint) => {
      const card = document.createElement("article");
      card.className = "blueprint-card";
      const head = document.createElement("div");
      head.className = "blueprint-card-head";
      const title = text("h3", blueprint.label || "Untitled blueprint");
      const source = text(
        "span",
        `${blueprint.source || "saved"} · ${blueprint.width || 0}×${blueprint.height || 0} · ${blueprint.entity_count || 0} entities · ${blueprint.tile_count || 0} tiles`,
        "blueprint-meta",
      );
      head.append(title, source);
      const actions = document.createElement("div");
      actions.className = "blueprint-actions";
      const rename = text("button", "Rename");
      rename.type = "button";
      rename.addEventListener("click", async () => {
        const next = globalThis.prompt?.("Blueprint label", blueprint.label || "");
        if (next === null || next === undefined || !next.trim()) return;
        try {
          const result = await apiRequest(
            "PATCH",
            `/api/runs/${encodeURIComponent(id)}/blueprints/${encodeURIComponent(blueprint.id)}`,
            { label: next.trim() },
          );
          blueprint.label = result.blueprint?.label || next.trim();
          renderBlueprints();
        } catch (error) {
          globalThis.alert?.(error.message);
        }
      });
      const remove = text("button", "Delete");
      remove.type = "button";
      remove.className = "danger";
      remove.addEventListener("click", async () => {
        if (!globalThis.confirm?.(`Delete "${blueprint.label || blueprint.id}"?`)) return;
        try {
          await apiRequest(
            "DELETE",
            `/api/runs/${encodeURIComponent(id)}/blueprints/${encodeURIComponent(blueprint.id)}`,
          );
          blueprints = blueprints.filter((entry) => entry.id !== blueprint.id);
          renderBlueprints();
        } catch (error) {
          globalThis.alert?.(error.message);
        }
      });
      const download = document.createElement("a");
      download.textContent = "Download";
      download.className = "blueprint-download";
      download.href = `/api/runs/${encodeURIComponent(id)}/blueprints/${encodeURIComponent(blueprint.id)}?download=1`;
      download.download = `blueprint-${blueprint.id}.txt`;
      const viewer = text("button", "Preview");
      viewer.type = "button";
      viewer.className = "blueprint-preview";
      viewer.addEventListener("click", () =>
        openPreview(
          `/blueprint-viewer/viewer.html?run=${encodeURIComponent(id)}&id=${encodeURIComponent(blueprint.id)}`,
          `Blueprint preview · ${blueprint.label || blueprint.id}`,
          "iframe",
        ),
      );
      actions.append(download, viewer, rename, remove);
      const entities = text(
        "p",
        (blueprint.top_entities || []).map((entry) => `${entry.name} × ${entry.count}`).join(" · "),
        "blueprint-entities",
      );
      const details = document.createElement("details");
      details.className = "blueprint-details";
      const summary = document.createElement("summary");
      summary.textContent = "Decode blueprint";
      details.append(summary);
      details.addEventListener("toggle", async () => {
        if (!details.open || details.dataset.loaded) return;
        details.dataset.loaded = "1";
        const pre = document.createElement("pre");
        pre.textContent = "Loading…";
        const actions = document.createElement("p");
        const download = document.createElement("a");
        download.textContent = "Download .txt";
        const copy = document.createElement("button");
        copy.type = "button";
        copy.textContent = "Copy string";
        actions.append(download, " ", copy);
        details.append(actions, pre);
        try {
          const detail = await api(
            `/api/runs/${encodeURIComponent(id)}/blueprints/${encodeURIComponent(blueprint.id)}`,
          );
          const blob = new Blob([detail.wire || ""], { type: "text/plain" });
          const href = URL.createObjectURL(blob);
          download.href = href;
          download.download = `${blueprint.label || blueprint.id}.txt`;
          copy.addEventListener("click", async () => {
            await navigator.clipboard?.writeText(detail.wire || "");
            copy.textContent = "Copied";
          });
          pre.textContent = JSON.stringify(detail.payload, null, 2);
          const preview = globalThis.blueprintPreview?.(detail.payload);
          if (preview) details.insertBefore(preview, pre);
        } catch (error) {
          pre.textContent = `Could not decode blueprint: ${error.message}`;
        }
      });
      head.append(actions);
      card.append(head, entities, details);
      return card;
    }),
  );
}

async function loadBlueprints() {
  if (!id || blueprintsLoading) return;
  blueprintsLoading = true;
  try {
    const payload = await api(`/api/runs/${encodeURIComponent(id)}/blueprints`);
    blueprints = payload.blueprints || [];
    blueprintsLoaded = true;
    renderBlueprints();
  } catch {
    blueprintsLoaded = true;
    $("blueprintsNote").hidden = false;
    $("blueprintsNote").textContent = "Blueprints are unavailable for this run.";
  } finally {
    blueprintsLoading = false;
  }
}

function renderRefactorAlert(run) {
  const alert = $("refactorAlert");
  const refactor = run.refactor;
  if (!alert || !refactor) return;
  const attention = Boolean(refactor.gate_active || refactor.big_reset_pending);
  alert.hidden = !attention;
  if (!attention) return;
  const count = Number(refactor.invalid_count || 0);
  const credits = Math.max(0, Number(refactor.build_credits || 0));
  const clusters = Array.isArray(refactor.clusters) ? refactor.clusters.length : 0;
  const tier = String(refactor.escalation_tier || "normal");
  if (refactor.big_reset_pending) {
    alert.classList.add("is-reset");
    $("refactorAlertText").textContent =
      `BIG RESET WARNING · ${count} invalid factory/belt problems · audits ${refactor.audits_with_debt || 0} · operator confirmation required`;
  } else {
    alert.classList.remove("is-reset");
    const headline = tier === "relayout_only" ? "RELAYOUT REQUIRED" : "EXPANSION BLOCKED";
    $("refactorAlertText").textContent =
      `${headline} · ${count} invalid problems · repair/rebuild inside ${clusters} flagged cluster${clusters === 1 ? "" : "s"} · ${credits} rebuild credits`;
  }
}

function renderStatePanel(run) {
  const info = run.state_info || {};
  const status = run.state_status || {};
  $("stateRevision").textContent = String(info.revision || 0);
  const plan = (run.state_md || "").match(/^Current:\s*(.+)$/m)?.[1] || "";
  const doneWhen = (run.state_md || "").match(/^Done when:\s*(.+)$/m)?.[1] || "";
  const statusText = status.blocked
    ? "blocked"
    : status.resume_grace_active
      ? "resume grace"
      : status.due
        ? "due"
        : "fresh";
  $("stateSummary").textContent = plan ? `revision ${info.revision || 0} · ${statusText}` : "";
  const stats = [
    ["Revision", String(info.revision || 0)],
    ["Age", info.age_seconds == null ? "—" : `${info.age_seconds}s`],
    ["Updated by", info.updated_by || "—"],
    ["Status", statusText],
    ["State penalty", String(run.automation?.state_penalty || 0)],
    ["Alert penalty", String(run.automation?.alert_penalty || 0)],
    ["Plan scores", status.scores_source === "agent_self_reported" ? "agent self-reported" : "missing"],
  ];
  $("stateStats").replaceChildren(
    ...stats.flatMap(([key, value]) => [text("dt", key), text("dd", String(value))]),
  );
  $("statePlan").textContent = [plan && `Current: ${plan}`, doneWhen && `Done when: ${doneWhen}`]
    .filter(Boolean)
    .join(" · ");
}
function renderDiscipline(run) {
  const panel = $("disciplinePanel");
  if (!panel) return;
  const discipline = run.evaluation?.discipline;
  if (!discipline) {
    panel.hidden = true;
    return;
  }
  panel.hidden = false;
  const capability = run.evaluation?.capability;
  $("disciplineSummary").textContent = capability
    ? `capability ${capability.score}/${capability.max} · scoring v${capability.scoring_version} · par ${capability.par_seconds}s`
    : "";
  const refactor = discipline.refactor || {};
  const stats = [
    ["Manual mines", String(discipline.manual_mines ?? 0)],
    ["Manual crafts", String(discipline.manual_crafts ?? 0)],
    ["Blackouts", String(discipline.blackouts ?? 0)],
    ["Alert penalty", String(discipline.alert_penalty ?? 0)],
    ["STATE due", `${Math.round(Number(discipline.state_due_seconds) || 0)}s`],
    ["STATE blocked", `${Math.round(Number(discipline.state_blocked_seconds) || 0)}s`],
    ["Refactor debt peak", String(refactor.debt_peak ?? 0)],
    ["Refactor invalid now", String(refactor.invalid_count ?? 0)],
    ["Cleanup units", String(refactor.cleanup_units ?? 0)],
    ["Refactor tier", String(refactor.tier || "normal")],
    ["Debt audits", String(refactor.audits_with_debt ?? 0)],
    ["Flags", discipline.flags?.length ? discipline.flags.join(", ") : "none"],
  ];
  $("disciplineStats").replaceChildren(
    ...stats.flatMap(([key, value]) => [text("dt", key), text("dd", String(value))]),
  );
}
function renderStateHistory() {
  const container = $("stateHistory");
  if (!container) return;
  if (stateHistoryLoading) {
    container.textContent = "Loading…";
    return;
  }
  if (!stateHistory?.revisions?.length) {
    container.textContent = "No STATE.md history recorded yet.";
    return;
  }
  container.replaceChildren(
    ...stateHistory.revisions
      .slice()
      .reverse()
      .map((entry) => {
        const row = document.createElement("div");
        row.className = "state-history-row";
        row.append(
          text("strong", `r${entry.revision}`),
          text("span", entry.current || entry.updated_at || "—"),
        );
        return row;
      }),
  );
}
async function loadStateHistory() {
  if (!id || stateHistoryLoading) return;
  stateHistoryLoading = true;
  renderStateHistory();
  try {
    stateHistory = await api(`/api/runs/${encodeURIComponent(id)}/state/history`);
  } catch {
    stateHistory = { revisions: [] };
  } finally {
    stateHistoryLoading = false;
    $("stateHistoryDetails").hidden = !stateHistory?.revisions?.length;
    renderStateHistory();
  }
}
$("stateToggle").onclick = () => {
  const panel = $("statePanel");
  panel.hidden = !panel.hidden;
  $("stateToggle").setAttribute("aria-expanded", String(!panel.hidden));
  if (!panel.hidden) void loadStateHistory();
};
function renderToolCalls() {
  const list = $("toolCallList");
  const summary = $("toolCallsSummary");
  if (!list || !summary) return;
  if (toolCallsLoading) {
    summary.textContent = "Loading…";
    list.replaceChildren();
    return;
  }
  if (toolCallsError) {
    summary.textContent = "Interface usage is unavailable for this run.";
    list.replaceChildren();
    return;
  }
  if (!toolCalls?.calls?.length) {
    summary.textContent = "No agent interface calls recorded for this run.";
    list.replaceChildren();
    return;
  }
  summary.textContent = `${toolCalls.total} calls · ${toolCalls.calls.length} endpoints`;
  list.replaceChildren(
    ...toolCalls.calls.map((call) => {
      const row = document.createElement("div");
      row.className = "tool-call-row";
      const method = text("code", call.method || "GET", "tool-call-method");
      const path = text("span", call.path || "—", "tool-call-path");
      const count = text("strong", String(call.count || 0), "tool-call-count");
      row.append(method, path, count);
      return row;
    }),
  );
}
async function loadToolCalls() {
  if (!id || toolCallsLoading) return;
  toolCallsLoading = true;
  toolCallsError = false;
  renderToolCalls();
  try {
    toolCalls = await api(`/api/runs/${encodeURIComponent(id)}/tool-calls`);
    $("toolCallCount").textContent = String(toolCalls.total || 0);
  } catch {
    toolCalls = { total: 0, calls: [] };
    toolCallsError = true;
  } finally {
    toolCallsLoading = false;
    renderToolCalls();
  }
}
$("toolCallsToggle").onclick = () => {
  const panel = $("toolCallsPanel");
  panel.hidden = !panel.hidden;
  $("toolCallsToggle").setAttribute("aria-expanded", String(!panel.hidden));
  if (!panel.hidden) void loadToolCalls();
};
$("blueprintsToggle").onclick = () => {
  const panel = $("blueprintsPanel");
  panel.hidden = !panel.hidden;
  $("blueprintsToggle").setAttribute("aria-expanded", String(!panel.hidden));
  if (!panel.hidden) loadBlueprints();
};

async function loadRunMap() {
  const container = $("runMapThumbnail");
  const summary = $("mapSummary");
  container.hidden = false;
  summary.textContent = "Loading…";
  await globalThis.renderMapThumbnail?.(container, {
    x: 0,
    y: 0,
    radius: 256,
    size: 96,
    loading: "Loading charted map…",
    unavailable: "Map is unavailable because the game is not running.",
  });
  summary.textContent = "";
}
$("mapToggle").onclick = () => {
  const panel = $("mapPanel");
  panel.hidden = !panel.hidden;
  $("mapToggle").setAttribute("aria-expanded", String(!panel.hidden));
  if (!panel.hidden) void loadRunMap();
};

async function refresh() {
  if (polling || !id) return;
  polling = true;
  try {
    const run = await api(`/api/runs/${encodeURIComponent(id)}`);
    $("runContent").hidden = false;
    document.title = `${run.name || run.id} · DeeptorioX`;
    renderProgress(run);
    renderRefactorAlert(run);
    renderStatePanel(run);
    renderDiscipline(run);
    $("resume").hidden = !run.resumable;
    $("resume").disabled = !run.resumable || run.video?.state === "rendering";
    $("resume").textContent =
      run.video?.state === "rendering"
        ? "Finishing recording…"
        : run.state === "failed" || run.state === "interrupted"
          ? "Retry from checkpoint"
          : "Resume run";
    $("pause").hidden = run.state !== "running";
    $("pause").disabled = run.state !== "running";
    $("segmentsPanel").hidden = !run.segments?.length;
    $("checkpoint").textContent = run.checkpoint
      ? `Saved game: ${run.checkpoint.file} · ${new Date(run.checkpoint.saved_at).toLocaleString("en-US", { timeZone: "America/Los_Angeles", timeZoneName: "short" })}`
      : "No checkpoint saved yet.";
    $("resumeNote").textContent =
      run.state === "failed" || run.state === "interrupted"
        ? "This run stopped before its objective was verified. Retry loads the latest saved checkpoint and continues the same agent session and workspace."
        : run.state === "paused"
          ? "Waiting for you to resume after your agent quota resets. Waiting and game loading are excluded from play time. The same game, agent session, and workspace will continue."
          : "Play time and measurements continue across segments; waiting time is excluded.";
    $("segments").replaceChildren(
      ...(run.segments || []).map((segment) => {
        const row = text(
          "p",
          `Segment ${segment.index} · ${segment.state} · ${(segment.start_seconds || 0).toFixed(1)}–${(segment.end_seconds ?? run.elapsed_seconds).toFixed(1)}s active play`,
        );
        if (segment.video?.state === "ready") {
          const link = text("a", "Download 6× video");
          link.href = `/api/runs/${encodeURIComponent(id)}/video?segment=${segment.index}`;
          link.download = `${id}-segment-${segment.index}-6x.mp4`;
          row.append(" · ", link);
        } else if (segment.video) row.append(` · video ${segment.video.state}`);
        return row;
      }),
    );
    videoSegments = (run.segments || [])
      .map((segment, index, segments) => ({
        index: segment.index,
        video: index === segments.length - 1 ? run.video || segment.video : segment.video,
      }))
      .filter((segment) => segment.video);
    if (!videoSegments.length && run.video) videoSegments = [{ index: "", video: run.video }];
    $("videoPanel").hidden = !videoSegments.length;
    $("videoSegmentLabel").hidden = !videoSegments.some((segment) => segment.index);
    if (!videoSegments.some((segment) => String(segment.index) === selectedVideoSegment)) {
      selectedVideoSegment = String(
        (videoSegments.findLast((segment) => segment.video.state === "ready") || videoSegments.at(-1))
          ?.index ?? "",
      );
    }
    const options = videoSegments.map((segment) => ({
      value: String(segment.index),
      label: `Segment ${segment.index} · ${segment.video.state}`,
    }));
    if (
      JSON.stringify(options) !==
      JSON.stringify(
        Array.from($("videoSegment").options, (option) => ({
          value: option.value,
          label: option.textContent,
        })),
      )
    ) {
      $("videoSegment").replaceChildren(
        ...options.map((option) => {
          const node = text("option", option.label);
          node.value = option.value;
          return node;
        }),
      );
    }
    $("videoSegment").value = selectedVideoSegment;
    renderVideo();
    if (!blueprintsLoaded) void loadBlueprints();
    if (!toolCalls && !toolCallsLoading) void loadToolCalls();
    $("recordingLink").href = recordingUrl(id);
    $("recordingLink").hidden = false;
    const info = {
      Benchmark: run.benchmark.title,
      Seed: run.benchmark.map_gen.seed,
      Model: displayModel(run.model_label || run.model || run.agent),
      ...(run.failure_kind ? { "Failure kind": run.failure_kind } : {}),
      ...(run.auto_continues ? { "Auto-continues": String(run.auto_continues) } : {}),
      ...(run.evaluation?.capability
        ? {
            Capability: `${run.evaluation.capability.score} / ${run.evaluation.capability.max}`,
            "Capability detail": run.evaluation.capability.completed
              ? `completed in ${Math.round(Number(run.evaluation.capability.completion_seconds) || 0)}s`
              : `progress ${Math.round(Number(run.evaluation.capability.progress || 0) * 100)}%`,
            "Milestones (scored)": `${run.evaluation.capability.milestones.completed}/${run.evaluation.capability.milestones.total}`,
            Scoring: `v${run.evaluation.capability.scoring_version} · par ${run.evaluation.capability.par_seconds}s · ${run.evaluation.capability.par_source}`,
            ...(run.evaluation.discipline?.flags?.length
              ? { "Discipline flags": run.evaluation.discipline.flags.join(", ") }
              : {}),
          }
        : {}),
      ...(run.automation?.score == null
        ? {}
        : { "Automation score (legacy v1)": String(run.automation.score) }),
      ...(run.automation?.cleanup_units == null
        ? {}
        : { "Cleanup units": String(run.automation.cleanup_units) }),
      ...(run.automation?.refactor_reward == null
        ? {}
        : { "Refactor reward": `+${run.automation.refactor_reward}` }),
      ...(run.automation?.blackouts
        ? {
            Blackouts: `${run.automation.blackouts} (-${run.automation.blackout_penalty || 0})`,
          }
        : {}),
      ...(run.benchmark?.milestones?.length
        ? {
            Milestones: `${Object.keys(run.milestones || {}).length}/${run.benchmark.milestones.length}`,
          }
        : {}),
      "Time limit": `${run.max_seconds}s`,
      "Sampling interval": `${run.benchmark.sample_seconds}s`,
      "Created (Pacific)": new Date(run.created_at).toLocaleString("en-US", {
        timeZone: "America/Los_Angeles",
        timeZoneName: "short",
      }),
      "Run ID": run.id,
    };
    $("runInfo").replaceChildren(
      ...Object.entries(info).flatMap(([key, value]) => [text("dt", key), text("dd", String(value))]),
    );
    $("task").textContent = run.benchmark.task;
    $("configuration").textContent = JSON.stringify(
      {
        versions: run.versions,
        hashes: run.hashes,
        map_gen: run.benchmark.map_gen,
        always_day: run.benchmark.always_day,
      },
      null,
      2,
    );
    $("tokenUsage").textContent = run.usage
      ? `Tokens: ${run.usage.input_tokens.toLocaleString()} input (${(run.usage.cached_input_tokens || 0).toLocaleString()} cached) · ${run.usage.output_tokens.toLocaleString()} output · ${run.usage_status === "final" ? "final" : "last reported; interrupted requests may be missing"}`
      : "Token usage: not yet reported";
    const initial = run.baseline?.production || {};
    const items = Object.entries(run.latest?.production || {})
      .map(([name, count]) => [name, count - (initial[name] || 0)])
      .filter(([, count]) => count > 0)
      .sort((a, b) => b[1] - a[1]);
    $("production").replaceChildren(
      ...(items.length
        ? items.map(([name, count]) => text("p", `${name}: ${count}`))
        : [text("p", "No production recorded yet.", "muted")]),
    );
    await chart.update(run);
    const log = await api(`/api/runs/${encodeURIComponent(id)}/log?offset=${offset}`);
    offset = log.offset;
    if (log.text) {
      $("activity").textContent = (
        $("activity").textContent + log.text.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
      ).slice(-150000);
      if ($("follow").checked) $("activity").scrollTop = $("activity").scrollHeight;
    }
    $("error").textContent = "";
  } catch (error) {
    $("error").textContent = error.message;
  } finally {
    polling = false;
  }
}
$("activity").textContent = "";
$("pause").onclick = async () => {
  $("pause").disabled = true;
  try {
    await api(`/api/runs/${encodeURIComponent(id)}/pause`, {});
    await refresh();
  } catch (error) {
    $("error").textContent = error.message;
    $("pause").disabled = false;
  }
};
$("stop").onclick = async () => {
  $("stop").disabled = true;
  try {
    await api(`/api/runs/${encodeURIComponent(id)}/stop`, {});
    await refresh();
  } catch (error) {
    $("error").textContent = error.message;
  }
};
$("resume").onclick = async () => {
  $("resume").disabled = true;
  try {
    await api(`/api/runs/${encodeURIComponent(id)}/resume`, {});
    await refresh();
  } catch (error) {
    $("error").textContent = error.message;
    $("resume").disabled = false;
  }
};
let seedPreviewFrame = null;
let seedPreviewUrl = null;
let seedPreviewSources = null;
function toolkitViewerUrl(urlOrSources, planet = "nauvis") {
  if (typeof urlOrSources === "string") {
    return `/toolkit-viewer/index.html?image=${encodeURIComponent(urlOrSources)}&planet=${encodeURIComponent(planet)}`;
  }
  return `/toolkit-viewer/index.html?images=${encodeURIComponent(JSON.stringify(urlOrSources))}`;
}
function showSeedMapPreview(urlOrSources, planet = "nauvis") {
  $("seedPreviewViewer").hidden = false;
  const src = toolkitViewerUrl(urlOrSources, planet);
  if (seedPreviewFrame) {
    seedPreviewFrame.src = src;
    return;
  }
  seedPreviewFrame = document.createElement("iframe");
  seedPreviewFrame.className = "toolkit-preview-frame";
  seedPreviewFrame.title = "FactorioPreviewToolkit map preview";
  seedPreviewFrame.src = src;
  $("seedPreviewViewer").replaceChildren(seedPreviewFrame);
}
$("seedPreviewExpand").onclick = () => {
  if (seedPreviewSources) openPreview(toolkitViewerUrl(seedPreviewSources), "Seed map preview", "iframe");
};
function seedPreviewId() {
  return seedPreviewUrl
    ? seedPreviewUrl
        .split("/")
        .at(-1)
        .replace(/\.png$/, "")
    : "";
}
$("seedToolkitViewer").onclick = () => {
  if (!seedPreviewSources) return;
  openPreview(toolkitViewerUrl(seedPreviewSources), "FactorioPreviewToolkit viewer", "iframe");
};
$("seedUploadLocal").onclick = async () => {
  const target = globalThis.prompt?.("Local sync folder", "");
  if (!target) return;
  try {
    const result = await api("/api/map-previews/upload", {
      id: seedPreviewId(),
      method: "local_sync",
      target,
    });
    $("seedUploadStatus").textContent = `uploaded → ${result.destination}`;
  } catch (error) {
    $("seedUploadStatus").textContent = error.message;
  }
};
$("seedUploadRclone").onclick = async () => {
  const remote = globalThis.prompt?.("rclone destination", "");
  if (!remote) return;
  try {
    const result = await api("/api/map-previews/upload", {
      id: seedPreviewId(),
      method: "rclone",
      remote,
    });
    $("seedUploadStatus").textContent = `rclone → ${result.destination}`;
  } catch (error) {
    $("seedUploadStatus").textContent = error.message;
  }
};
$("seedPreviewGenerate").onclick = async () => {
  const button = $("seedPreviewGenerate");
  button.disabled = true;
  $("seedPreviewStatus").textContent = "Generating 2048×2048 preview…";
  try {
    const result = await api(`/api/runs/${encodeURIComponent(id)}/map-preview`, {
      size: 2048,
      all_planets: true,
    });
    seedPreviewSources = Object.fromEntries((result.planets || []).map((p) => [p.planet, p.url]));
    seedPreviewUrl = seedPreviewSources.nauvis || result.url;
    showSeedMapPreview(seedPreviewSources);
    $("seedPreviewExpand").hidden = false;
    $("seedToolkitViewer").hidden = false;
    $("seedUploadLocal").hidden = false;
    $("seedUploadRclone").hidden = false;
    $("seedPreviewStatus").textContent = `seed ${result.seed} · ${result.planets?.length || 0} planets`;
  } catch (error) {
    $("seedPreviewStatus").textContent = error.message;
  } finally {
    button.disabled = false;
  }
};
if (id) {
  await refresh();
  const previewParams = new URLSearchParams(location.search);
  if (previewParams.get("preview") === "seed") {
    $("seedPreviewGenerate").click();
  } else if (previewParams.get("preview") === "toolkit") {
    $("seedPreviewGenerate").click();
    const toolkitTimer = setInterval(() => {
      if (!seedPreviewUrl) return;
      clearInterval(toolkitTimer);
      $("seedToolkitViewer").click();
    }, 250);
  } else if (previewParams.get("preview") === "blueprint") {
    const blueprintId = previewParams.get("blueprint");
    if (blueprintId) {
      openPreview(
        `/blueprint-viewer/viewer.html?run=${encodeURIComponent(id)}&id=${encodeURIComponent(blueprintId)}`,
        "Blueprint preview",
        "iframe",
      );
    }
  }
  setInterval(refresh, 1000);
} else $("error").textContent = "Choose a run from the run history.";
