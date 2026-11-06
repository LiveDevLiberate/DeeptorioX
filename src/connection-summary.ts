/**
 * Human/agent-friendly summary for `observe-connections`.
 *
 * The raw audit is a long list of belts and issues, which is hard to read in a
 * complex base. This adds grouped counts, fix hints, junction samples and a
 * compact arrow grid (one character per belt/junction) while preserving the
 * original rows for callers that need exact coordinates.
 */

type JsonRecord = Record<string, unknown>;

const BELT_DIRECTION_GLYPH: Record<number, string> = { 0: "^", 4: ">", 8: "v", 12: "<" };
const LINK_GLYPH: Record<string, string> = {
  straight: "",
  side_load: "+",
  head_on: "X",
  non_belt: "N",
  dead_end: "!",
};

const ISSUE_GLYPH: Record<string, string> = {
  belt_head_on: "X",
  belt_opposite: "X",
  belt_points_to_non_belt: "N",
  belt_dead_end: "!",
  belt_no_input: "?",
  inserter_no_source: "i",
  inserter_no_target: "i",
  inserter_invalid_source: "i",
  inserter_invalid_target: "i",
  machine_no_inserters: "m",
};

const ISSUE_SUGGESTION: Record<string, string> = {
  belt_dead_end: "Extend the belt, rotate the corner, or remove the dead end.",
  belt_head_on: "Rotate one belt or use a splitter/underground crossing instead of head-on tiles.",
  belt_opposite: "Rotate one belt or use a splitter/underground crossing instead of head-on tiles.",
  belt_no_input: "Connect a feeder/side-load or remove the orphan belt.",
  belt_points_to_non_belt: "Use an inserter between the belt and the machine/chest.",
  inserter_no_source: "Add a source tile/chest/belt behind the inserter.",
  inserter_no_target: "Add a destination tile/machine in front of the inserter.",
  inserter_invalid_source: "An inserter cannot pick from this entity type; change the source.",
  inserter_invalid_target: "An inserter cannot drop into this entity type; change the target.",
  machine_no_inserters: "Add input/output inserters for this machine.",
};

function asRecord(value: unknown): JsonRecord | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as JsonRecord) : undefined;
}

function floor(value: unknown): number | null {
  const number = Number(value);
  return Number.isFinite(number) ? Math.floor(number) : null;
}

export function summarizeConnectionsData(value: unknown): unknown {
  const data = asRecord(value);
  if (!data) return value;
  const belts = Array.isArray(data.belts) ? data.belts : [];
  const issues = Array.isArray(data.issues) ? data.issues : [];
  const window = asRecord(data.window) ?? {};
  const minX = Number.isFinite(Number(window.x)) ? Math.floor(Number(window.x)) : 0;
  const minY = Number.isFinite(Number(window.y)) ? Math.floor(Number(window.y)) : 0;
  const radius = Math.max(1, Math.floor(Number(window.radius) || 120));
  const step = Math.max(1, Math.ceil((radius * 2 + 1) / 80));
  const width = Math.floor((radius * 2) / step) + 1;
  const rows = Array.from({ length: width }, () => Array.from({ length: width }, () => " "));

  const byKind = new Map<string, { count: number; examples: JsonRecord[] }>();
  for (const raw of issues) {
    const issue = asRecord(raw);
    if (!issue) continue;
    const kind = typeof issue.kind === "string" ? issue.kind : "unknown";
    const entry = byKind.get(kind) ?? { count: 0, examples: [] };
    entry.count++;
    if (entry.examples.length < 3) entry.examples.push(issue);
    byKind.set(kind, entry);
  }

  const issueAt = new Map<string, string>();
  for (const raw of issues) {
    const issue = asRecord(raw);
    const x = floor(issue?.x ?? (asRecord(issue?.position) ?? {}).x);
    const y = floor(issue?.y ?? (asRecord(issue?.position) ?? {}).y);
    if (x === null || y === null) continue;
    issueAt.set(`${x},${y}`, ISSUE_GLYPH[String(issue?.kind)] ?? "?");
  }

  const cell = (x: number, y: number, glyph: string) => {
    const col = Math.floor((x - minX) / step);
    const row = Math.floor((y - minY) / step);
    if (row >= 0 && row < width && col >= 0 && col < width) rows[row][col] = glyph;
  };

  const linkCounts: Record<string, number> = {};
  const junctions: JsonRecord[] = [];
  let parallel = 0;
  for (const raw of belts) {
    const belt = asRecord(raw);
    if (!belt) continue;
    const x = floor(belt.x);
    const y = floor(belt.y);
    if (x === null || y === null) continue;
    const direction = Number(belt.direction) || 0;
    const link = typeof belt.next_connection === "string" ? belt.next_connection : "dead_end";
    linkCounts[link] = (linkCounts[link] ?? 0) + 1;
    const parallelCount = Number(belt.parallel_belts) || 0;
    if (parallelCount > 0) parallel++;
    const issueGlyph = issueAt.get(`${x},${y}`);
    const glyph = issueGlyph ?? (LINK_GLYPH[link] || BELT_DIRECTION_GLYPH[direction] || "b");
    cell(x, y, glyph);
    if (link !== "straight" || parallelCount > 0) {
      junctions.push({
        x,
        y,
        direction,
        link,
        parallel_belts: parallelCount,
        ...(issueGlyph ? { issue: issueGlyph } : {}),
      });
    }
  }

  const grouped = [...byKind.entries()]
    .map(([kind, entry]) => ({
      kind,
      count: entry.count,
      suggestion: ISSUE_SUGGESTION[kind] ?? "Inspect the listed coordinates and repair the connection.",
      examples: entry.examples,
    }))
    .sort((a, b) => b.count - a.count || a.kind.localeCompare(b.kind));

  return {
    ...data,
    issue_summary: {
      total: issues.length,
      groups: grouped,
      suggestions: [...new Set(grouped.map((group) => group.suggestion))],
    },
    belt_links: linkCounts,
    junctions: junctions.slice(0, 40),
    parallel_belts: parallel,
    map: {
      window: { min_x: minX, min_y: minY, radius, step },
      rows: rows.map((row) => row.join("").replace(/\s+$/g, "")),
      legend: {
        "^>v<": "straight belt direction",
        "+": "side-load (one lane)",
        X: "head-on",
        N: "points to non-belt",
        "!": "dead end",
        "?": "no belt input",
        i: "inserter issue",
        m: "machine has no inserters",
        " ": "no belt",
      },
    },
  };
}
