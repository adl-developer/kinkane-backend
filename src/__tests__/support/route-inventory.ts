/**
 * The list of endpoints, read off the Express router itself.
 *
 * Deliberately not a hand-maintained list and not a grep over route files: both
 * drift, and a drifted inventory is worse than none — it reports full coverage
 * of a surface it is no longer describing. Walking the live router means a route
 * added tomorrow is tested tomorrow, and one deleted stops being asserted.
 */
export interface RouteRef {
  method: string;
  path: string;
}

/** Recovers the mount prefix from a router layer's regexp. */
function mountPath(re: unknown): string {
  const layer = re as { fast_slash?: boolean; toString(): string } | undefined;
  if (!layer || layer.fast_slash) return '';
  const match = layer.toString().match(/^\/\^\\?(.*?)\\\/\?\(\?=\\\/\|\$\)\/i?$/);
  const raw = match ? match[1] : layer.toString();
  return raw.replace(/\\\//g, '/').replace(/\\\./g, '.');
}

export function listRoutes(app: unknown): RouteRef[] {
  const found: RouteRef[] = [];

  const walk = (stack: unknown[], prefix: string): void => {
    for (const entry of stack) {
      const layer = entry as {
        route?: { path: string; methods: Record<string, boolean> };
        name?: string;
        handle?: { stack?: unknown[] };
        regexp?: unknown;
      };

      if (layer.route) {
        for (const [method, enabled] of Object.entries(layer.route.methods)) {
          if (enabled) found.push({ method: method.toUpperCase(), path: prefix + layer.route.path });
        }
      } else if (layer.name === 'router' && layer.handle?.stack) {
        walk(layer.handle.stack, prefix + mountPath(layer.regexp));
      }
    }
  };

  const root = app as { _router?: { stack: unknown[] }; router?: { stack: unknown[] } };
  walk(root._router?.stack ?? root.router?.stack ?? [], '');

  // A route registered twice is a real bug (the second is unreachable), so
  // collapse rather than hide it — the count assertion in the suite would
  // otherwise drift quietly.
  const seen = new Set<string>();
  return found.filter((r) => {
    const key = `${r.method} ${r.path}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** Routes carrying at least one `:param` segment. */
export function hasParams(path: string): boolean {
  return path.includes(':');
}
