import { edge, type Annotation, type Edge, type Node } from '@archgraph/model';
import type { FrameworkRules } from './frameworks.ts';

// Route нодове и ребра `routes-to` от фактите на адаптерите. Id-то е `<език>:route:<МЕТОД> <път>`,
// пътят е в синтаксиса на framework-а и с префикса, когато той е в същия файл или клас.
export function routes(
  annotations: Annotation[],
  frameworks: FrameworkRules[],
  nodes: Node[],
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
