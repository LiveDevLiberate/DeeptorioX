import fs from "node:fs/promises";
import path from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";

/** Static asset root: the repository's `public/` directory. */
export type StaticOptions = { publicDir: string };

/** How a request pathname maps onto the static tree. */
export type StaticTarget =
  { kind: "redirect"; location: string } | { kind: "file"; filePath: string } | { kind: "forbidden" };

/** Content type for a static asset path (legacy manager mapping). */
export function contentType(filePath: string): string {
  if (filePath.endsWith(".html")) return "text/html; charset=utf-8";
  if (filePath.endsWith(".js")) return "application/javascript; charset=utf-8";
  if (filePath.endsWith(".css")) return "text/css; charset=utf-8";
  if (filePath.endsWith(".json")) return "application/json; charset=utf-8";
  if (filePath.endsWith(".png")) return "image/png";
  if (filePath.endsWith(".svg")) return "image/svg+xml";
  return "application/octet-stream";
}

/** `/runs.html` is a legacy alias: redirect to the run or recording page. */
export function staticRedirect(pathname: string, searchParams: URLSearchParams): string | null {
  if (pathname !== "/runs.html") return null;
  const id = searchParams.get("run");
  const target = searchParams.get("recording") === "1" ? "/recording.html" : id ? "/run.html" : "/";
  return target + (id ? `?run=${encodeURIComponent(id)}` : "");
}

/**
 * Maps a pathname onto a file under `publicDir`, or forbids paths that escape
 * it. `/` serves `index.html`, matching the legacy handler.
 */
export function resolveStaticTarget(publicDir: string, pathname: string): StaticTarget {
  const normalized = pathname === "/" ? "/index.html" : pathname;
  const relPath = normalized.replace(/^\/+/, "");
  const filePath = path.join(publicDir, relPath);
  if (!filePath.startsWith(publicDir)) return { kind: "forbidden" };
  return { kind: "file", filePath };
}

/** Serves the manager's static UI assets (redirects, no-store caching, 403/404). */
export async function handleStatic(
  req: IncomingMessage,
  res: ServerResponse,
  options: StaticOptions,
): Promise<void> {
  const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
  const redirect = staticRedirect(url.pathname, url.searchParams);
  if (redirect) {
    res.writeHead(302, { Location: redirect });
    res.end();
    return;
  }
  const target = resolveStaticTarget(options.publicDir, url.pathname);
  if (target.kind === "forbidden") {
    res.writeHead(403);
    res.end();
    return;
  }
  if (target.kind !== "file") {
    res.writeHead(404);
    res.end("Not found");
    return;
  }
  try {
    const data = await fs.readFile(target.filePath);
    res.writeHead(200, { "Content-Type": contentType(target.filePath), "Cache-Control": "no-store" });
    res.end(data);
  } catch {
    res.writeHead(404);
    res.end("Not found");
  }
}
