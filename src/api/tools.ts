import fs from "node:fs";
import path from "node:path";
import { Router } from "../http/router.js";
import { json } from "../http/plumbing.js";
import { ROOT } from "../runtime.js";

const MANIFEST_PATH = path.join(ROOT, "public", "tool-manifest.json");

/**
 * `GET /api/agent/tools` — the generated discovery manifest for the agent.
 * The file is generated from factorio.py and src/api/agent.ts by
 * `npm run tools:manifest`; tests keep it fresh when those sources change.
 */
export function registerToolsRoutes(router: Router): void {
  router.add({
    method: "GET",
    path: "/api/agent/tools",
    name: "/api/agent/tools",
    handler: (request) => {
      const { res, url } = request;
      try {
        const manifest = JSON.parse(fs.readFileSync(MANIFEST_PATH, "utf8")) as {
          cli_commands?: unknown[];
          client_methods?: unknown[];
          manager_endpoints?: unknown[];
          [key: string]: unknown;
        };
        const query = (url.searchParams.get("q") || "").trim().toLowerCase();
        if (!query) return json(res, 200, { ok: true, data: manifest });
        // Treat hyphens/underscores as spaces so `build-mining-outpost` also
        // matches the Python method `build_mining_outpost`.
        const normalize = (text: string) => text.toLowerCase().replace(/[-_]+/g, " ");
        const needle = normalize(query);
        const matches = (item: unknown) => normalize(JSON.stringify(item)).includes(needle);
        const data = {
          ...manifest,
          query,
          cli_commands: (manifest.cli_commands || []).filter(matches),
          client_methods: (manifest.client_methods || []).filter(matches),
          manager_endpoints: (manifest.manager_endpoints || []).filter(matches),
        };
        return json(res, 200, { ok: true, data });
      } catch (error) {
        return json(res, 503, {
          error: "Tool manifest unavailable; run `npm run tools:manifest`",
          detail: error instanceof Error ? error.message : String(error),
        });
      }
    },
  });
}
