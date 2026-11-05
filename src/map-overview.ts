/** Render a map-overview response (or its `data`) as a dependency-free SVG. */

const COLORS: Record<string, string> = {
  "?": "#111a1e",
  "~": "#2e698a",
  ".": "#354a3b",
  "#": "#c7a35a",
  "*": "#d6b54b",
  "@": "#e8664f",
};

type Overview = {
  rows?: unknown;
  width?: unknown;
  height?: unknown;
  step?: unknown;
  min_x?: unknown;
  min_y?: unknown;
  charted_samples?: unknown;
  samples?: unknown;
};

/** Convert ASCII rows to compact same-color run rectangles. */
export function mapOverviewSvg(input: Overview): string {
  const rows = Array.isArray(input.rows) ? input.rows.map((row) => String(row)) : [];
  const width = Math.max(0, Number(input.width) || Math.max(0, ...rows.map((row) => row.length)));
  const height = Math.max(0, Number(input.height) || rows.length);
  const parts = [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${Math.max(1, width)} ${Math.max(1, height)}" role="img" aria-label="Charted map overview" shape-rendering="crispEdges">`,
    `<rect x="0" y="0" width="${Math.max(1, width)}" height="${Math.max(1, height)}" fill="${COLORS["?"]}"/>`,
  ];
  rows.slice(0, height).forEach((row, y) => {
    let start = 0;
    for (let x = 1; x <= row.length; x += 1) {
      if (x < row.length && row[x] === row[start]) continue;
      const glyph = row[start];
      const fill = COLORS[glyph];
      if (fill && glyph !== "?") {
        parts.push(`<rect x="${start}" y="${y}" width="${x - start}" height="1" fill="${fill}"/>`);
      }
      start = x;
    }
  });
  parts.push("</svg>");
  return parts.join("");
}
