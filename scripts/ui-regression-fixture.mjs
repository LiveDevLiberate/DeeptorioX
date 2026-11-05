/**
 * Deterministic browser fixture for the recording UI regression check.
 *
 * The fixture loads the real public/recording.html + recording.js; the runner
 * serves mocked /api/runs responses. The small audit script publishes layout,
 * contrast, target-size, icon-size and dialog-focus measurements to
 * <html data-audit="<base64 JSON>"> so a headless --dump-dom run can assert them
 * without Playwright or a real manager/game.
 */

export const RUN_FIXTURE = {
  schema_version: 2,
  id: "fixture-run",
  name: "fixture run",
  state: "paused",
  agent: "dsh",
  model_label: "deepseek-official/deepseek-flash",
  language: "Chinese",
  output_format: "events",
  elapsed_seconds: 10574,
  max_seconds: 28800,
  context_tokens: 135000,
  context_limit: 300000,
  usage: { input_tokens: 654000, output_tokens: 101317 },
  state_updated_at: "2020-01-01T00:00:00.000Z",
  state_md: [
    "Scores: production 40, logistics 35, mining 60, research 25, defense 10, exploration 30",
    "Current: 修复动力/铁铜熔炼 (score 70)",
    "Done when: 锅炉自动进煤稳定、铁炉4个+铜炉2个满负荷、铁板产量≥1/s 且持续3分钟",
    "Next: 把锅炉与铁/铜炉的插入器旋转180°",
  ].join("\n"),
  latest: { current_research: "logistics", research_progress: 0.1 },
  milestones: {},
  created_at: "2020-01-01T00:00:00.000Z",
  hashes: { benchmark: "fixture", baseline_save: "fixture", client: "fixture" },
  automation: {
    score: 54,
    positive: 1925,
    penalty: 1871,
    state_penalty: 0,
    manual_mines: 1373,
    manual_crafts: 249,
    breakdown: { production: 1200, science: 400, power: 250, research: 50, rockets: 25 },
  },
  benchmark: {
    id: "fixture",
    title: "Fixture factory",
    task: "Keep the fixture deterministic.",
    map_gen: {
      seed: 424242,
      peaceful_mode: true,
      autoplace_controls: { "enemy-base": { frequency: 0, size: 0 } },
    },
    milestones: [],
  },
};

export const EVENT_LOG = [
  { type: "thread.started", thread_id: "fixture-thread" },
  { type: "item.completed", item: { id: "r1", type: "reasoning", text: "Build the factory log fixture." } },
  {
    type: "item.completed",
    item: {
      id: "c1",
      type: "command_execution",
      command: "python factorio.py observe-player",
      aggregated_output: "ok",
      exit_code: 0,
      status: "completed",
    },
  },
  {
    type: "item.completed",
    item: { id: "m1", type: "agent_message", text: "The factory log fixture is ready." },
  },
]
  .map((event) => JSON.stringify(event))
  .join("\n");

export const TELEMETRY_LOG = [
  {
    observed_at: "2026-11-04T00:00:00.000Z",
    production_per_game_minute: { "iron-ore": 24, "copper-ore": 12, coal: 8, "iron-plate": 6 },
    current_research: "logistics",
    research_progress: 0.1,
    power: { satisfaction: 1 },
  },
  {
    observed_at: "2026-11-04T00:01:00.000Z",
    production_per_game_minute: { "iron-ore": 26, "copper-ore": 12, coal: 9, "iron-plate": 7 },
    current_research: "logistics",
    research_progress: 0.2,
    power: { satisfaction: 1 },
  },
  {
    observed_at: "2026-11-04T00:02:00.000Z",
    production_per_game_minute: { "iron-ore": 30, "copper-ore": 12, coal: 9, "iron-plate": 8 },
    current_research: "logistics",
    research_progress: 0.3,
    power: { satisfaction: 1 },
  },
]
  .map((sample) => JSON.stringify(sample))
  .join("\n");

const FAIL_OVERRIDE = String.raw`
(() => {
  if (new URLSearchParams(location.search).get("fail") !== "1") return;
  const realFetch = window.fetch.bind(window);
  window.fetch = (input, init) => {
    const url = typeof input === "string" ? input : input.url;
    if (String(url).startsWith("/api/runs")) return Promise.reject(new Error("simulated offline"));
    return realFetch(input, init);
  };
})();
`;

const AUDIT_SCRIPT = String.raw`
(() => {
  const params = new URLSearchParams(location.search);
  const fail = params.get("fail") === "1";
  const wantDialog = params.get("dialog") === "1";
  if (params.get("noaudit") === "1") {
    window.addEventListener("load", () => setTimeout(() => document.activeElement?.blur?.(), 800));
    return;
  }
  const root = document.documentElement;
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const round = (n) => Math.round(n * 100) / 100;
  const parse = (value) => {
    const match = String(value).match(/rgba?\(([^)]+)\)/);
    if (!match) return null;
    const parts = match[1].split(",").map(Number);
    return { r: parts[0], g: parts[1], b: parts[2], a: parts.length > 3 ? parts[3] : 1 };
  };
  const lum = (color) => {
    const channels = [color.r, color.g, color.b].map((value) => {
      const c = value / 255;
      return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
  };
  const blend = (fg, bg) => ({
    r: fg.r * fg.a + bg.r * (1 - fg.a),
    g: fg.g * fg.a + bg.g * (1 - fg.a),
    b: fg.b * fg.a + bg.b * (1 - fg.a),
    a: 1,
  });
  const backgroundColor = (el) => {
    let node = el;
    let acc = null;
    while (node) {
      const bg = parse(getComputedStyle(node).backgroundColor);
      if (bg && bg.a > 0) {
        acc = acc ? blend(acc, bg) : bg;
        if (acc.a >= 0.999) return acc;
      }
      node = node.parentElement;
    }
    return acc || { r: 255, g: 255, b: 255, a: 1 };
  };
  const contrast = (el) => {
    const fg = parse(getComputedStyle(el).color);
    const bg = backgroundColor(el);
    if (!fg) return null;
    const fl = lum(fg);
    const bl = lum(bg);
    return round((Math.max(fl, bl) + 0.05) / (Math.min(fl, bl) + 0.05));
  };
  const rect = (el) => {
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: round(r.x), y: round(r.y), w: round(r.width), h: round(r.height), bottom: round(r.bottom) };
  };
  const measure = (selector) => {
    const el = document.querySelector(selector);
    if (!el) return null;
    return { rect: rect(el), contrast: contrast(el), text: (el.innerText || el.value || "").trim().slice(0, 80) };
  };
  const waitFor = async (predicate, timeout = 8000) => {
    const start = performance.now();
    while (performance.now() - start < timeout) {
      if (predicate()) return true;
      await sleep(100);
    }
    return false;
  };
  const styleProps = [
    "display",
    "position",
    "width",
    "minWidth",
    "maxWidth",
    "height",
    "whiteSpace",
    "overflowWrap",
    "textAlign",
    "order",
    "flex",
    "alignSelf",
    "justifySelf",
    "gridColumn",
    "gridRow",
    "overflow",
    "visibility",
    "fontStyle",
    "fontVariantNumeric",
    "backgroundColor",
    "backgroundImage",
    "color",
    "borderTopColor",
    "borderTopWidth",
    "borderBottomColor",
    "borderBottomWidth",
    "borderLeftColor",
    "borderLeftWidth",
    "borderRadius",
    "padding",
    "margin",
    "fontFamily",
    "fontSize",
    "fontWeight",
    "lineHeight",
    "letterSpacing",
    "textTransform",
    "boxShadow",
    "opacity",
    "gap",
    "gridTemplateColumns",
    "alignItems",
    "justifyContent",
    "flexWrap",
  ];
  const styleSnapshot = (selectors) => {
    const out = {};
    for (const selector of selectors) {
      const el = document.querySelector(selector);
      if (!el) {
        out[selector] = null;
        continue;
      }
      const computed = getComputedStyle(el);
      out[selector] = Object.fromEntries(styleProps.map((prop) => [prop, computed[prop]]));
    }
    return out;
  };
  const mainStyleSelectors = [
    "body",
    "#agentStatus",
    ".status-plan",
    ".status-telemetry",
    ".section-kicker",
    "#statusCurrent",
    "#statusCurrent .icon",
    "#statusDone",
    "#statusMeta",
    ".status-readout",
    ".status-data",
    ".status-line",
    ".status-metrics",
    ".metric",
    ".metric-spark",
    ".metric-bar",
    ".status-scores",
    ".metrics-table",
    ".metrics-table tr",
    ".metrics-table .metric-value",
    "#statusScores",
    "#statusScores .score-radar",
    "#transcriptTools",
    "#transcriptTools .filter-group",
    "#transcriptTools .chip.active",
    "#transcriptTools .search-field",
    "#codexOutput",
    "#codexOutput .reasoning",
    "#codexOutput .reasoning-summary",
    "#codexOutput .commands",
    "#codexOutput .commands-summary",
    "#codexOutput .action-badge",
    "#codexOutput .message",
    "#codexOutput .msg-time",
    ".jump-latest",
  ];
  const stateStyleSelectors = [
    "#agentStatus",
    ".status-plan",
    ".status-telemetry",
    ".section-kicker",
    "#statusCurrent",
    "#statusMeta",
    ".status-tools",
    "#transcriptTools",
    "#codexOutput",
    ".jump-latest",
  ];
  const dialogStyleSelectors = [
    ".map-info-overlay",
    ".map-info-dialog",
    ".map-info-head h2",
    ".map-info-close",
    ".map-info-seed",
    ".map-info-section-title",
    ".map-resource-table th",
  ];
  const noticeStyleSelectors = ["#connectionNotice", "#connectionNotice button"];
  const finish = (result) => {
    const json = JSON.stringify(result);
    root.dataset.audit = btoa(unescape(encodeURIComponent(json)));
  };
  const run = async () => {
    try {
      if (fail) {
        await waitFor(() => {
          const notice = document.getElementById("connectionNotice");
          return notice && !notice.hidden;
        }, 6000);
        await sleep(150);
        finish({
          mode: "error",
          theme: root.dataset.theme || "dark",
          viewportWidth: innerWidth,
          notice: measure("#connectionNotice"),
          noticeStyles: styleSnapshot(noticeStyleSelectors),
          alert: document.querySelector('[role="alert"]')?.innerText || "",
        });
        return;
      }

      const ready = await waitFor(
        () => document.querySelector("#statusMetrics .metrics-table") && document.querySelector("#statusScores .score-radar"),
        9000,
      );
      await sleep(1400);
      const metrics = document.querySelector(".metrics-table");
      const radar = document.querySelector(".score-radar");
      const icons = [...document.querySelectorAll(".icon")].filter((el) => el.getClientRects().length > 0);
      const sizes = {};
      for (const el of icons) {
        const width = Math.round(el.getBoundingClientRect().width);
        sizes[width] = (sizes[width] || 0) + 1;
      }
      const hero = document.querySelector("#statusCurrent .icon");
      const heroFont = parseFloat(getComputedStyle(document.querySelector("#statusCurrent")).fontSize);
      const heroSize = hero ? hero.getBoundingClientRect().width : null;
      const selectors = {
        statusMeta: "#statusMeta",
        sectionKicker: ".section-kicker",
        hero: "#statusCurrent",
        done: "#statusDone",
        reasoning: "#codexOutput .reasoning-segment-text",
        command: "#codexOutput .command",
      };
      const contrastResults = {};
      for (const [key, selector] of Object.entries(selectors)) {
        const el = document.querySelector(selector);
        if (el && el.getClientRects().length) contrastResults[key] = contrast(el);
      }
      const targets = {};
      for (const selector of ["#statusToggle", "#mapInfoToggle", "#themeToggle", "#filterAll", ".search-field"]) {
        const el = document.querySelector(selector);
        if (el) {
          const r = el.getBoundingClientRect();
          targets[selector] = { w: round(r.width), h: round(r.height) };
        }
      }
      const visualStyles = styleSnapshot(mainStyleSelectors);
      const statusHeader = document.getElementById("agentStatus");
      statusHeader.classList.add("collapsed");
      const collapsedStyles = styleSnapshot(stateStyleSelectors);
      statusHeader.classList.remove("collapsed");
      document.body.classList.add("overlay");
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      const overlayStyles = styleSnapshot(stateStyleSelectors);
      document.body.classList.remove("overlay");
      const overflow = [...document.querySelectorAll("body *")]
        .filter((el) => {
          const style = getComputedStyle(el);
          if (style.display === "none" || style.visibility === "hidden") return false;
          const r = el.getBoundingClientRect();
          return el.getRootNode() === document && (r.right > innerWidth + 1 || r.left < -1 || r.width > innerWidth + 1);
        })
        .slice(0, 10)
        .map((el) => ({ tag: el.tagName, id: el.id, cls: String(el.className).slice(0, 60) }));

      const map = document.getElementById("mapInfoToggle");
      const overlay = document.getElementById("mapInfoOverlay");
      const header = document.getElementById("agentStatus");
      map.click();
      await sleep(250);
      const dialog = document.getElementById("mapInfoDialog");
      const close = document.getElementById("mapInfoClose");
      const opened = !overlay.hidden;
      const focusedClose = document.activeElement === close;
      const dialogStyles = styleSnapshot(dialogStyleSelectors);
      const focusables = [...dialog.querySelectorAll('button, [href], input, select, textarea, summary, [tabindex]:not([tabindex="-1"])')].filter(
        (el) => !el.disabled && el.getClientRects().length > 0,
      );
      const first = focusables[0];
      const last = focusables[focusables.length - 1];
      const backgroundInert = Boolean(header && (header.inert || header.getAttribute("aria-hidden") === "true"));
      last.focus();
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", code: "Tab", keyCode: 9, bubbles: true }));
      const wrapForward = document.activeElement === first;
      first.focus();
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", code: "Tab", keyCode: 9, shiftKey: true, bubbles: true }));
      const wrapBackward = document.activeElement === last;
      const mapNoteContrast = contrast(document.querySelector(".map-info-note") || dialog);
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", code: "Escape", keyCode: 27, bubbles: true }));
      await sleep(150);
      const closed = overlay.hidden;
      const focusReturned = document.activeElement === map;
      if (wantDialog) {
        map.click();
        await sleep(220);
      }

      finish({
        mode: "normal",
        theme: root.dataset.theme || "",
        viewportWidth: innerWidth,
        ready,
        overflow,
        geometry: {
          metrics: rect(metrics),
          radar: rect(radar),
          data: rect(document.querySelector(".status-data")),
        },
        contrast: contrastResults,
        mapNoteContrast,
        targets,
        icons: {
          count: icons.length,
          sizes,
          heroSize: heroSize === null ? null : round(heroSize),
          heroFont: round(heroFont),
          allAriaHidden: icons.every((el) => el.getAttribute("aria-hidden") === "true"),
        },
        visualStyles,
        collapsedStyles,
        overlayStyles,
        dialogStyles,
        dialog: {
          opened,
          backgroundInert,
          focusedClose,
          wrapForward,
          wrapBackward,
          closed,
          focusReturned,
        },
      });
    } catch (error) {
      finish({ mode: "audit-error", error: String(error && error.stack ? error.stack : error) });
    }
  };
  window.addEventListener("load", () => setTimeout(run, 700));
})();
`;

export function buildFixtureHtml(recordingHtml) {
  const moduleTag = '<script type="module" src="/recording.js"></script>';
  return recordingHtml.replace(
    moduleTag,
    `<script>${FAIL_OVERRIDE}</script>\n${moduleTag}\n<script>${AUDIT_SCRIPT}</script>`,
  );
}
