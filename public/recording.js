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
  isDecisionText,
  miniBars,
  parseTelemetryLines,
  telemetryRates,
  telemetrySeries,
  telemetryResearchDetail,
  telemetryPowerSatisfaction,
  telemetryMarkers,
  sparkTrend,
  SCORE_AXES,
  radarGeometry,
  formatDurationText,
  mapSettingsView,
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
let openCommandGroup = null;
const loops = new LoopDetector({ threshold: 3, window: 12 });
const thoughtLoops = new LoopDetector({ threshold: 2, window: 6 });
const seenThoughts = new Map();
const openReasoning = [];
let streamStart = 0;
let firstBatch = true;
let unread = 0;
const MAX_RENDERED_NODES = 400;
const MAX_COMMANDS_PER_GROUP = 120;
let telemetryOffset = 0;
let telemetrySamples = [];
let lastTelemetryAt = 0;
let lastErrorText = "";
let filterMode = "all";
let searchQuery = "";
let trimmedCount = 0;
let trimNote = null;
let emptyFilterNote = null;
let lastMarkerSample = null;
const overlayMode = params.get("overlay") === "1";
if (overlayMode) document.body.classList.add("overlay");
const statusState = document.getElementById("statusState");
const statusActivity = document.getElementById("statusActivity");
const statusMeta = document.getElementById("statusMeta");
const statusCurrent = document.getElementById("statusCurrent");
const statusDone = document.getElementById("statusDone");
const statusScores = document.getElementById("statusScores");
const statusMetrics = document.getElementById("statusMetrics");
const transcriptSearch = document.getElementById("transcriptSearch");
const FILTER_BUTTONS = {
  all: document.getElementById("filterAll"),
  thinking: document.getElementById("filterThinking"),
  actions: document.getElementById("filterActions"),
  messages: document.getElementById("filterMessages"),
  errors: document.getElementById("filterErrors"),
  decisions: document.getElementById("filterDecisions"),
};
const FILTER_ICONS = {
  all: "stack",
  thinking: "brain",
  actions: "wrench",
  messages: "chat",
  errors: "siren",
  decisions: "compass",
};
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
    tokens: "tok",
    plan: "plan",
    turn: "turn",
    newEvents: "new",
    loop: "loop?",
    repeated: "repeated",
    raw: "raw",
    rateSuffix: "/min",
    noTelemetry: "no telemetry",
    researchLabel: "research",
    trimmed: "earlier entries trimmed",
    noEntries: "No entries for this filter",
    showAll: "Show all",
    loading: "loading",
    stale: "stale",
    failed: "failed",
    running: "running",
    ranCommands: "Ran {count} commands",
    metrics: {
      production: "Production",
      research: "Research",
      power: "Power",
      telemetry: "Telemetry",
      error: "Error",
      automation: "Automation",
      penalty: "Penalty",
      manualMines: "mined",
      manualCrafts: "crafted",
    },
    sparkStable: "stable",
    sparkUp: "+{percent}%",
    sparkDown: "-{percent}%",
    sparkHint: "Relative trend over the last 8 telemetry samples (normalized per item), not absolute output.",
    badges: {
      build: "build",
      mine: "mine",
      deconstruct: "remove",
      move: "move",
      rotate: "rotate",
      recipe: "recipe",
      craft: "craft",
      research: "research",
      insert: "insert",
      extract: "extract",
      rocket: "rocket",
      settings: "settings",
      observe: "observe",
      job: "job",
      wait: "wait",
      server: "server",
      run: "run",
      script: "script",
      action: "act",
      other: "cmd",
    },
    expand: "Expand status details",
    collapse: "Collapse status details",
    stats: "Detailed stats",
    stateTimer: "Plan",
    stateBlocked: "update plan",
    stateGrace: "plan grace",
    stateTimerTitle: "STATE.md freshness: actions are blocked when the hard deadline expires",
    planPenalty: "plan",
    runStatusLabel: "Run status",
    planLabel: "Current plan",
    telemetryLabel: "Live telemetry",
    searchLabel: "Filter transcript",
    filtersLabel: "Transcript filters",
    filterGroupLabel: "Filter by category",
    planKicker: "Work order",
    telemetryKicker: "Readouts",
    documentTitle: "Autorio factory log",
    factoryLog: "factory log",
    elapsedLabel: "elapsed",
    tokensLabel: "tokens",
    contextLabel: "context",
    displayOptionsLabel: "Display options",
    connectionLost: "Manager connection lost. The transcript may be stale.",
    connectionRetry: "Retry",
    map: "Map",
    mapTitle: "Map settings",
    mapClose: "Close map settings",
    mapSeed: "Seed",
    mapPeaceful: "Peaceful mode",
    mapOn: "On",
    mapOff: "Off",
    mapResources: "Resource settings",
    mapResource: "Resource",
    mapFrequency: "Frequency",
    mapSize: "Size",
    mapRichness: "Richness",
    mapNoResources: "No autoplace overrides — default resource generation.",
    mapNoData: "Map settings are not available for this run.",
    mapNote:
      "Seed and autoplace overrides used to generate the benchmark map; blank values use Factorio defaults.",
    mapExtras: "Other map settings",
    mapRaw: "Raw map_gen",
    light: "Light",
    dark: "Dark",
    switchLight: "Switch to light theme",
    switchDark: "Switch to dark theme",
    filters: {
      all: "All",
      thinking: "Thinking",
      actions: "Actions",
      messages: "Messages",
      errors: "Errors",
      decisions: "Decisions",
    },
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
    tokens: "令牌",
    plan: "计划",
    turn: "回合",
    newEvents: "条新消息",
    loop: "循环?",
    repeated: "重复",
    raw: "原始",
    rateSuffix: "/分",
    noTelemetry: "无遥测数据",
    researchLabel: "研究",
    trimmed: "更早记录已裁剪",
    noEntries: "当前过滤下没有内容",
    showAll: "显示全部",
    loading: "加载中",
    stale: "已过期",
    failed: "失败",
    running: "运行中",
    ranCommands: "执行了 {count} 个命令",
    metrics: {
      production: "产量",
      research: "研究",
      power: "电力",
      telemetry: "遥测",
      error: "错误",
      automation: "自动化",
      penalty: "惩罚",
      manualMines: "采矿",
      manualCrafts: "合成",
    },
    sparkStable: "稳定",
    sparkUp: "+{percent}%",
    sparkDown: "-{percent}%",
    sparkHint: "最近 8 个遥测采样的相对趋势（按该项自身范围归一化），不是绝对产量。",
    badges: {
      build: "建造",
      mine: "采矿",
      deconstruct: "拆除",
      move: "移动",
      rotate: "旋转",
      recipe: "配方",
      craft: "制作",
      research: "研究",
      insert: "输入",
      extract: "取出",
      rocket: "火箭",
      settings: "设置",
      observe: "观察",
      job: "任务",
      wait: "等待",
      server: "服务器",
      run: "运行",
      script: "脚本",
      action: "动作",
      other: "命令",
    },
    expand: "展开状态详情",
    collapse: "收起状态详情",
    stats: "详细统计",
    stateTimer: "计划",
    stateBlocked: "需更新计划",
    stateGrace: "计划宽限",
    stateTimerTitle: "STATE.md 新鲜度：超过硬性期限后动作会被阻止",
    planPenalty: "计划",
    runStatusLabel: "运行状态",
    planLabel: "当前计划",
    telemetryLabel: "实时遥测",
    searchLabel: "过滤记录",
    filtersLabel: "记录过滤",
    filterGroupLabel: "按类别过滤",
    planKicker: "作业指令",
    telemetryKicker: "运行读数",
    documentTitle: "Autorio 工厂日志",
    factoryLog: "工厂日志",
    elapsedLabel: "已用时",
    tokensLabel: "令牌",
    contextLabel: "上下文",
    displayOptionsLabel: "显示选项",
    connectionLost: "与 manager 的连接中断，记录可能已停止更新。",
    connectionRetry: "重试",
    map: "地图",
    mapTitle: "地图设置",
    mapClose: "关闭地图设置",
    mapSeed: "种子",
    mapPeaceful: "和平模式",
    mapOn: "开",
    mapOff: "关",
    mapResources: "资源配置",
    mapResource: "资源",
    mapFrequency: "频率",
    mapSize: "大小",
    mapRichness: "富集度",
    mapNoResources: "没有资源生成覆盖，使用 Factorio 默认配置。",
    mapNoData: "当前 run 没有地图配置信息。",
    mapNote:
      "生成基准地图时使用的种子与资源生成覆盖。这里只列出覆盖项，未列出的资源和空值使用 Factorio 默认配置。",
    mapExtras: "其他地图设置",
    mapRaw: "原始 map_gen",
    light: "浅色",
    dark: "深色",
    switchLight: "切换到浅色主题",
    switchDark: "切换到深色主题",
    filters: {
      all: "全部",
      thinking: "思考",
      actions: "动作",
      messages: "消息",
      errors: "错误",
      decisions: "决策",
    },
  },
};
let lastStatusAt = 0,
  lastEventAt = 0,
  activity = "idle",
  uiLang,
  currentRun = null,
  mapAutoOpened = false;
const statusHeader = document.getElementById("agentStatus");
const statusTools = document.querySelector?.(".status-tools") ?? null;
const runMastheadContext = document.getElementById("runMastheadContext");
const planKicker = document.getElementById("planKicker");
const telemetryKicker = document.getElementById("telemetryKicker");
const connectionNotice = document.getElementById("connectionNotice");
const connectionNoticeText = document.getElementById("connectionNoticeText");
const connectionRetry = document.getElementById("connectionRetry");
const statusToggle = document.getElementById("statusToggle");
const mapInfoToggle = document.getElementById("mapInfoToggle");
const mapInfoOverlay = document.getElementById("mapInfoOverlay");
const mapInfoBody = document.getElementById("mapInfoBody");
const mapInfoClose = document.getElementById("mapInfoClose");
const mapInfoTitle = document.getElementById("mapInfoTitle");
const mapInfoNote = document.getElementById("mapInfoNote");
const themeToggle = document.getElementById("themeToggle");
const stateTimer = document.getElementById("stateTimer");
const STATUS_COLLAPSED_KEY = "autorio.statusCollapsed";
let lastFocusedElement = null;
function updateSectionLabels(text) {
  if (runMastheadContext) runMastheadContext.textContent = text.factoryLog || "factory log";
  if (planKicker) planKicker.textContent = text.planKicker || "Work order";
  if (telemetryKicker) telemetryKicker.textContent = text.telemetryKicker || "Live telemetry";
  statusTools?.setAttribute("aria-label", text.displayOptionsLabel || "Display options");
  if (connectionNotice && !connectionNotice.hidden) {
    if (connectionNoticeText) connectionNoticeText.textContent = text.connectionLost;
    if (connectionRetry) connectionRetry.textContent = text.connectionRetry || "Retry";
  }
}
function showConnectionNotice() {
  if (!connectionNotice) return;
  const text = strings();
  if (connectionNoticeText) connectionNoticeText.textContent = text.connectionLost;
  if (connectionRetry) connectionRetry.textContent = text.connectionRetry || "Retry";
  connectionNotice.hidden = false;
}
function hideConnectionNotice() {
  if (connectionNotice) connectionNotice.hidden = true;
}
connectionRetry?.addEventListener("click", () => {
  hideConnectionNotice();
  void poll();
});
function setModalBackgroundInert(inert) {
  for (const node of [statusHeader, document.querySelector?.("main.transcript-pane"), jumpButton]) {
    if (!node) continue;
    if (inert) {
      node.inert = true;
      node.setAttribute("aria-hidden", "true");
    } else {
      node.inert = false;
      node.removeAttribute("aria-hidden");
    }
  }
}
function updateStatusToggleLabel() {
  if (!statusToggle || !statusHeader) return;
  const collapsed = statusHeader.classList.contains("collapsed");
  const strings = I18N[uiLang || "en"];
  statusToggle.replaceChildren(icon("stats"), element("span", strings.stats, "status-toggle-label"));
  statusToggle.setAttribute("aria-expanded", collapsed ? "false" : "true");
  statusToggle.setAttribute("aria-label", collapsed ? strings.expand : strings.collapse);
  statusToggle.setAttribute("title", collapsed ? strings.expand : strings.collapse);
}
function updateMapToggleLabel() {
  if (!mapInfoToggle) return;
  const strings = I18N[uiLang || "en"];
  mapInfoToggle.replaceChildren(icon("map"), element("span", strings.map, "status-map-label"));
  mapInfoToggle.setAttribute("aria-label", strings.mapTitle);
  mapInfoToggle.setAttribute("title", strings.mapTitle);
  if (mapInfoTitle) mapInfoTitle.textContent = strings.mapTitle;
  if (mapInfoClose) mapInfoClose.setAttribute("aria-label", strings.mapClose);
  if (mapInfoNote) mapInfoNote.textContent = strings.mapNote;
}
const THEME_KEY = "autorio.theme";
function currentTheme() {
  return document.documentElement.dataset.theme === "light" ? "light" : "dark";
}
function updateThemeToggleLabel() {
  if (!themeToggle) return;
  const strings = I18N[uiLang || "en"];
  const light = currentTheme() === "light";
  themeToggle.replaceChildren(
    icon(light ? "moon" : "sun"),
    element("span", light ? strings.dark : strings.light, "status-theme-label"),
  );
  const label = light ? strings.switchDark : strings.switchLight;
  themeToggle.setAttribute("aria-label", label);
  themeToggle.setAttribute("title", label);
  themeToggle.setAttribute("aria-pressed", light ? "true" : "false");
}
function setTheme(theme, persist = true) {
  document.documentElement.dataset.theme = theme;
  if (persist) {
    try {
      localStorage.setItem(THEME_KEY, theme);
    } catch {
      /* localStorage may be unavailable */
    }
  }
  updateThemeToggleLabel();
}
themeToggle?.addEventListener("click", () => {
  setTheme(currentTheme() === "light" ? "dark" : "light");
});
function mapValueText(value) {
  return value === null || value === undefined || value === "" ? "—" : String(value);
}
function renderMapInfo() {
  if (!mapInfoBody) return;
  const strings = I18N[uiLang || "en"];
  const view = mapSettingsView(currentRun);
  if (!view) {
    mapInfoBody.replaceChildren(element("p", strings.mapNoData, "map-info-muted"));
    return;
  }
  const nodes = [];
  const seed = element("div", "", "map-info-seed");
  seed.append(element("span", strings.mapSeed, "map-info-label"), element("code", mapValueText(view.seed)));
  nodes.push(seed);
  if (view.peaceful !== null) {
    const peaceful = element("div", "", "map-info-extra");
    peaceful.append(
      element("span", strings.mapPeaceful, "map-info-label"),
      element("code", view.peaceful ? strings.mapOn : strings.mapOff),
    );
    nodes.push(peaceful);
  }
  nodes.push(element("h3", strings.mapResources, "map-info-section-title"));
  if (view.resources.length) {
    const table = element("table", "", "map-resource-table");
    const thead = element("thead");
    const head = element("tr");
    for (const label of [strings.mapResource, strings.mapFrequency, strings.mapSize, strings.mapRichness]) {
      head.append(element("th", label));
    }
    thead.append(head);
    const tbody = element("tbody");
    for (const resource of view.resources) {
      const row = element("tr");
      row.append(
        element("td", resource.name),
        element("td", mapValueText(resource.frequency)),
        element("td", mapValueText(resource.size)),
        element("td", mapValueText(resource.richness)),
      );
      tbody.append(row);
    }
    table.append(thead, tbody);
    nodes.push(table);
  } else {
    nodes.push(element("p", strings.mapNoResources, "map-info-muted"));
  }
  if (view.extras.length) {
    nodes.push(element("h3", strings.mapExtras, "map-info-section-title"));
    for (const extra of view.extras) {
      const row = element("div", "", "map-info-extra");
      row.append(element("span", extra.key, "map-info-label"), element("code", extra.value));
      nodes.push(row);
    }
  }
  const raw = element("details", "", "map-info-raw");
  raw.append(element("summary", strings.mapRaw), element("pre", JSON.stringify(view.raw, null, 2)));
  nodes.push(raw);
  mapInfoBody.replaceChildren(...nodes);
}
function openMapInfo() {
  if (!mapInfoOverlay) return;
  const active = document.activeElement;
  lastFocusedElement =
    active && active !== document.body && active !== document.documentElement ? active : mapInfoToggle;
  setModalBackgroundInert(true);
  renderMapInfo();
  mapInfoOverlay.hidden = false;
  mapInfoToggle?.setAttribute("aria-expanded", "true");
  mapInfoClose?.focus?.();
}
function closeMapInfo() {
  if (!mapInfoOverlay) return;
  mapInfoOverlay.hidden = true;
  mapInfoToggle?.setAttribute("aria-expanded", "false");
  setModalBackgroundInert(false);
  const target = lastFocusedElement?.isConnected ? lastFocusedElement : mapInfoToggle;
  target?.focus?.();
  lastFocusedElement = null;
}
function setStatusCollapsed(collapsed, persist = false) {
  if (!statusHeader) return;
  statusHeader.classList.toggle("collapsed", collapsed);
  updateStatusToggleLabel();
  if (persist) {
    try {
      localStorage.setItem(STATUS_COLLAPSED_KEY, collapsed ? "1" : "0");
    } catch {
      /* localStorage may be unavailable */
    }
  }
}
statusToggle?.addEventListener("click", () => {
  setStatusCollapsed(!statusHeader.classList.contains("collapsed"), true);
});
mapInfoToggle?.addEventListener("click", () => {
  if (mapInfoOverlay?.hidden) openMapInfo();
  else closeMapInfo();
});
mapInfoClose?.addEventListener("click", closeMapInfo);
mapInfoOverlay?.addEventListener("click", (event) => {
  if (event.target === mapInfoOverlay) closeMapInfo();
});
document.addEventListener?.("keydown", (event) => {
  if (!mapInfoOverlay || mapInfoOverlay.hidden) return;
  if (event.key === "Escape") {
    closeMapInfo();
    return;
  }
  if (event.key !== "Tab") return;
  const focusable = [
    ...(document
      .getElementById("mapInfoDialog")
      ?.querySelectorAll(
        'button, [href], input, select, textarea, summary, [tabindex]:not([tabindex="-1"])',
      ) || []),
  ].filter((node) => !node.disabled && node.getClientRects().length > 0);
  if (!focusable.length) return;
  const first = focusable[0];
  const last = focusable[focusable.length - 1];
  const active = document.activeElement;
  const inDialog = active && document.getElementById("mapInfoDialog")?.contains(active);
  if (event.shiftKey && (active === first || !inDialog)) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && (active === last || !inDialog)) {
    event.preventDefault();
    first.focus();
  }
});
updateThemeToggleLabel();
document.title = "Autorio factory log";
function element(tag, text, className) {
  const node = document.createElement(tag);
  if (text) node.textContent = text;
  if (className) node.className = className;
  return node;
}
function setStatusCurrent(label) {
  if (!statusCurrent) return;
  if (!label) {
    statusCurrent.replaceChildren();
    statusCurrent.hidden = true;
    return;
  }
  statusCurrent.replaceChildren(icon("target"), element("span", label, "status-current-text"));
  statusCurrent.hidden = false;
}
const BADGE_ICONS = {
  build: "hammer",
  mine: "pickaxe",
  deconstruct: "trash",
  observe: "eye",
  move: "move",
  rotate: "rotate",
  recipe: "book",
  craft: "wrench",
  research: "flask",
  insert: "arrow-right",
  extract: "arrow-left",
  rocket: "rocket",
  settings: "sliders",
  job: "clipboard",
  wait: "clock",
  script: "laptop",
  server: "server",
  run: "arrow-right",
  action: "wrench",
  other: "laptop",
};
function icon(name, className = "icon") {
  return element("span", "", `${className} icon-${name}`);
}
function prependIcon(node, name) {
  if (!node || typeof node.prepend !== "function") return node;
  node.prepend(icon(name));
  return node;
}
function setJumpLabel(label) {
  jumpButton.textContent = label;
  prependIcon(jumpButton, "arrow-down");
}
function badgeIcon(category) {
  return BADGE_ICONS[category] || "terminal";
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
function formatStateRemaining(seconds) {
  const total = Math.max(0, Math.round(Number(seconds) || 0));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}
function updateStateTimer(run) {
  if (!stateTimer) return;
  const active = ["running", "preparing", "launching", "saving"].includes(run.state);
  const status = run.state_status;
  if (!active || !status) {
    stateTimer.hidden = true;
    return;
  }
  const text = I18N[uiLang || "en"];
  let content;
  let state;
  if (status.blocked) {
    content = `⚠ ${text.stateBlocked}`;
    state = "blocked";
  } else if (status.age_seconds === null) {
    const remaining = Math.max(0, (status.grace_seconds ?? 120) - (run.elapsed_seconds || 0));
    content = `${text.stateGrace} ${formatStateRemaining(remaining)}`;
    state = status.due ? "due" : "ok";
  } else {
    const remaining = Math.max(0, (status.hard_seconds ?? 600) - status.age_seconds);
    content = `${text.stateTimer} ${formatStateRemaining(remaining)}`;
    state = status.due ? "due" : "ok";
  }
  stateTimer.replaceChildren(icon("clock"), element("span", content, "state-timer-text"));
  stateTimer.className = `state-timer ${state}`;
  stateTimer.title = text.stateTimerTitle;
  stateTimer.hidden = false;
}
function svgElement(tag, attributes = {}) {
  if (typeof document.createElementNS !== "function") return null;
  const node = document.createElementNS("http://www.w3.org/2000/svg", tag);
  for (const [name, value] of Object.entries(attributes)) node.setAttribute(name, String(value));
  return node;
}
/** Compact hexagonal radar for the six STATE.md scores. */
function renderScoreRadar(scores, activeKey) {
  if (!SCORE_AXES.some((key) => scores[key] != null)) return null;
  const geometry = radarGeometry(scores, { size: 96, radius: 30, active: activeKey });
  const svg = svgElement("svg", {
    viewBox: `0 0 ${geometry.size} ${geometry.size}`,
    class: "score-radar",
    role: "img",
    "aria-label": SCORE_AXES.map((key) => `${key} ${scores[key] ?? 0}`).join(", "),
  });
  if (!svg) return null;
  for (const points of geometry.rings) {
    svg.append(svgElement("polygon", { points, class: "radar-ring" }));
  }
  for (const axis of geometry.axes) {
    svg.append(
      svgElement("line", {
        x1: geometry.center,
        y1: geometry.center,
        x2: axis.axisX.toFixed(2),
        y2: axis.axisY.toFixed(2),
        class: "radar-axis",
      }),
    );
  }
  svg.append(svgElement("polygon", { points: geometry.polygon, class: "score-polygon" }));
  for (const axis of geometry.axes) {
    svg.append(
      svgElement("circle", {
        cx: axis.x.toFixed(2),
        cy: axis.y.toFixed(2),
        r: axis.active ? 2.4 : 1.6,
        class: axis.active ? "score-dot active" : "score-dot",
      }),
    );
    const label = svgElement("text", {
      x: axis.labelX.toFixed(2),
      y: (axis.labelY + 2.5).toFixed(2),
      "text-anchor": axis.labelAnchor,
      class: axis.active ? "radar-label active" : "radar-label",
    });
    label.textContent = strings().subtasks[axis.key] || axis.key;
    label.setAttribute("title", `${axis.key}: ${axis.value}`);
    svg.append(label);
  }
  return svg;
}
function renderStatus(run) {
  if (!statusState || !statusScores) return;
  currentRun = run;
  if (!uiLang) {
    uiLang = pickLanguage(run);
    document.documentElement.lang = uiLang === "zh" ? "zh-CN" : "en";
  }
  const strings = I18N[uiLang] || I18N.en;
  updateTranscriptTools(strings);
  updateMapToggleLabel();
  updateThemeToggleLabel();
  const state = run.state || "—";
  statusState.textContent = strings.states[state] || state;
  statusState.className = `status-badge ${state}`;
  const activeKey = state === "running" ? (Date.now() - lastEventAt > 12000 ? "idle" : activity) : state;
  const waitSeconds =
    (activeKey === "thinking" || activeKey === "idle") && lastEventAt
      ? Math.max(0, Math.round((Date.now() - lastEventAt) / 1000))
      : 0;
  const terminalState = !["running", "preparing", "launching", "saving"].includes(state);
  statusActivity.classList.toggle("idle", terminalState);
  statusActivity.textContent = terminalState
    ? ""
    : `${strings.activity[activeKey] || activeKey}${waitSeconds ? ` ${waitSeconds}s` : ""}`;
  updateStateTimer(run);
  const usage = run.usage || {};
  const tokens = usage.total_tokens ?? (usage.input_tokens || 0) + (usage.output_tokens || 0);
  const context = run.context_limit
    ? `${strings.contextLabel} ${Math.round((run.context_tokens || 0) / 1000)}k/${Math.round(run.context_limit / 1000)}k`
    : "";
  statusMeta.replaceChildren(
    element(
      "span",
      `${strings.elapsedLabel} ${Math.round(run.elapsed_seconds || 0)}s / ${run.max_seconds || 0}s`,
      "status-readout",
    ),
    element("span", `${Number(tokens || 0).toLocaleString()} ${strings.tokensLabel}`, "status-readout"),
    ...(context ? [element("span", context, "status-readout")] : []),
  );
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
    const suffix = current || research;
    setStatusCurrent(`⚠ ${strings.plan} ${strings.stale}${suffix ? ` · ${suffix}` : ""}`);
    statusDone.textContent = done ? `${strings.done}: ${done}` : "";
    statusDone.hidden = !done;
    statusHeader?.classList.add("stale-plan");
  } else {
    // Do not advertise a file the agent has not written: with no STATE.md and no
    // research progress there is nothing useful to show, so hide the line.
    setStatusCurrent(current ? `${current}` : research || "");
    statusDone.textContent = done ? `${strings.done}: ${done}` : "";
    statusDone.hidden = !done;
    statusHeader?.classList.remove("stale-plan");
  }
  if (!mapAutoOpened && params.get("map") === "1") {
    mapAutoOpened = true;
    openMapInfo();
  }
  const scores = parseScores(markdown);
  const hasScores = SUBTASKS.some((key) => scores[key] != null);
  statusScores.hidden = !hasScores;
  if (!hasScores) {
    statusScores.replaceChildren();
    return;
  }
  const activeSubtask =
    SUBTASKS.find(
      (key) =>
        current.toLowerCase().includes(key) ||
        (strings.subtasks[key] && current.includes(strings.subtasks[key])),
    ) || "";
  const radar = renderScoreRadar(scores, activeSubtask);
  if (radar) statusScores.replaceChildren(radar);
  else statusScores.replaceChildren(element("span", "", "score-radar-fallback"));
}
function strings() {
  return I18N[uiLang || "en"] || I18N.en;
}
function setDetailsOpen(node, open) {
  node.open = open;
  if (open) node.setAttribute("open", "");
  else node.removeAttribute?.("open");
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
    details._kind = "commands";
    const summary = element("summary", "", "commands-summary");
    details.append(summary);
    if (openCommandGroup && openCommandGroup !== details) setDetailsOpen(openCommandGroup, false);
    openCommandGroup = details;
    setDetailsOpen(details, true);
    output.append(details);
    commandGroup = { details, summary, items: new Map(), loop: 0 };
  }
  return commandGroup;
}
function refreshCommandGroup(group) {
  const items = [...group.items.values()];
  const text = strings();
  const stats = summarizeCommandGroup(items, {
    labels: text.badges,
    failed: text.failed,
    running: text.running,
    ran: (count) => String(text.ranCommands || "Ran {count} commands").replace("{count}", String(count)),
  });
  const loopPrefix = group.loop ? `⚠ ${strings().loop} ×${group.loop} · ` : "";
  group.summary.textContent = `${loopPrefix}${stats.text}`;
  // Let the group icon reflect its dominant action category instead of every
  // command group showing the same blue laptop glyph.
  const counts = new Map();
  for (const item of items) {
    const category = summarizeCommand(item).category;
    counts.set(category, (counts.get(category) || 0) + 1);
  }
  const dominant =
    [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]?.[0] || "script";
  group.summary.className = `commands-summary cat-${dominant}`;
  prependIcon(group.summary, badgeIcon(dominant));
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
  const badge = element(
    "span",
    strings().badges?.[summary.category] || summary.label,
    `action-badge ${summary.category}`,
  );
  if (summary.failed) badge.classList.add("failed");
  prependIcon(badge, badgeIcon(summary.category));
  const main = element("span", "", "action-main");
  if (summary.target) main.append(element("span", summary.target, "action-target"));
  if (summary.outcome) main.append(element("span", summary.outcome, "action-outcome"));
  if (summary.durationMs != null)
    main.append(element("span", formatDurationText(summary.durationMs), "action-duration"));
  if (summary.running) main.append(element("span", strings().activity.acting, "action-flag"));
  const raw = element("details", "", "action-raw");
  raw.append(
    element("summary", strings().raw),
    element("pre", item.command || ""),
    element("pre", item.aggregated_output || "", "command-output"),
  );
  const label = timeLabel(item);
  entry.node.replaceChildren(...[badge, main, raw].concat(label ? [element("span", label, "msg-time")] : []));
  entry.node._kind = "commands";
  if (summary.failed) lastErrorText = `${summary.label}${summary.target ? ` ${summary.target}` : ""} failed`;
  else if (item.status === "completed") lastErrorText = "";
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
  // Keep very long command groups bounded; raw logs still contain everything.
  if (typeof group.details.removeChild === "function") {
    while (group.details.children.length > MAX_COMMANDS_PER_GROUP) {
      const first = group.details.firstChild;
      if (!first) break;
      group.details.removeChild(first);
    }
  }
  while (group.items.size > MAX_COMMANDS_PER_GROUP * 2) {
    const oldest = group.items.keys().next().value;
    if (oldest === undefined) break;
    group.items.delete(oldest);
  }
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
  const summary = element("summary", "", "reasoning-summary");
  summary.textContent = segments[0]?.summary || "…";
  prependIcon(summary, "brain");
  const badge = element("span", "", "dedupe-badge");
  badge.hidden = true;
  summary.append(badge);
  const label = timeLabel(item);
  if (label) summary.append(element("span", label, "msg-time"));
  const body = element("div", "", "reasoning-body");
  for (const segment of segments) {
    const frame = element("div", "", `reasoning-segment${isDecisionText(segment.body) ? " decision" : ""}`);
    frame.append(element("div", collapseRepeatedSentences(segment.body), "reasoning-segment-text"));
    body.append(frame);
  }
  if (!segments.length)
    body.append(element("div", collapseRepeatedSentences(text), "reasoning-segment-text"));
  node.append(summary, body);
  node._kind = "reasoning";
  node._decision = isDecisionText(text);
  output.append(node);
  const entry = { node, badge, count: 1 };
  entries.set(item.id, entry);
  if (key) seenThoughts.set(key, entry);
  openReasoning.push(node);
  while (openReasoning.length > 2) {
    const old = openReasoning.shift();
    if (old) setDetailsOpen(old, false);
  }
  setDetailsOpen(node, true);
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
  entry.node._kind = "message";
  entry.node._error = item.type === "error";
  if (item.type === "error") lastErrorText = String(item.text || "agent error").slice(0, 80);
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
    node._kind = "tool";
    entries.set(item.id, entry);
  }
  const info = summarizeTool(item);
  const title = `${info.label}${info.detail ? ` · ${info.detail}` : ""}`;
  if (entry.title !== title) {
    entry.title = title;
    entry.summary.textContent = title;
    prependIcon(entry.summary, "wrench");
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
  else if (item.type === "event_marker") renderEventMarker(item.text || "");
  else renderTool(item);
}
function appendTurn(generation) {
  commandGroup = null;
  const divider = element("div", `${strings().turn} ${generation}`, "turn-separator");
  divider._kind = "turn";
  output.append(divider);
}
function updateTranscriptTools(text) {
  for (const [mode, button] of Object.entries(FILTER_BUTTONS)) {
    if (!button) continue;
    button.replaceChildren(
      icon(FILTER_ICONS[mode] || "stack"),
      element("span", text.filters?.[mode] || mode, "chip-label"),
    );
    button.setAttribute("aria-pressed", button.classList.contains("active") ? "true" : "false");
  }
  if (transcriptSearch) {
    transcriptSearch.placeholder = uiLang === "zh" ? "过滤内容…" : "Filter…";
    transcriptSearch.setAttribute("aria-label", text.searchLabel || "Filter transcript");
  }
  document.getElementById("agentStatus")?.setAttribute("aria-label", text.runStatusLabel || "Run status");
  document.getElementById("planPanel")?.setAttribute("aria-label", text.planLabel || "Current plan");
  document
    .getElementById("telemetryPanel")
    ?.setAttribute("aria-label", text.telemetryLabel || "Live telemetry");
  document
    .getElementById("transcriptTools")
    ?.setAttribute("aria-label", text.filtersLabel || "Transcript filters");
  document
    .getElementById("filterGroup")
    ?.setAttribute("aria-label", text.filterGroupLabel || "Filter by category");
  updateSectionLabels(text);
  document.title = text.documentTitle || "Autorio factory log";
  updateStatusToggleLabel();
}
function nodeMatchesFilter(node) {
  if (
    searchQuery &&
    !String(node.textContent || "")
      .toLowerCase()
      .includes(searchQuery)
  )
    return false;
  if (filterMode === "all") return true;
  const kind = node._kind;
  if (filterMode === "thinking") return kind === "reasoning";
  if (filterMode === "actions") return kind === "commands";
  if (filterMode === "messages") return kind === "message";
  if (filterMode === "errors")
    return Boolean(node._error) || (kind === "commands" && node.classList.contains("failed"));
  if (filterMode === "decisions") return kind === "reasoning" && Boolean(node._decision);
  return true;
}
function applyFilters() {
  if (!output) return;
  let visible = 0;
  for (const node of [...output.children]) {
    if (node === trimNote || node === emptyFilterNote) continue;
    const match = nodeMatchesFilter(node);
    node.hidden = !match;
    if (match) visible += 1;
  }
  if (filterMode !== "all" && visible === 0) {
    if (!emptyFilterNote) {
      emptyFilterNote = element("div", "", "filter-empty");
      emptyFilterNote._kind = "empty";
      const label = element("span", "", "filter-empty-text");
      const reset = element("button", "", "filter-empty-reset");
      reset.type = "button";
      reset.addEventListener("click", () => {
        if (transcriptSearch) transcriptSearch.value = "";
        searchQuery = "";
        try {
          localStorage.removeItem("autorio.search");
        } catch {
          /* localStorage may be unavailable */
        }
        setFilter("all");
      });
      emptyFilterNote.append(label, reset);
      emptyFilterNote._label = label;
      emptyFilterNote._reset = reset;
      output.append(emptyFilterNote);
    }
    emptyFilterNote._label.textContent = strings().noEntries;
    emptyFilterNote._reset.textContent = strings().showAll;
    emptyFilterNote.hidden = false;
  } else if (emptyFilterNote) {
    emptyFilterNote.hidden = true;
  }
}
function setFilter(mode) {
  filterMode = mode;
  for (const [key, button] of Object.entries(FILTER_BUTTONS)) {
    if (!button) continue;
    const active = key === mode;
    button.classList.toggle("active", active);
    button.setAttribute("aria-pressed", active ? "true" : "false");
  }
  applyFilters();
  try {
    localStorage.setItem("autorio.filter", mode);
  } catch {
    /* localStorage may be unavailable */
  }
}
function trimTranscript() {
  if (typeof output.removeChild !== "function") return;
  while (output.children.length > MAX_RENDERED_NODES) {
    const first = output.firstChild;
    if (!first) break;
    output.removeChild(first);
    trimmedCount += 1;
  }
  if (!trimmedCount) return;
  if (!trimNote) {
    trimNote = element("div", "", "trimmed-note");
    output.prepend(trimNote);
  }
  trimNote.textContent = `${trimmedCount} ${strings().trimmed}`;
}
function renderEventMarker(text) {
  commandGroup = null;
  const node = element("div", text, "event-marker");
  node._kind = "marker";
  prependIcon(node, "flag");
  output.append(node);
}
function metricValue(iconName, value) {
  const cell = element("td", "", "metric-value");
  cell.append(icon(iconName), element("span", value, "metric-text"));
  return cell;
}
function renderMetrics() {
  if (!statusMetrics) return;
  const text = strings();
  const rows = [];
  if (telemetrySamples.length) {
    const rates = telemetryRates(telemetrySamples, { limit: 2 });
    const top = rates[0];
    if (top) {
      const row = element("tr", "", "metric metric-production");
      row.append(
        element("th", text.metrics.production, "metric-label"),
        metricValue("factory", `${top.name} ${Math.round(top.rate)}${text.rateSuffix}`),
      );
      const series = telemetrySeries(telemetrySamples, top.name, 8);
      const trend = sparkTrend(series);
      const trendCell = element("td", "", "metric-trend");
      const spark = element("span", "", "metric-spark");
      spark.title = text.sparkHint;
      for (const width of miniBars(series)) {
        const bar = element("span", "", "metric-bar");
        bar.style.width = `${Math.max(6, width)}%`;
        spark.append(bar);
      }
      const delta =
        trend.direction === "flat"
          ? text.sparkStable
          : (trend.direction === "up" ? text.sparkUp : text.sparkDown).replace(
              "{percent}",
              String(trend.percent),
            );
      trendCell.append(spark, element("span", delta, `metric-delta ${trend.direction}`));
      row.append(trendCell);
      rows.push(row);
    }
    const research = telemetryResearchDetail(telemetrySamples);
    if (research) {
      const row = element("tr", "", "metric metric-research");
      row.append(element("th", text.metrics.research, "metric-label"), metricValue("flask", research.name));
      const trendCell = element("td", "", "metric-trend");
      if (research.progress !== null) {
        const percent = Math.round(research.progress * 100);
        const track = element("span", "", "metric-progress");
        const fill = element("span", "", "metric-progress-fill");
        fill.style.width = `${percent}%`;
        track.append(fill);
        trendCell.append(track, element("span", `${percent}%`, "metric-delta"));
      }
      row.append(trendCell);
      rows.push(row);
    }
    const power = telemetryPowerSatisfaction(telemetrySamples);
    if (power !== null) {
      const row = element("tr", "", "metric metric-power");
      row.append(
        element("th", text.metrics.power, "metric-label"),
        metricValue("bolt", `${Math.round(power * 100)}%`),
        element("td", "", "metric-trend"),
      );
      rows.push(row);
    }
  } else {
    const row = element("tr", "", "metric muted");
    row.append(
      element("th", text.metrics.telemetry, "metric-label"),
      metricValue("cog", text.noTelemetry),
      element("td", "", "metric-trend"),
    );
    rows.push(row);
  }
  const automation = currentRun?.automation;
  if (automation) {
    const score = Math.round(Number(automation.score) || 0);
    const row = element("tr", "", "metric metric-automation");
    const automationValue = metricValue("factory", `${score}`);
    automationValue.classList.add(score < 0 ? "negative" : "positive");
    row.append(
      element("th", text.metrics.automation, "metric-label"),
      automationValue,
      element("td", `+${Math.round(Number(automation.positive) || 0)}`, "metric-trend metric-delta"),
    );
    rows.push(row);
    const penaltyRow = element("tr", "", "metric metric-penalty");
    const penaltyValue = metricValue("pickaxe", `-${Math.round(Number(automation.penalty) || 0)}`);
    penaltyValue.classList.add("penalised");
    const penaltyTrend = element("td", "", "metric-trend");
    const details = element("span", "", "penalty-details");
    details.append(
      icon("pickaxe"),
      element("span", `${Math.round(Number(automation.manual_mines) || 0)}`),
      icon("wrench"),
      element("span", `${Math.round(Number(automation.manual_crafts) || 0)}`),
    );
    if (Number(automation.state_penalty) > 0) {
      details.append(
        icon("clock"),
        element("span", `-${Math.round(Number(automation.state_penalty))}`, "penalty-state"),
      );
    }
    details.title = `${text.metrics.penalty}: ${text.metrics.manualMines || "mined"} / ${text.metrics.manualCrafts || "crafted"}`;
    penaltyTrend.append(details);
    penaltyRow.append(element("th", text.metrics.penalty, "metric-label"), penaltyValue, penaltyTrend);
    rows.push(penaltyRow);
  }
  if (lastErrorText) {
    const row = element("tr", "", "metric error");
    row.append(
      element("th", text.metrics.error, "metric-label"),
      metricValue("siren", lastErrorText),
      element("td", "", "metric-trend"),
    );
    rows.push(row);
  }
  if (!rows.length) {
    statusMetrics.replaceChildren();
    statusMetrics.hidden = true;
    return;
  }
  const table = element("table", "", "metrics-table");
  const tbody = element("tbody");
  tbody.append(...rows);
  table.append(tbody);
  statusMetrics.replaceChildren(table);
  statusMetrics.hidden = false;
}
async function pollTelemetry() {
  if (!id || mode !== "events") return;
  if (Date.now() - lastTelemetryAt < 1500) return;
  lastTelemetryAt = Date.now();
  try {
    const response = await fetch(
      `/api/runs/${encodeURIComponent(id)}/log?source=telemetry&offset=${telemetryOffset}`,
    );
    if (!response.ok) return;
    const log = await response.json();
    const bytes = Uint8Array.from(atob(log.data || ""), (c) => c.charCodeAt(0));
    const samples = parseTelemetryLines(new TextDecoder().decode(bytes));
    telemetryOffset = log.offset ?? telemetryOffset;
    if (!samples.length) return;
    const baseline = lastMarkerSample;
    telemetrySamples = telemetrySamples.concat(samples).slice(-120);
    const latest = telemetrySamples.at(-1);
    if (baseline && latest) {
      for (const marker of telemetryMarkers(baseline, latest)) renderEventMarker(marker);
    }
    lastMarkerSample = latest ?? lastMarkerSample;
    renderMetrics();
  } catch {
    /* telemetry is optional */
  }
}
function restorePreferences() {
  try {
    const stored = localStorage.getItem("autorio.filter");
    if (stored) filterMode = stored;
    const requested = params.get("filter");
    if (requested && FILTER_BUTTONS[requested]) filterMode = requested;
    const query = localStorage.getItem("autorio.search");
    if (query && transcriptSearch) {
      searchQuery = query.toLowerCase();
      transcriptSearch.value = query;
    }
    transcriptSearch?.addEventListener("input", () => {
      searchQuery = transcriptSearch.value.trim().toLowerCase();
      try {
        localStorage.setItem("autorio.search", transcriptSearch.value);
      } catch {
        /* localStorage may be unavailable */
      }
      applyFilters();
    });
    for (const [mode, button] of Object.entries(FILTER_BUTTONS)) {
      button?.addEventListener("click", () => setFilter(mode));
    }
    setFilter(filterMode);
  } catch {
    /* preferences are optional */
  }
}
restorePreferences();
try {
  const storedCollapse = localStorage.getItem(STATUS_COLLAPSED_KEY);
  const requestedStatus = params.get("status");
  setStatusCollapsed(
    requestedStatus === "collapsed"
      ? true
      : requestedStatus === "expanded"
        ? false
        : storedCollapse === null
          ? params.get("overlay") === "1"
          : storedCollapse === "1",
  );
} catch {
  setStatusCollapsed(params.get("overlay") === "1" || params.get("status") === "collapsed");
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
        if (statusResponse.ok) {
          hideConnectionNotice();
          renderStatus(await statusResponse.json());
        }
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
            setJumpLabel(`${strings().newEvents} ${unread} ↓`);
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
          setJumpLabel(`${strings().newEvents} ${unread} ↓`);
          jumpButton.hidden = false;
        }
      }
      if (mode === "events") {
        applyFilters();
        trimTranscript();
      }
      renderMetrics();
      void pollTelemetry();
      offset = log.offset;
    }
    document.title = "Autorio factory log";
  } catch {
    showConnectionNotice();
    document.title = "Autorio factory log";
  } finally {
    setTimeout(poll, 250);
  }
}
void poll();
