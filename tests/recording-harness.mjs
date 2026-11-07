// Shared fake DOM and API fixtures for the recording renderer tests.
export class FakeNode {
  constructor(tag = "div") {
    this.tagName = tag;
    this.children = [];
    this.textContent = "";
    this.className = "";
    this.hidden = false;
    this.open = false;
    this.style = {};
    this.listeners = new Map();
    this._classList = new Set();
    this.scrollHeight = 0;
    this.scrollTop = 0;
    this.clientHeight = 0;
  }
  get classList() {
    return {
      add: (...names) => names.forEach((name) => this._classList.add(name)),
      remove: (...names) => names.forEach((name) => this._classList.delete(name)),
      contains: (name) => this._classList.has(name),
      toggle: (name, force) => {
        const value = force === undefined ? !this._classList.has(name) : Boolean(force);
        if (value) this._classList.add(name);
        else this._classList.delete(name);
        return value;
      },
    };
  }
  set className(value) {
    this._classList = new Set(
      String(value || "")
        .split(/\s+/)
        .filter(Boolean),
    );
  }
  get className() {
    return [...this._classList].join(" ");
  }
  append(...nodes) {
    for (const node of nodes) this.children.push(node);
  }
  replaceChildren(...nodes) {
    this.children = [...nodes];
  }
  addEventListener(type, listener) {
    this.listeners.set(type, listener);
  }
  setAttribute() {}
  fire(type) {
    this.listeners.get(type)?.();
  }
}

export function base64(text) {
  return Buffer.from(text, "utf8").toString("base64");
}

export function jsonl(items) {
  return items.map((item) => JSON.stringify(item)).join("\n") + "\n";
}

export const PAGE_ELEMENT_IDS = [
  "agentStatus",
  "statusState",
  "statusActivity",
  "statusMeta",
  "statusCurrent",
  "statusDone",
  "statusScores",
  "statusMetrics",
  "statusToggle",
  "stateTimer",
  "transcriptSearch",
  "filterAll",
  "filterThinking",
  "filterActions",
  "filterTech",
  "filterErrors",
  "filterDecisions",
  "codexOutput",
];
