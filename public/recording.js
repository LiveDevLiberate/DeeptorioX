import { CodexOutput } from "./codex-output.js";
import { CodexTranscript, commandSummary } from "./codex-transcript.js";
const output = document.getElementById("codexOutput");
const params = new URLSearchParams(location.search);
let id = params.get("run"), offset = 0, mode;
const decoder = new TextDecoder(), parser = new CodexOutput(), transcript = new CodexTranscript();
const entries = new Map();
let commandGroup;
const statusState = document.getElementById("statusState");
const statusActivity = document.getElementById("statusActivity");
const statusMeta = document.getElementById("statusMeta");
const statusCurrent = document.getElementById("statusCurrent");
const statusDone = document.getElementById("statusDone");
const statusScores = document.getElementById("statusScores");
const SUBTASKS = ["production", "logistics", "mining", "research", "defense", "exploration"];
const I18N = {
  en: {
    states: { preparing: "preparing", launching: "launching", running: "running", saving: "saving", completed: "completed", failed: "failed", stopped: "stopped", timed_out: "timed out", interrupted: "interrupted", paused: "paused" },
    activity: { thinking: "Thinking", acting: "Acting", reporting: "Reporting", idle: "Idle", output: "Output", error: "Error" },
    subtasks: { production: "Prod", logistics: "Logi", mining: "Mine", research: "Res", defense: "Def", exploration: "Expl" },
    done: "Done", pending: "STATE.md pending", tokens: "tok", expand: "Expand status details", collapse: "Collapse status details",
  },
  zh: {
    states: { preparing: "准备中", launching: "启动中", running: "运行中", saving: "保存中", completed: "已完成", failed: "失败", stopped: "已停止", timed_out: "超时", interrupted: "中断", paused: "暂停" },
    activity: { thinking: "思考中", acting: "执行中", reporting: "汇报中", idle: "空闲", output: "输出", error: "错误" },
    subtasks: { production: "生产", logistics: "物流", mining: "采矿", research: "科研", defense: "防御", exploration: "探索" },
    done: "完成条件", pending: "等待 STATE.md", tokens: "令牌", expand: "展开状态详情", collapse: "收起状态详情",
  },
};
let lastStatusAt = 0, lastEventAt = 0, activity = "idle", uiLang;
const statusHeader = document.getElementById("agentStatus");
const statusToggle = document.getElementById("statusToggle");
statusToggle?.addEventListener("click", () => {
  const collapsed = statusHeader.classList.toggle("collapsed");
  const strings = I18N[uiLang || "en"];
  statusToggle.textContent = collapsed ? "▸" : "▾";
  statusToggle.setAttribute("aria-label", collapsed ? strings.expand : strings.collapse);
});
document.title = "Agent transcript";
function element(tag, text, className) {
  const node = document.createElement(tag);
  if (text) node.textContent = text;
  if (className) node.className = className;
  return node;
}
function parseScores(markdown) {
  const scores = {};
  const single = (markdown.match(/^Scores[^:\n]*:\s*(.+)$/m) || [])[1];
  if (single && /\d/.test(single)) {
    for (const part of single.split(",")) {
      const match = part.trim().match(/^([a-z ]+?)\s+(\d+)$/i);
      if (match) scores[match[1].trim().toLowerCase()] = Number(match[2]);
    }
  }
  const section = markdown.split(/^Current:/m)[0];
  for (const match of section.matchAll(/^[-*]\s*([a-z ]+?)(?:\s*\([^)]*\))?\s*:\s*(\d+)/gim)) {
    scores[match[1].trim().toLowerCase()] = Number(match[2]);
  }
  return scores;
}
function pickLanguage(run) {
  const value = String(run?.language || "").toLowerCase();
  if (/chinese|中文|zh/.test(value)) return "zh";
  if (/english|en/.test(value)) return "en";
  return String(navigator.language || "").toLowerCase().startsWith("zh") ? "zh" : "en";
}
function renderStatus(run) {
  if (!statusState || !statusScores) return;
  if (!uiLang) {
    uiLang = pickLanguage(run);
    document.documentElement.lang = uiLang === "zh" ? "zh-CN" : "en";
  }
  const strings = I18N[uiLang] || I18N.en;
  const state = run.state || "—";
  statusState.textContent = strings.states[state] || state;
  statusState.className = `status-badge ${state}`;
  const activeKey = state === "running" ? (Date.now() - lastEventAt > 12000 ? "idle" : activity) : state;
  const waitSeconds = (activeKey === "thinking" || activeKey === "idle") && lastEventAt
    ? Math.max(0, Math.round((Date.now() - lastEventAt) / 1000)) : 0;
  statusActivity.textContent = `${strings.activity[activeKey] || activeKey}${waitSeconds ? ` ${waitSeconds}s` : ""}`;
  const usage = run.usage || {};
  const tokens = usage.total_tokens ?? ((usage.input_tokens || 0) + (usage.output_tokens || 0));
  statusMeta.textContent = `${Math.round(run.elapsed_seconds || 0)}s / ${run.max_seconds || 0}s · ${Number(tokens || 0).toLocaleString()} ${strings.tokens}`;
  const markdown = run.state_md || "";
  const current = (markdown.match(/^Current:\s*(.+)$/m) || [])[1] || "";
  const done = (markdown.match(/^Done when:\s*(.+)$/m) || [])[1] || "";
  statusCurrent.textContent = current ? `▶ ${current}` : strings.pending;
  statusDone.textContent = done ? `${strings.done}: ${done}` : "";
  const scores = parseScores(markdown);
  statusScores.replaceChildren(...SUBTASKS.map(key => {
    const row = element("div", "", "score");
    const label = element("span", strings.subtasks[key] || key, "score-label");
    label.title = key;
    if (current.toLowerCase().includes(key) || (strings.subtasks[key] && current.includes(strings.subtasks[key]))) row.classList.add("active");
    row.append(label);
    const track = element("div", "", "score-track");
    const fill = element("div", "", "score-fill");
    fill.style.width = `${Math.max(0, Math.min(100, scores[key] || 0))}%`;
    track.append(fill);
    row.append(track, element("span", scores[key] == null ? "—" : String(scores[key]), "score-value"));
    return row;
  }));
}
function render(item) {
  lastEventAt = Date.now();
  if (item.type === "command_execution") activity = item.status === "completed" ? "thinking" : "acting";
  else if (item.type === "reasoning") activity = "thinking";
  else if (item.type === "agent_message") activity = "reporting";
  else if (item.type === "error") activity = "error";
  else activity = "output";
  let entry = entries.get(item.id);
  if (!entry) {
    if (item.type === "command_execution") {
      if (!commandGroup) {
        const details = element("details", "", "commands"), summary = element("summary");
        details.append(summary); output.append(details);
        commandGroup = { details, summary, items: new Map() };
      }
      const node = element("div", "", "command"); commandGroup.details.append(node);
      entry = { node, group: commandGroup };
    } else {
      commandGroup = null;
      const node = element("div", "", `message ${item.type === "reasoning" ? "reasoning" : ""}`);
      output.append(node); entry = { node };
    }
    entries.set(item.id, entry);
  }
  if (item.type === "command_execution") {
    entry.node.replaceChildren(element("pre", item.command || ""), element("pre", item.aggregated_output || "", "command-output"));
    entry.group.items.set(item.id, item);
    const items = [...entry.group.items.values()];
    entry.group.summary.textContent = commandSummary(items);
    entry.group.details.classList.toggle("failed", items.some(i => i.status === "failed" || (i.exit_code != null && i.exit_code !== 0)));
  } else if (item.type === "agent_message" || item.type === "reasoning" || item.type === "error") {
    entry.node.textContent = item.text || "";
    entry.node.classList.toggle("error", item.type === "error");
  } else {
    // Other tools remain inspectable without dumping JSON into the recording.
    const details = element("details"), summary = element("summary", item.type.replaceAll("_", " "));
    details.append(summary, element("pre", JSON.stringify(item, null, 2))); entry.node.replaceChildren(details);
  }
}
async function poll() {
  try {
    if (!id) {
      const response = await fetch("/api/runs");
      if (!response.ok) throw new Error("Runs unavailable");
      id = (await response.json()).runs[0]?.id;
      if (id) { params.set("run", id); history.replaceState(null, "", `?${params}`); }
    }
    if (id) {
      if (!mode) {
        const response = await fetch(`/api/runs/${encodeURIComponent(id)}`);
        if (!response.ok) throw new Error("Run unavailable");
        const run = await response.json();
        // Old runs and optional Terminal runs retain their original native display.
        mode = run.output_format === "events" ? "events" : "codex";
        const segment=run.segments?.find(s=>s.index===Number(params.get("segment")));
        if(segment)offset=mode==="events"?segment.event_offset:segment.native_offset;
      }
      if (Date.now() - lastStatusAt > 1000) {
        lastStatusAt = Date.now();
        const statusResponse = await fetch(`/api/runs/${encodeURIComponent(id)}`);
        if (statusResponse.ok) renderStatus(await statusResponse.json());
      }
      const response = await fetch(`/api/runs/${encodeURIComponent(id)}/log?source=${mode}&offset=${offset}`);
      if (!response.ok) throw new Error("Output unavailable");
      const log = await response.json();
      const bytes = Uint8Array.from(atob(log.data || ""), c => c.charCodeAt(0));
      const follow = output.scrollHeight - output.scrollTop - output.clientHeight < 50;
      const text = decoder.decode(bytes, { stream: true });
      if (mode === "events") for (const item of transcript.push(text)) render(item);
      else for (const segment of parser.push(text)) {
        const span = element("span", segment.text); Object.assign(span.style, segment.style); output.append(span);
        lastEventAt = Date.now(); activity = "output";
      }
      offset = log.offset;
      if (follow) output.scrollTop = output.scrollHeight;
    }
    document.title = "Agent transcript";
  } catch {
    document.title = "Agent transcript";
  } finally { setTimeout(poll, 250); }
}
void poll();
