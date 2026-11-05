import { deflateSync } from "node:zlib";

/** Render a map-overview response (or its `data`) as a dependency-free SVG. */

const RGB: Record<string, [number, number, number]> = {
  "?": [17, 26, 30],
  "~": [46, 105, 138],
  ".": [53, 74, 59],
  "#": [199, 163, 90],
  "*": [214, 181, 75],
  "@": [232, 102, 79],
};
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

function crc32(buffer: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Buffer): Buffer {
  const name = Buffer.from(type, "ascii");
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([name, data])), 0);
  return Buffer.concat([length, name, data, crc]);
}

/** Render the overview as an upscaled RGB PNG (no image dependency). */
export function mapOverviewPng(input: Overview, scale = 4): Buffer {
  const rows = Array.isArray(input.rows) ? input.rows.map((row) => String(row)) : [];
  const width = Math.max(1, rows[0]?.length || Number(input.width) || 1);
  const height = Math.max(1, rows.length || Number(input.height) || 1);
  const factor = Math.max(1, Math.min(16, Math.trunc(scale)));
  const pngWidth = width * factor;
  const pngHeight = height * factor;
  const pixels = Buffer.alloc(pngWidth * pngHeight * 3);
  for (let y = 0; y < pngHeight; y += 1) {
    for (let x = 0; x < pngWidth; x += 1) {
      const source = rows[Math.floor(y / factor)]?.[Math.floor(x / factor)] || "?";
      const [r, g, b] = RGB[source] || [66, 82, 90];
      const offset = (y * pngWidth + x) * 3;
      pixels[offset] = r;
      pixels[offset + 1] = g;
      pixels[offset + 2] = b;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(pngWidth, 0);
  ihdr.writeUInt32BE(pngHeight, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // RGB
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;
  const scanlines: Buffer[] = [];
  for (let y = 0; y < pngHeight; y += 1) {
    scanlines.push(Buffer.from([0]), pixels.subarray(y * pngWidth * 3, (y + 1) * pngWidth * 3));
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", deflateSync(Buffer.concat(scanlines))),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}
