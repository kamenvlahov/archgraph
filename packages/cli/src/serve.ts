import { existsSync, readFileSync, watch } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { basename, extname, join, normalize, relative, sep } from 'node:path';
import {
  DEFAULT_EXCLUDES,
  GraphQuery,
  layers,
  layerView,
  processView,
  Project,
  roleOf,
  type ScanOptions,
} from '@archgraph/engine';
import type { GraphModel, Node } from '@archgraph/model';
import { plan } from '@archgraph/planner';
import { CATALOG } from '@archgraph/rules';

// `archgraph serve`: интерфейсът (packages/ui/dist) и REST API-то му върху един проект.
// Слуша само на 127.0.0.1: графът съдържа кода на проекта и не е за мрежата.
//
//   GET  /api/project                  име, корен, файлове по език, framework-и
//   GET  /api/roles                    каталогът на ролите: слой и цвят
//   GET  /api/endpoints                входните точки: route-овете (без тях controller-ите)
//   GET  /api/layers                   слоевете с броя единици
//   GET  /api/layers/{name}            целият слой по модули, компактно
//   GET  /api/search?q=                класове, функции и методи по име
//   GET  /api/processes/{target}?depth процесът от ендпойнт, клас или метод (target е URL-encoded)
//   GET  /api/nodes?file=&line=        нодът и методът на това място (курсорът в редактора)
//   POST /api/plans  {task, targets}   Markdown план за AI
//   GET  /api/events                   Server-Sent Events: `changed`, когато файл се промени

const DIST = join(import.meta.dirname, '../../ui/dist');
const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.svg': 'image/svg+xml',
};
const DEBOUNCE = 120;

export interface Entry {
  id: string;
  label: string;
  role: string;
  file: string;
  line: number;
}

export async function serve(path: string, port: number, options: ScanOptions): Promise<Server> {
  const project = await Project.open(path, options);
  let query = new GraphQuery(project.graph);
  const listeners = new Set<ServerResponse>();

  // Наблюдател: промените се събират за DEBOUNCE ms, препрочитат се само те и клиентите научават.
  const pending = new Set<string>();
  let timer: NodeJS.Timeout | undefined;
  const watcher = watch(project.root, { recursive: true }, (_, name) => {
    const file = name?.toString().split(sep).join('/');
    if (!file || DEFAULT_EXCLUDES.some((x) => file.split('/').includes(x))) return;
    pending.add(file);
    clearTimeout(timer);
    timer = setTimeout(async () => {
      const files = [...pending];
      pending.clear();
      if (!(await project.update(files).catch(() => false))) return;
      query = new GraphQuery(project.graph);
      for (const res of listeners) res.write(`event: changed\ndata: ${JSON.stringify({ files })}\n\n`);
    }, DEBOUNCE);
  });

  const server = createServer((req, res) => {
    handle(req, res).catch((e: Error) => send(res, 500, { error: e.message }));
  });
  server.on('close', () => {
    watcher.close();
    clearTimeout(timer);
  });

  async function handle(req: IncomingMessage, res: ServerResponse) {
    const url = new URL(req.url ?? '/', 'http://localhost');
    // Панелът във VS Code е на произход vscode-webview://; на него (и само на него) API-то отговаря.
    const origin = req.headers.origin ?? '';
    if (origin.startsWith('vscode-webview://')) {
      res.setHeader('access-control-allow-origin', origin);
      res.setHeader('access-control-allow-headers', 'content-type');
    }
    if (req.method === 'OPTIONS') return res.writeHead(204).end();
    const route = `${req.method} ${url.pathname}`;
    const { graph } = project;
    if (route === 'GET /api/project')
      return send(res, 200, {
        name: basename(graph.root),
        root: graph.root,
        files: project.report.files,
        frameworks: project.report.frameworks,
        layers: project.report.layers,
      });
    if (route === 'GET /api/roles') return send(res, 200, CATALOG);
    if (route === 'GET /api/endpoints') return send(res, 200, endpoints(graph));
    if (route === 'GET /api/layers') return send(res, 200, layers(graph, project.report.layers));
    if (req.method === 'GET' && url.pathname.startsWith('/api/layers/'))
      return send(res, 200, layerView(graph, decodeURIComponent(url.pathname.slice('/api/layers/'.length))));
    if (route === 'GET /api/search') return send(res, 200, search(graph.nodes, url.searchParams.get('q') ?? ''));
    if (req.method === 'GET' && url.pathname.startsWith('/api/processes/')) {
      const name = decodeURIComponent(url.pathname.slice('/api/processes/'.length));
      const found = query.find(name);
      const [target] = found;
      if (found.length !== 1 || !target) return send(res, 404, { error: `няма един нод „${name}“ (${found.length})` });
      const depth = Math.min(12, Math.max(1, Number(url.searchParams.get('depth') ?? 6)));
      return send(res, 200, processView(query, target, depth));
    }
    if (route === 'GET /api/nodes') {
      const file = relative(graph.root, url.searchParams.get('file') ?? '')
        .split(sep)
        .join('/');
      const found = at(graph, file, Number(url.searchParams.get('line') ?? 0));
      return found ? send(res, 200, found) : send(res, 404, { error: `няма нод на ${file}` });
    }
    if (route === 'POST /api/plans') {
      const body = JSON.parse((await text(req)) || '{}') as { task?: string; targets?: string[] };
      const targets = (body.targets ?? []).flatMap((t) => query.find(t).slice(0, 1));
      res.writeHead(201, { 'content-type': 'text/markdown; charset=utf-8' });
      return res.end(plan(query, body.task ?? '', targets));
    }
    if (route === 'GET /api/events') {
      res.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
      });
      res.write(': archgraph\n\n');
      listeners.add(res);
      req.on('close', () => listeners.delete(res));
      return;
    }
    if (url.pathname.startsWith('/api/')) return send(res, 404, { error: `няма ${route}` });
    const file = join(DIST, normalize(url.pathname === '/' ? '/index.html' : url.pathname));
    if (req.method !== 'GET' || !file.startsWith(DIST) || !existsSync(file))
      return send(res, 404, { error: 'няма такъв файл' });
    res.writeHead(200, { 'content-type': TYPES[extname(file)] ?? 'application/octet-stream' });
    res.end(readFileSync(file));
  }

  await new Promise<void>((resolve) => server.listen(port, '127.0.0.1', resolve));
  return server;
}

function send(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}

async function text(req: IncomingMessage): Promise<string> {
  let body = '';
  for await (const chunk of req) body += chunk;
  return body;
}

// Входни точки: route-овете, а без тях controller-ите и handler-ите (временните роли по име).
function endpoints(graph: GraphModel): Entry[] {
  const routes = graph.nodes.filter((n) => n.kind === 'route');
  const nodes = routes.length
    ? routes
    : graph.nodes.filter((n) => roleOf(n, graph.types[n.id] !== undefined) === 'controller');
  return nodes
    .map((n) => ({
      id: n.id,
      label: n.name,
      role: n.kind === 'route' ? 'route' : 'controller',
      file: n.location.file,
      line: n.location.line,
    }))
    .sort((a, b) => a.label.localeCompare(b.label));
}

// Най-вътрешният нод и метод, които обхващат реда: курсорът в редактора маркира нода в графа.
function at(graph: GraphModel, file: string, line: number): { node: string; member?: string } | undefined {
  const inside = (l: { line: number; endLine: number }) => l.line <= line && line <= l.endLine;
  const node = graph.nodes
    .filter((n) => n.kind !== 'route' && n.location.file === file && inside(n.location))
    .sort((a, b) => a.location.endLine - a.location.line - (b.location.endLine - b.location.line))[0];
  if (!node) return undefined;
  const member = node.members.find((m) => inside(m.location));
  return member ? { node: node.id, member: member.name } : { node: node.id };
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
