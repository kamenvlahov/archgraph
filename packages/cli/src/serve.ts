import { readFileSync, existsSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { basename, extname, join, normalize } from 'node:path';
import { GraphQuery, processView, roleOf, scan, type ScanOptions } from '@archgraph/engine';
import type { Node } from '@archgraph/model';
import { plan } from '@archgraph/planner';

// `archgraph serve`: интерфейсът (packages/ui/dist) и API-то му върху един сканиран проект.
// Слуша само на 127.0.0.1: графът съдържа кода на проекта и не е за мрежата.

const DIST = join(import.meta.dirname, '../../ui/dist');
const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.svg': 'image/svg+xml',
};

export interface Entry {
  id: string;
  label: string;
  role: string;
  file: string;
  line: number;
}

export async function serve(path: string, port: number, options: ScanOptions): Promise<Server> {
  const { graph } = await scan(path, options);
  const query = new GraphQuery(graph);
  // Входни точки: route-овете, а без тях controller-ите и handler-ите (временните роли по име).
  const routes = graph.nodes.filter((n) => n.kind === 'route');
  const entryNodes = routes.length
    ? routes
    : graph.nodes.filter((n) => roleOf(n, graph.types[n.id] !== undefined) === 'controller');
  const entries: Entry[] = entryNodes
    .map((n) => ({
      id: n.id,
      label: n.name,
      role: n.kind === 'route' ? 'route' : 'controller',
      file: n.location.file,
      line: n.location.line,
    }))
    .sort((a, b) => a.label.localeCompare(b.label));

  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const json = (status: number, body: unknown) => {
      res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(body));
    };
    if (url.pathname === '/api/project') return json(200, { name: basename(graph.root), root: graph.root, entries });
    if (url.pathname === '/api/process') {
      const found = query.find(url.searchParams.get('target') ?? '');
      const [target] = found;
      if (found.length !== 1 || !target)
        return json(404, { error: `няма един нод „${url.searchParams.get('target')}“ (${found.length})` });
      const depth = Math.min(12, Math.max(1, Number(url.searchParams.get('depth') ?? 6)));
      return json(200, processView(query, target, depth));
    }
    if (url.pathname === '/api/search') return json(200, search(graph.nodes, url.searchParams.get('q') ?? ''));
    if (url.pathname === '/api/plan') {
      const targets = url.searchParams.getAll('target').flatMap((t) => query.find(t).slice(0, 1));
      res.writeHead(200, { 'content-type': 'text/markdown; charset=utf-8' });
      return res.end(plan(query, url.searchParams.get('task') ?? '', targets));
    }
    const file = join(DIST, normalize(url.pathname === '/' ? '/index.html' : url.pathname));
    if (!file.startsWith(DIST) || !existsSync(file)) return json(404, { error: 'няма такъв файл' });
    res.writeHead(200, { 'content-type': TYPES[extname(file)] ?? 'application/octet-stream' });
    res.end(readFileSync(file));
  });
  await new Promise<void>((resolve) => server.listen(port, '127.0.0.1', resolve));
  return server;
}

// Класове, функции и методи по име: начало на процес, когато няма ендпойнт (или не е намерен).
// Първо точните, после започващите със заявката, после съдържащите я.
function search(nodes: Node[], q: string): Entry[] {
  const text = q.trim().toLowerCase();
  if (text.length < 2) return [];
  const rank = (name: string) => {
    const n = name.toLowerCase();
    return n === text ? 0 : n.startsWith(text) ? 1 : n.includes(text) ? 2 : -1;
  };
  const found: [number, Entry][] = [];
  for (const n of nodes) {
    if (n.kind === 'route') continue;
    const role = roleOf(n, false);
    const r = rank(n.name);
    if (r >= 0) found.push([r, { id: n.id, label: n.name, role, file: n.location.file, line: n.location.line }]);
    if (n.kind === 'function') continue;
    for (const m of n.members) {
      const rm = rank(m.name);
      if (rm >= 0)
        found.push([
          rm + 0.5,
          { id: `${n.id}#${m.name}`, label: `${n.name}#${m.name}`, role, file: m.location.file, line: m.location.line },
        ]);
    }
  }
  return found
    .sort((a, b) => a[0] - b[0] || a[1].label.localeCompare(b[1].label))
    .slice(0, 40)
    .map(([, e]) => e);
}
