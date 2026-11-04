import type { IncomingMessage, ServerResponse } from "node:http";

/** Parameters captured from a regex route (capture groups in order). */
export type RouteParams = Record<string, string>;

/** Request view passed to every route handler. */
export type RoutedRequest = {
  req: IncomingMessage;
  res: ServerResponse;
  url: URL;
  params: RouteParams;
};

/**
 * Route handler. Returning `false` means "the path matched but this handler
 * does not handle this method/variant, keep matching later routes" (the legacy
 * if-chain fall-through behavior); any other return value counts as handled.
 */
export type RouteHandler = (request: RoutedRequest) => unknown;

export type Route = {
  /** HTTP method (or methods) to match; omitted matches every method. */
  method?: string | string[];
  /** Exact pathname, or a regular expression whose capture groups become params. */
  path: string | RegExp;
  /** Optional names for regex capture groups (diagnostics/tests). */
  params?: string[];
  handler: RouteHandler;
  /** Optional diagnostic label. */
  name?: string;
};

export type MatchedRoute = { route: Route; params: RouteParams };

function methodMatches(route: Route, method: string): boolean {
  if (!route.method) return true;
  return Array.isArray(route.method) ? route.method.includes(method) : route.method === method;
}

/** Matches one route against a method/pathname pair; returns captured params or undefined. */
export function matchRoute(route: Route, method: string, pathname: string): RouteParams | undefined {
  if (!methodMatches(route, method)) return undefined;
  if (typeof route.path === "string") return route.path === pathname ? {} : undefined;
  const match = route.path.exec(pathname);
  if (!match) return undefined;
  const params: RouteParams = {};
  const names = route.params ?? [];
  match.slice(1).forEach((value, index) => {
    if (value === undefined) return;
    params[names[index] ?? String(index)] = value;
  });
  return params;
}

/**
 * Ordered route table. Matching is first-registered-wins, which preserves the
 * manager's historical precedence; `handleApi` registers the same order the
 * legacy if-chain checked it in.
 */
export class Router {
  private readonly entries: Route[] = [];

  add(route: Route): this {
    this.entries.push(route);
    return this;
  }

  /** Registered routes in precedence order (diagnostics/tests). */
  list(): readonly Route[] {
    return this.entries;
  }

  /** First route matching the method/pathname, or undefined. */
  match(method: string, pathname: string): MatchedRoute | undefined {
    for (const route of this.entries) {
      const params = matchRoute(route, method, pathname);
      if (params) return { route, params };
    }
    return undefined;
  }

  /**
   * Parses the request URL and runs the first matching route. Returns true when
   * a route produced a response, false when the request fell through entirely
   * (the caller sends the API's final 404).
   */
  async dispatch(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
    const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
    const method = req.method || "GET";
    for (const route of this.entries) {
      const params = matchRoute(route, method, url.pathname);
      if (!params) continue;
      const handled = await route.handler({ req, res, url, params });
      if (handled !== false) return true;
    }
    return false;
  }
}
