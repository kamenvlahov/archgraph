import { edge, type Annotation, type Edge, type Node } from '@archgraph/model';
import type { FrameworkRules } from './frameworks.ts';

// Route нодове и ребра `routes-to` от фактите на адаптерите. Id-то е `<език>:route:<МЕТОД> <път>`,
// пътят е в синтаксиса на framework-а и с префикса, когато той е в същия файл или клас.
export function routes(
  annotations: Annotation[],
  frameworks: FrameworkRules[],
  nodes: Node[],
  services: Map<string, string> = new Map(),
): { nodes: Node[]; edges: Edge[] } {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const found = new Map<string, Node>();
  const edges: Edge[] = [];
  for (const fw of frameworks) {
    const rules = fw.routes;
    if (!rules) continue;
    const add = (method: string, path: string, a: Annotation, to: { node: string; member?: string }) => {
      const name = `${method} ${path}`;
      let id = `${fw.language}:route:${name}`;
      if (found.has(id)) id = `${id}@${a.location.file}:${a.location.line}`;
      found.set(id, {
        id,
        kind: 'route',
        name,
        language: fw.language,
        role: 'route',
        framework: fw.framework,
        location: { ...a.location, endLine: a.location.line },
        members: [],
      });
      edges.push(edge('routes-to', { node: id }, to));
    };

    const seg = rules.segments;
    if (seg) {
      const at = (l: { file: string; line: number }) => `${l.file}:${l.line}`;
      const children = Map.groupBy(
        annotations.filter((a) => a.kind === 'object' && a.parent),
        (a) => at(a.parent as { file: string; line: number }),
      );
      const str = (a: Annotation | undefined, name: string) => {
        const v = a?.args.find((x) => x.name === name);
        return v?.kind === 'string' ? v.value : undefined;
      };
      for (const a of annotations) {
        const pattern = a.kind === 'object' ? str(a, seg.route) : undefined;
        if (pattern === undefined) continue;
        const defaults = children.get(at(a.location))?.find((c) => c.key === seg.defaults);
        const key = str(defaults, seg.controller);
        const node = key ? byId.get(services.get(key) ?? '') : undefined;
        if (!node) continue;
        // `/status[/][:action[/:id]]` → `/status`; с `:action` всеки …Action метод е отделен route
        const base = pattern.split('[')[0] ?? '';
        const actions = pattern.includes(`:${seg.action}`)
          ? node.members.filter((m) => m.name.endsWith(seg.suffix) && m.name !== seg.suffix)
          : node.members.filter((m) => m.name === `${str(defaults, seg.action) ?? 'index'}${seg.suffix}`);
        for (const m of actions) {
          const action = m.name.slice(0, -seg.suffix.length).toLowerCase();
          add('ANY', join(base, action === 'index' && !pattern.includes(`:${seg.action}`) ? '' : action), a, {
            node: node.id,
            member: m.name,
          });
        }
      }
    }

    const objects = rules.objects;
    if (objects) {
      const at = (l: { file: string; line: number }) => `${l.file}:${l.line}`;
      const byPlace = new Map(annotations.filter((a) => a.kind === 'object').map((a) => [at(a.location), a]));
      const own = (a: Annotation) => {
        const p = a.args.find((x) => x.name === objects.path);
        return p?.kind === 'string' ? p.value : undefined;
      };
      const full = (a: Annotation, depth = 0): string => {
        const parent = a.parent && depth < 20 ? byPlace.get(at(a.parent)) : undefined;
        return join(parent ? full(parent, depth + 1) : '', own(a) ?? '');
      };
      for (const a of byPlace.values()) {
        const handler = a.args.find((x) => x.kind === 'class' && objects.handler.includes(x.name ?? ''));
        if (own(a) === undefined || handler?.kind !== 'class' || !byId.has(handler.id)) continue;
        add(objects.method, full(a), a, { node: handler.id });
      }
    }

    for (const a of annotations) {
      if (a.kind === 'decorator' && a.on?.member && rules.decorators?.includes(last(a.name))) {
        add(httpMethod(a.name), join(prefix(a, annotations, rules), path(a)), a, a.on);
      } else if (a.kind === 'call' && rules.calls?.includes(a.name)) {
        const handler = a.args.find((x) => x.kind === 'class');
        const node = handler?.kind === 'class' ? byId.get(handler.id) : undefined;
        if (!node) continue;
        const member = rules.handlerMethods?.find((m) => node.members.some((x) => x.name === m));
        add(httpMethod(a.name), join('', path(a)), a, member ? { node: node.id, member } : { node: node.id });
      }
    }
  }
  return { nodes: [...found.values()], edges };
}

function prefix(a: Annotation, all: Annotation[], rules: NonNullable<FrameworkRules['routes']>): string {
  const p = rules.prefix;
  if (!p) return '';
  if ('decorator' in p) {
    const cls = all.find(
      (x) => x.kind === 'decorator' && x.on?.node === a.on?.node && !x.on?.member && x.name === p.decorator,
    );
    return cls ? path(cls) : '';
  }
  // `router.post` → обектът `router` → `router = APIRouter(prefix=...)` в същия файл.
  const object = a.name.split('.').slice(0, -1).join('.');
  const assign = all.find(
    (x) =>
      x.kind === 'assign' && x.target === object && x.location.file === a.location.file && last(x.name) === p.assign,
  );
  const own = keyword(assign, p.keyword);
  // Монтиране: факт, който подава същия обект (по id: модулът на handler-а + името) с `prefix=`.
  const id = `${a.on?.node.replace(/[.#][^.#]*$/, '')}.${object}`;
  const mount = rules.mount
    ? all.find((x) => x.args.some((y) => y.kind === 'class' && y.id === id) && keyword(x, rules.mount?.keyword ?? ''))
    : undefined;
  return join(keyword(mount, rules.mount?.keyword ?? ''), own);
}

function keyword(a: Annotation | undefined, name: string): string {
  const value = a?.args.find((x) => x.name === name);
  return value?.kind === 'string' ? value.value : '';
}

// Първият позиционен низ или `path=`.
function path(a: Annotation): string {
  const arg = a.args.find((x) => x.kind === 'string' && (x.name === undefined || x.name === 'path'));
  return arg?.kind === 'string' ? arg.value : '';
}

function join(prefix: string, path: string): string {
  const parts = [...prefix.split('/'), ...path.split('/')].filter(Boolean);
  return `/${parts.join('/')}`;
}

function last(name: string): string {
  return name.split(/->|\.|::/).pop() ?? name;
}

// `router.post` → POST; `$app->route`, `api_route`, `All` → ANY.
function httpMethod(name: string): string {
  const m = last(name).toUpperCase();
  return ['ROUTE', 'API_ROUTE', 'ANY', 'ALL'].includes(m) ? 'ANY' : m;
}
