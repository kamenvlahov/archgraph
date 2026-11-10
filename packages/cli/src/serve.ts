import { existsSync, readFileSync, watch } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { basename, extname, join, normalize, relative, sep } from 'node:path';
import {
  blueprint,
  DEFAULT_EXCLUDES,
  designEntities,
  designWarnings,
  GraphQuery,
  layers,
  layerView,
  pattern,
  processView,
  skeleton,
  Project,
  roleOf,
  type Blueprint,
  type ScanOptions,
} from '@archgraph/engine';
import type { GraphModel, Node, TypeRef } from '@archgraph/model';
import { designPlan, patternPlan, plan } from '@archgraph/planner';
import {
  CATALOG,
  DESIGN_STACKS,
  DESIGN_STYLES,
  LEVELS,
  loadDesign,
  saveDesign,
  STYLE_ALLOW,
  validFields,
  validOutput,
  type Design,
} from '@archgraph/rules';

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
//   POST /api/patterns {example, to, from?}  „като този“: ghost нодове, регистрации и план
//   GET  /api/design                   чертежът (етап 11), стековете и стиловете за избор
//   PUT  /api/design {stack, style, auth?, resources?, endpoints}  записва .archgraph/design.yaml
//   GET  /api/design/plan              Markdown план: какво още да се напише по чертежа
//   GET  /api/design/skeleton?file=    скелетът на файл от чертежа (при „Създай файла“)
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
  ghost?: boolean; // от чертежа, още го няма в кода
}

export async function serve(path: string, port: number, options: ScanOptions, host = '127.0.0.1'): Promise<Server> {
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
      changed(files);
    }, DEBOUNCE);
  });

  const changed = (files: string[]) => {
    query = new GraphQuery(project.graph);
    for (const res of listeners) res.write(`event: changed\ndata: ${JSON.stringify({ files })}\n\n`);
  };

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
      res.setHeader('access-control-allow-methods', 'GET, POST, PUT');
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
        ...(project.report.design ? { design: project.report.design } : {}),
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
    if (route === 'POST /api/patterns') {
      const body = JSON.parse((await text(req)) || '{}') as { example?: string; to?: string; from?: string };
      const [example] = query.find(body.example ?? '');
      if (!example || !body.to)
        return send(res, 400, { error: 'трябват example (съществуващ клас) и to (новото име)' });
      const result = pattern(graph, example, body.to, body.from || undefined);
      return send(res, 201, { ...result, plan: patternPlan(result, example.node.name) });
    }
    if (route === 'GET /api/design') {
      const design = loadDesign(graph.root);
      return send(res, 200, {
        design: design ?? null,
        progress: project.report.design ?? null,
        warnings: design ? designWarnings(design) : [],
        objects: design ? objects(blueprint(design)) : [],
        entities: design ? designEntities(design) : [],
        stacks: DESIGN_STACKS.map((x) => ({ stack: x.stack, label: x.label, language: x.language })),
        styles: DESIGN_STYLES.map((x) => ({
          style: x.style,
          label: x.label,
          about: x.about,
          layers: x.layers,
          allow: STYLE_ALLOW[x.style] ?? {},
        })),
      });
    }
    if (route === 'PUT /api/design') {
      const body = JSON.parse((await text(req)) || '{}') as Partial<Design>;
      const design: Design = {
        stack: body.stack ?? '',
        style: body.style ?? '',
        ...(body.auth ? { auth: body.auth } : {}),
        ...(body.resources ? { resources: body.resources } : {}),
        endpoints: body.endpoints ?? [],
      };
      if (!DESIGN_STACKS.some((x) => x.stack === design.stack) || !DESIGN_STYLES.some((x) => x.style === design.style))
        return send(res, 400, { error: 'трябват познати stack и style' });
      const bad = design.endpoints.find((e) => !/^[A-Z]+$/.test(e.method ?? '') || !e.path?.startsWith('/'));
      if (bad) return send(res, 400, { error: `ендпойнтът трябва да е МЕТОД /път: ${JSON.stringify(bad)}` });
      const fields = (f: unknown) => f === undefined || validFields(f);
      const typo = design.endpoints.find((e) => !fields(e.input) || (e.output !== undefined && !validOutput(e.output)));
      if (typo)
        return send(res, 400, {
          error: `полето е име (букви, цифри, _) и тип, [тип] за масив или {поле: тип} за обект: ${JSON.stringify(typo)}`,
        });
      const resource = Object.entries(design.resources ?? {}).find(
        ([name, r]) =>
          !/^[A-Z]\w*$/.test(name) ||
          !fields(r.fields) ||
          (r.owner !== undefined && typeof r.owner !== 'string') ||
          (r.level !== undefined && !LEVELS.includes(r.level)),
      );
      if (resource)
        return send(res, 400, { error: `ресурсът е Име с {owner?, level?, fields?}: ${JSON.stringify(resource)}` });
      saveDesign(graph.root, design);
      await project.update(['.archgraph/design.yaml']);
      changed(['.archgraph/design.yaml']);
      return send(res, 200, { design: loadDesign(graph.root), progress: project.report.design ?? null });
    }
    if (route === 'GET /api/design/plan') {
      const design = loadDesign(graph.root);
      if (!design || !project.report.design) return send(res, 404, { error: 'проектът няма чертеж' });
      res.writeHead(200, { 'content-type': 'text/markdown; charset=utf-8' });
      return res.end(designPlan(graph, blueprint(design), project.report.design));
    }
    if (route === 'GET /api/design/skeleton') {
      const design = loadDesign(graph.root);
      const code = design && skeleton(blueprint(design), url.searchParams.get('file') ?? '');
      if (!code) return send(res, 404, { error: 'файлът не е от чертежа' });
      res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
      return res.end(code);
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

  await new Promise<void>((resolve) => server.listen(port, host, resolve));
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
      ...((n.tags ?? []).includes('ghost') ? { ghost: true } : {}),
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

// Обектите за падащото меню на изхода и типовете на полетата: entity-тата, класовете, които методите
// връщат, и вложените обекти. Входните съобщения (DTO, Query, Command) не са сред тях.
function objects(bp: Blueprint): string[] {
  const ids = new Set(bp.nodes.filter((n) => n.role === 'entity' || n.role === 'model').map((n) => n.id));
  const add = (t?: TypeRef) => {
    if (t?.kind === 'named') ids.add(t.id);
    if (t?.kind === 'array') add(t.of);
  };
  for (const n of bp.nodes) for (const m of n.members) add(m.output?.type);
  for (const shape of Object.values(bp.types)) for (const f of shape.fields) add(f.type);
  return [...new Set(bp.nodes.filter((n) => ids.has(n.id) && n.kind === 'class').map((n) => n.name))];
}
