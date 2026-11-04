import { CodexOutput } from "./codex-output.js";
import { CodexTranscript } from "./codex-transcript.js";
import {
  summarizeCommand,
  summarizeCommandGroup,
  summarizeTool,
  splitReasoning,
  reasoningKey,
  collapseRepeatedSentences,
  classifyActivity,
  formatRelativeMs,
  LoopDetector,
} from "./transcript-view-model.js";
const output = document.getElementById("codexOutput");
const params = new URLSearchParams(location.search);
let id = params.get("run"),
  offset = 0,
  mode;
const decoder = new TextDecoder(),
  parser = new CodexOutput(),
  transcript = new CodexTranscript();
const entries = new Map();
let commandGroup;
const loops = new LoopDetector({ threshold: 3, window: 12 });
const thoughtLoops = new LoopDetector({ threshold: 2, window: 6 });
const seenThoughts = new Map();
const openReasoning = [];
let streamStart = 0;
let firstBatch = true;
let unread = 0;
const statusState = document.getElementById("statusState");
const statusActivity = document.getElementById("statusActivity");
const statusMeta = document.getElementById("statusMeta");
const statusCurrent = document.getElementById("statusCurrent");
const statusDone = document.getElementById("statusDone");
const statusScores = document.getElementById("statusScores");
const SUBTASKS = ["production", "logistics", "mining", "research", "defense", "exploration"];
const I18N = {
  en: {
    states: {
      preparing: "preparing",
      launching: "launching",
      running: "running",
      saving: "saving",
      completed: "completed",
      failed: "failed",
      stopped: "stopped",
      timed_out: "timed out",
      interrupted: "interrupted",
      paused: "paused",
    },
    activity: {
      thinking: "Thinking",
      acting: "Acting",
      reporting: "Reporting",
      idle: "Idle",
      output: "Output",
      error: "Error",
    },
    subtasks: {
      production: "Prod",
      logistics: "Logi",
      mining: "Mine",
      research: "Res",
      defense: "Def",
      exploration: "Expl",
    },
    done: "Done",
    pending: "STATE.md pending",
    tokens: "tok",
    plan: "plan",
    turn: "turn",
    newEvents: "new",
    loop: "loop?",
    repeated: "repeated",
    raw: "raw",
    expand: "Expand status details",
    collapse: "Collapse status details",
  },
  zh: {
    states: {
      preparing: "准备中",
      launching: "启动中",
      running: "运行中",
      saving: "保存中",
      completed: "已完成",
      failed: "失败",
      stopped: "已停止",
      timed_out: "超时",
      interrupted: "中断",
      paused: "暂停",
    },
    activity: {
      thinking: "思考中",
      acting: "执行中",
      reporting: "汇报中",
      idle: "空闲",
      output: "输出",
      error: "错误",
    },
    subtasks: {
      production: "生产",
      logistics: "物流",
      mining: "采矿",
      research: "科研",
      defense: "防御",
      exploration: "探索",
    },
    done: "完成条件",
    pending: "等待 STATE.md",
    tokens: "令牌",
    plan: "计划",
    turn: "回合",
    newEvents: "条新消息",
    loop: "循环?",
    repeated: "重复",
    raw: "原始",
    expand: "展开状态详情",
    collapse: "收起状态详情",
  },
};
let lastStatusAt = 0,
  lastEventAt = 0,
  activity = "idle",
  uiLang;
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
  return String(navigator.language || "")
    .toLowerCase()
    .startsWith("zh")
    ? "zh"
    : "en";
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
  const waitSeconds =
    (activeKey === "thinking" || activeKey === "idle") && lastEventAt
      ? Math.max(0, Math.round((Date.now() - lastEventAt) / 1000))
      : 0;
  statusActivity.textContent = `${strings.activity[activeKey] || activeKey}${waitSeconds ? ` ${waitSeconds}s` : ""}`;
  const usage = run.usage || {};
  const tokens = usage.total_tokens ?? (usage.input_tokens || 0) + (usage.output_tokens || 0);
  const context = run.context_limit
    ? ` · ctx ${Math.round((run.context_tokens || 0) / 1000)}k/${Math.round(run.context_limit / 1000)}k`
    : "";
  const planAge = run.state_updated_at
    ? Math.floor((Date.now() - Date.parse(run.state_updated_at)) / 60000)
    : null;
  const stale = planAge !== null && planAge >= 10 ? ` · ${strings.plan} ${planAge}m old` : "";
  statusMeta.textContent = `${Math.round(run.elapsed_seconds || 0)}s / ${run.max_seconds || 0}s · ${Number(tokens || 0).toLocaleString()} ${strings.tokens}${context}${stale}`;
  const markdown = run.state_md || "";
  const current = (markdown.match(/^Current:\s*(.+)$/m) || [])[1] || "";
  const done = (markdown.match(/^Done when:\s*(.+)$/m) || [])[1] || "";
  const research = run.latest?.current_research
    ? `research ${run.latest.current_research} ${Math.round((run.latest.research_progress || 0) * 100)}%`
    : "";
  const planStale = run.state_updated_at
    ? Date.now() - Date.parse(run.state_updated_at) > 10 * 60 * 1000
    : false;
  if (planStale) {
    statusCurrent.textContent = `⚠ ${strings.plan} stale${research ? ` · ${research}` : ""}`;
    statusDone.textContent = "";
    statusHeader?.classList.add("stale-plan");
  } else {
    statusCurrent.textContent = current ? `▶ ${current}` : research || strings.pending;
    statusDone.textContent = done ? `${strings.done}: ${done}` : "";
    statusHeader?.classList.remove("stale-plan");
  }
  const scores = parseScores(markdown);
  statusScores.replaceChildren(
    ...SUBTASKS.map((key) => {
      const row = element("div", "", "score");
      const label = element("span", strings.subtasks[key] || key, "score-label");
      label.title = key;
      if (
        current.toLowerCase().includes(key) ||
        (strings.subtasks[key] && current.includes(strings.subtasks[key]))
      )
        row.classList.add("active");
      row.append(label);
      const track = element("div", "", "score-track");
      const fill = element("div", "", "score-fill");
      fill.style.width = `${Math.max(0, Math.min(100, scores[key] || 0))}%`;
      track.append(fill);
      row.append(track, element("span", scores[key] == null ? "—" : String(scores[key]), "score-value"));
      return row;
    }),
  );
}
function strings() {
  return I18N[uiLang || "en"] || I18N.en;
}
const jumpButton = element("button", "", "jump-latest");
jumpButton.type = "button";
jumpButton.hidden = true;
document.body.append(jumpButton);
jumpButton.addEventListener("click", () => {
  unread = 0;
  jumpButton.hidden = true;
  output.scrollTop = output.scrollHeight;
});
function nearBottom() {
  return output.scrollHeight - output.scrollTop - output.clientHeight < 50;
}
output.addEventListener("scroll", () => {
  if (!nearBottom()) return;
  unread = 0;
  jumpButton.hidden = true;
});
function timeLabel(item) {
  if (!item.receivedAt || item.backfill || !streamStart) return null;
  return formatRelativeMs(item.receivedAt - streamStart);
}
function ensureCommandGroup() {
  if (!commandGroup) {
    const details = element("details", "", "commands");
    const summary = element("summary", "", "commands-summary");
    details.append(summary);
    output.append(details);
    commandGroup = { details, summary, items: new Map(), loop: 0 };
  }
  return commandGroup;
}
function refreshCommandGroup(group) {
  const stats = summarizeCommandGroup([...group.items.values()]);
  const loopPrefix = group.loop ? `⚠ ${strings().loop} ×${group.loop} · ` : "";
  group.summary.textContent = `${loopPrefix}${stats.text}`;
  group.details.classList.toggle("failed", stats.failed > 0);
  group.details.classList.toggle("loop", group.loop > 0);
}
function renderCommand(item) {
  const group = ensureCommandGroup();
  const summary = summarizeCommand(item);
  let entry = entries.get(item.id);
  if (!entry) {
    const node = element("div", "", "command");
    group.details.append(node);
    entry = { node, loopCounted: false };
    entries.set(item.id, entry);
  }
  const badge = element("span", summary.label, `action-badge ${summary.category}`);
  if (summary.failed) badge.classList.add("failed");
  const main = element("span", "", "action-main");
  if (summary.target) main.append(element("span", summary.target, "action-target"));
  if (summary.outcome) main.append(element("span", summary.outcome, "action-outcome"));
  if (summary.running) main.append(element("span", strings().activity.acting, "action-flag"));
  const raw = element("details", "", "action-raw");
  raw.append(
    element("summary", strings().raw),
    element("pre", item.command || ""),
    element("pre", item.aggregated_output || "", "command-output"),
  );
  const label = timeLabel(item);
  entry.node.replaceChildren(...[badge, main, raw].concat(label ? [element("span", label, "msg-time")] : []));
  if ((item.status === "completed" || item.status === "failed") && !entry.loopCounted) {
    entry.loopCounted = true;
    const repeat = loops.push(summary.key);
    if (repeat.repeated) {
      entry.node.classList.add("loop");
      group.loop = Math.max(group.loop, repeat.count);
      entry.node.append(element("span", `⚠ ${strings().loop} ×${repeat.count}`, "loop-badge"));
    }
  }
  group.items.set(item.id, item);
  refreshCommandGroup(group);
}
function renderReasoning(item) {
  commandGroup = null;
  const text = item.text || "";
  const key = reasoningKey(text);
  const repeat = thoughtLoops.push(key);
  const previous = key ? seenThoughts.get(key) : null;
  if (previous) {
    previous.count += 1;
    previous.badge.hidden = false;
    previous.badge.textContent = `↻ ${strings().repeated} ×${repeat.count}`;
    previous.node.classList.add("repeated");
    entries.set(item.id, previous);
    return;
  }
  const segments = splitReasoning(text);
  const node = element("details", "", "message reasoning");
  node.open = openReasoning.length < 2;
  const summary = element("summary", "", "reasoning-summary");
  summary.textContent = segments[0]?.summary || "…";
  const badge = element("span", "", "dedupe-badge");
  badge.hidden = true;
  summary.append(badge);
  const label = timeLabel(item);
  if (label) summary.append(element("span", label, "msg-time"));
  const body = element("div", "", "reasoning-body");
  body.textContent = collapseRepeatedSentences(text);
  node.append(summary, body);
  output.append(node);
  const entry = { node, badge, count: 1 };
  entries.set(item.id, entry);
  if (key) seenThoughts.set(key, entry);
  openReasoning.push(node);
  while (openReasoning.length > 2) {
    const old = openReasoning.shift();
    if (old) old.open = false;
  }
  if (repeat.repeated) {
    badge.hidden = false;
    badge.textContent = `↻ ${strings().repeated} ×${repeat.count}`;
    node.classList.add("repeated");
  }
}
function renderMessage(item) {
  commandGroup = null;
  let entry = entries.get(item.id);
  if (!entry) {
    const node = element("div", "", "message");
    const body = element("div", "", "message-body");
    node.append(body);
    const label = timeLabel(item);
    if (label) node.append(element("span", label, "msg-time"));
    output.append(node);
    entry = { node, body };
    entries.set(item.id, entry);
  }
  entry.node.classList.toggle("error", item.type === "error");
  entry.body.textContent = item.text || "";
}
function renderTool(item) {
  commandGroup = null;
  let entry = entries.get(item.id);
  if (!entry) {
    const node = element("div", "", "message tool");
    const details = element("details", "", "tool-details");
    const summary = element("summary");
    const raw = element("pre", "", "tool-raw");
    details.append(summary, raw);
    node.append(details);
    const label = timeLabel(item);
    if (label) summary.append(element("span", label, "msg-time"));
    output.append(node);
    entry = { node, summary, raw, title: "" };
    entries.set(item.id, entry);
  }
  const info = summarizeTool(item);
  const title = `${info.label}${info.detail ? ` · ${info.detail}` : ""}`;
  if (entry.title !== title) {
    entry.title = title;
    entry.summary.textContent = title;
    const label = timeLabel(item);
    if (label) entry.summary.append(element("span", label, "msg-time"));
  }
  entry.raw.textContent = JSON.stringify(item, null, 2);
}
function render(item) {
  lastEventAt = Date.now();
  activity = classifyActivity(item);
  if (item.type === "command_execution") renderCommand(item);
  else if (item.type === "reasoning") renderReasoning(item);
  else if (item.type === "agent_message" || item.type === "error") renderMessage(item);
  else renderTool(item);
}
function appendTurn(generation) {
  commandGroup = null;
  output.append(element("div", `${strings().turn} ${generation}`, "turn-separator"));
}
async function poll() {
  try {
    if (!id) {
      const response = await fetch("/api/runs");
      if (!response.ok) throw new Error("Runs unavailable");
      id = (await response.json()).runs[0]?.id;
      if (id) {
        params.set("run", id);
        history.replaceState(null, "", `?${params}`);
      }
    }
    if (id) {
      if (!mode) {
        const response = await fetch(`/api/runs/${encodeURIComponent(id)}`);
        if (!response.ok) throw new Error("Run unavailable");
        const run = await response.json();
        // Old runs and optional Terminal runs retain their original native display.
        mode = run.output_format === "events" ? "events" : "codex";
        const segment = run.segments?.find((s) => s.index === Number(params.get("segment")));
        if (segment) offset = mode === "events" ? segment.event_offset : segment.native_offset;
      }
      if (Date.now() - lastStatusAt > 1000) {
        lastStatusAt = Date.now();
        const statusResponse = await fetch(`/api/runs/${encodeURIComponent(id)}`);
        if (statusResponse.ok) renderStatus(await statusResponse.json());
      }
      const response = await fetch(`/api/runs/${encodeURIComponent(id)}/log?source=${mode}&offset=${offset}`);
      if (!response.ok) throw new Error("Output unavailable");
      const log = await response.json();
      const bytes = Uint8Array.from(atob(log.data || ""), (c) => c.charCodeAt(0));
      const follow = nearBottom();
      const text = decoder.decode(bytes, { stream: true });
      if (mode === "events") {
        const wasFirstBatch = firstBatch;
        if (!streamStart) streamStart = Date.now();
        const generation = transcript.generation;
        const changed = transcript.push(text);
        if (transcript.generation !== generation) appendTurn(transcript.generation);
        for (const item of changed) {
          item.receivedAt = Date.now();
          item.backfill = wasFirstBatch;
          render(item);
        }
        if (changed.length) {
          if (follow) {
            output.scrollTop = output.scrollHeight;
            unread = 0;
            jumpButton.hidden = true;
          } else {
            unread += changed.length;
            jumpButton.textContent = `${strings().newEvents} ${unread} ↓`;
            jumpButton.hidden = false;
          }
        }
        firstBatch = false;
      } else {
        for (const segment of parser.push(text)) {
          const span = element("span", segment.text);
          Object.assign(span.style, segment.style);
          output.append(span);
          lastEventAt = Date.now();
          activity = "output";
        }
        if (!streamStart) streamStart = Date.now();
        if (follow) output.scrollTop = output.scrollHeight;
        else if (text) {
          unread += 1;
          jumpButton.textContent = `${strings().newEvents} ${unread} ↓`;
          jumpButton.hidden = false;
        }
      }
      offset = log.offset;
    }
    document.title = "Agent transcript";
  } catch {
    document.title = "Agent transcript";
  } finally {
    setTimeout(poll, 250);
  }
}
void poll();
