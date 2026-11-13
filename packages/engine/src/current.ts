import type { GraphModel, Node } from '@archgraph/model';
import { loadArchitecture } from '@archgraph/rules';

// Текущата архитектура (без чертеж): слоевете и модулите се четат от папките такива, каквито са,
// а не спрямо шаблон. Слоят е първата папка с позната дума (api, Handler, domain, infrastructure…);
// модулът е папката преди нея (src/Album/Handler) или след нея, иначе думите в името на файла
// (api/routers/tickets.py, infrastructure/ticket_repository.py → ticket). По ребрата от входа
// се вижда как минава заявката: през application/domain (по слоеве) или направо в infrastructure.

export const CURRENT_LAYERS = ['entry', 'application', 'domain', 'infrastructure', 'other'] as const;
export type CurrentLayer = (typeof CURRENT_LAYERS)[number];

const WORDS: Record<Exclude<CurrentLayer, 'other'>, string[]> = {
  entry: [
    'api',
    'http',
    'web',
    'controller',
    'controllers',
    'handler',
    'handlers',
    'router',
    'routers',
    'routes',
    'presentation',
    'interfaces',
    'ui',
    'cli',
    'console',
    'command',
    'commands',
    'worker',
    'workers',
    'jobs',
    'consumers',
    'graphql',
    'rest',
    'endpoints',
    'action',
    'actions',
    'middleware',
  ],
  application: ['application', 'services', 'service', 'usecases', 'usecase', 'use', 'app_services'],
  domain: ['domain', 'entity', 'entities', 'model', 'models', 'aggregate', 'aggregates', 'valueobject', 'valueobjects'],
  infrastructure: [
    'infrastructure',
    'infra',
    'repository',
    'repositories',
    'persistence',
    'db',
    'database',
    'adapters',
    'adapter',
    'storage',
    'clients',
    'client',
    'integrations',
    'integration',
    'mapper',
    'mappers',
  ],
};
const LAYER_OF = new Map(
  Object.entries(WORDS).flatMap(([layer, words]) => words.map((w) => [w, layer as CurrentLayer])),
);
const ROOTS = new Set(['src', 'app', 'lib', 'source', 'module', 'modules', 'packages', 'backend', 'server']);
// не са част от архитектурата
const SKIP = new Set([
  'tests',
  'test',
  'migrations',
  'fixtures',
  'vendor',
  'node_modules',
  'docs',
  'scripts',
  'alembic',
]);
// подпапки и думи в имената, които са роля, не модул
const ROLE_WORDS = new Set([
  ...LAYER_OF.keys(),
  'dto',
  'dtos',
  'schemas',
  'schema',
  'repo',
  'crud',
  'deps',
  'utils',
  'util',
  'helpers',
  'impl',
  'base',
  'factory',
  'contract',
  'contracts',
  'public',
  'routes',
  'interface',
  'query',
  'queries',
  'test',
  'tests',
  'init',
  'main',
  'py',
  'php',
  'ts',
]);

export interface CurrentUnit {
  id: string; // нодът, или файлът при свободни функции
  name: string;
  file: string;
  line: number;
}

export interface CurrentModule {
  name: string;
  cells: Partial<Record<CurrentLayer, CurrentUnit[]>>;
  // къде отиват извикванията от входа на модула: брой по слой
  from: Partial<Record<CurrentLayer, number>>;
  shape: 'layered' | 'direct' | 'mixed' | 'none'; // през application/domain, направо в infrastructure, и двете
}

export interface CurrentArchitecture {
  folders: Partial<Record<CurrentLayer, string[]>>; // истинските имена на папките за всеки слой
  modules: CurrentModule[];
}

const tokens = (s: string) =>
  s
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);

function placeOf(file: string): { layer: CurrentLayer; folder: string; module: string; byName: boolean } {
  const parts = file.split('/');
  const dirs = parts.slice(0, -1);
  const stem = (parts.at(-1) ?? '').replace(/\.[^.]+$/, '');
  const at = dirs.findIndex((d) => tokens(d).some((t) => LAYER_OF.has(t)));
  const layer =
    at < 0
      ? 'other'
      : (tokens(dirs[at] ?? '')
          .map((t) => LAYER_OF.get(t))
          .find(Boolean) ?? 'other');
  const folder = at < 0 ? (dirs[0] ?? '.') : (dirs[at] ?? '');
  const before =
    at > 0
      ? dirs
          .slice(0, at)
          .reverse()
          .find((d) => !ROOTS.has(d.toLowerCase()))
      : undefined;
  const after = dirs.slice(at + 1).find((d) => !tokens(d).every((t) => ROLE_WORDS.has(t)));
  const own = tokens(stem).filter((t) => !ROLE_WORDS.has(t));
  const fromName = own.length ? singular(own.join('_')) : undefined;
  const module = before ?? after;
  return module
    ? { layer, folder, module, byName: false }
    : { layer, folder, module: fromName ?? 'общо', byName: true };
}

const singular = (w: string) => (/ies$/.test(w) ? `${w.slice(0, -3)}y` : /[^s]s$/.test(w) ? w.slice(0, -1) : w);

export function currentArchitecture(graph: GraphModel): CurrentArchitecture {
  const code = graph.nodes.filter(
    (n) =>
      n.kind !== 'route' &&
      n.kind !== 'template' &&
      !n.id.includes('::') &&
      !(n.tags ?? []).includes('ghost') &&
      !n.location.file.split('/').some((d) => SKIP.has(d.toLowerCase())),
  );
  const place = new Map<string, ReturnType<typeof placeOf>>();
  const explicit = loadArchitecture(graph.root) !== undefined; // без файла слоят е от каталога на ролите
  for (const n of code) {
    // изричните слой и модул от .archgraph/architecture.yaml печелят пред четенето на папките
    const read = placeOf(n.location.file);
    const layer =
      explicit && n.layer
        ? tokens(n.layer)
            .map((t) => LAYER_OF.get(t))
            .find(Boolean)
        : undefined;
    place.set(n.id, {
      ...read,
      ...(layer ? { layer, folder: n.layer } : {}),
      ...(explicit && n.context ? { module: n.context, byName: false } : {}),
    });
  }

  // Без папки за модули (api/, domain/, infrastructure/ направо): модулите са тези на входа (routers/tickets.py),
  // а файлът от друг слой отива при входа, чието име се съдържа в неговото (operator_ticket_repository → ticket).
  const entries = new Set([...place.values()].filter((p) => p.byName && p.layer === 'entry').map((p) => p.module));
  for (const p of place.values()) {
    if (!p.byName || p.layer === 'entry') continue;
    const own = p.module.split('_');
    const host = [...entries].filter((e) => contains(own, e.split('_'))).sort((a, b) => b.length - a.length)[0];
    if (host) p.module = host;
  }

  const folders = new Map<CurrentLayer, Set<string>>();
  const modules = new Map<string, CurrentModule>();
  const seenFiles = new Set<string>();
  const unit = (n: Node): CurrentUnit | undefined => {
    if (n.kind !== 'function') return { id: n.id, name: n.name, file: n.location.file, line: n.location.line };
    // свободните функции (FastAPI route-ове, помощни) са един чип на файл
    if (seenFiles.has(n.location.file)) return undefined;
    seenFiles.add(n.location.file);
    const name = n.location.file.split('/').at(-1) ?? n.location.file;
    return { id: n.location.file, name, file: n.location.file, line: 1 };
  };
  for (const n of code) {
    const p = place.get(n.id);
    if (!p) continue;
    folders.set(p.layer, (folders.get(p.layer) ?? new Set()).add(p.folder));
    const m = modules.get(p.module) ?? { name: p.module, cells: {}, from: {}, shape: 'none' as const };
    modules.set(p.module, m);
    const u = unit(n);
    if (u) (m.cells[p.layer] ??= []).push(u);
  }

  for (const e of graph.edges) {
    if (e.kind !== 'calls' && e.kind !== 'injects' && e.kind !== 'creates') continue;
    const from = place.get(e.from.node);
    const to = place.get(e.to.node);
    if (!from || !to || from.layer !== 'entry' || to.layer === 'entry' || to.layer === 'other') continue;
    const m = modules.get(from.module);
    if (m) m.from[to.layer] = (m.from[to.layer] ?? 0) + 1;
  }
  for (const m of modules.values()) {
    const layered = (m.from.application ?? 0) + (m.from.domain ?? 0);
    const direct = m.from.infrastructure ?? 0;
    m.shape = layered && direct ? 'mixed' : layered ? 'layered' : direct ? 'direct' : 'none';
    for (const units of Object.values(m.cells)) units.sort((a, b) => a.name.localeCompare(b.name));
  }

  return {
    folders: Object.fromEntries([...folders].map(([layer, names]) => [layer, [...names].sort()])),
    modules: [...modules.values()].sort((a, b) => count(b) - count(a) || a.name.localeCompare(b.name)),
  };
}

const count = (m: CurrentModule) => Object.values(m.cells).reduce((sum, units) => sum + units.length, 0);

// думите на `part` една след друга в `whole`
function contains(whole: string[], part: string[]): boolean {
  return whole.some((_, i) => part.every((w, j) => whole[i + j] === w));
}
