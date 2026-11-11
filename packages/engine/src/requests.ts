import { edge, type Edge, type Node, type OutboundRequest, type PathCall } from '@archgraph/model';

// HTTP заявките в кода (етап 12) от извикванията с низ като път, които дават адаптерите.
// Заявка е, ако извиканото е HTTP глагол (`http.get`, `client.post`), или сред низовете има глагол
// (`_call(settings, "GET", "/api/portal/tickets")`), или е `request`/`fetch` без видим глагол.

const VERBS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'];
const GENERIC = new Set(['request', 'fetch', 'send', 'call']);

export function requests(paths: PathCall[], nodes: Node[]): { requests: OutboundRequest[]; edges: Edge[] } {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const routes = nodes.filter((n) => n.kind === 'route');
  // регистрацията на route е извикване с път (`app.get('/x', h)` в функция), но не е заявка
  const registered = new Set(routes.map((r) => `${r.location.file}:${r.location.line}`));
  const found: OutboundRequest[] = [];
  const edges: Edge[] = [];
  for (const p of paths) {
    const file = byId.get(p.from.node)?.location.file;
    if (file && registered.has(`${file}:${p.line}`)) continue;
    const method = verb(p);
    const raw = p.strings.find((s) => /^(\/|https?:\/\/)/.test(s));
    if (!method || !raw) continue;
    const path = pathOf(raw);
    // `/api${path}` в помощна функция не казва нищо: трябва поне един буквален сегмент
    if (!segments(path).some((s) => s !== '{}')) continue;
    const route = bestRoute(method, path, routes);
    found.push({ from: p.from, method, path, line: p.line, ...(route ? { to: route.id } : {}) });
    if (route) edges.push(edge('requests', p.from, { node: route.id }, 'inferred'));
  }
  // едно ребро за извикващия и route-а, колкото и пъти да го вика
  return { requests: found, edges: [...new Map(edges.map((e) => [e.id, e])).values()] };
}

// най-точният route: `/albums/search` е преди `/albums/{id}`
export function bestRoute(method: string, path: string, routes: Node[]): Node | undefined {
  return routes
    .map((r) => ({ r, score: score(method, path, r.name) }))
    .filter((x) => x.score >= 0)
    .sort((a, b) => b.score - a.score)[0]?.r;
}

function verb(p: PathCall): string | undefined {
  const name = p.name.toUpperCase();
  if (VERBS.includes(name)) return name;
  const named = p.strings.find((s) => VERBS.includes(s.toUpperCase()));
  if (named) return named.toUpperCase();
  return GENERIC.has(p.name.toLowerCase()) ? '*' : undefined;
}

// `https://host/api/x?y=1` → /api/x; заявката и route-ът се сравняват без query и крайна наклонена
function pathOf(s: string): string {
  const path = s.replace(/^https?:\/\/[^/]+/, '').split(/[?#]/)[0] ?? '';
  return path.replace(/\/$/, '') || '/';
}

// `GET /albums/{id:\d+}`, `/tickets/:id`, `/tickets/{ticket_id}`: параметърът съвпада със всеки сегмент,
// а с регулярен израз (`{id:\d+}`) само с този, който му отговаря. Резултатът е броят буквално
// съвпаднали сегменти, или -1.
function score(method: string, path: string, route: string): number {
  const [routeMethod = '', routePath = ''] = route.split(' ');
  if (method !== '*' && routeMethod !== method) return -1;
  const a = segments(path);
  const b = pathOf(routePath).split('/').filter(Boolean);
  if (a.length !== b.length) return -1;
  let exact = 0;
  for (const [i, s] of a.entries()) {
    const r = b[i] ?? '';
    const param = /^\{(\w*)(?::(.+))?\}$/.exec(r) ?? (/^:\w+$/.test(r) ? [r] : null);
    if (param) {
      if (s !== '{}' && param[2] && !new RegExp(`^(?:${param[2]})$`).test(s)) return -1;
    } else if (s === '{}') continue;
    else if (s === r) exact++;
    else return -1;
  }
  return exact;
}

function segments(path: string): string[] {
  return path
    .split('/')
    .filter(Boolean)
    .map((s) => (s.includes('{}') ? '{}' : s));
}
