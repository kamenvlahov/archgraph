import { CONSTRUCTORS } from './edges.ts';
import {
  edge,
  type CallSite,
  type Edge,
  type Expr,
  type Node,
  type TypeRef,
  type TypeShape,
  type UnresolvedCall,
} from '@archgraph/model';

// Превръща извикванията от адаптерите в ребра. `calls` е по евристика (типът на получателя е изведен,
// не доказан), затова е `inferred`. `creates` идва от `new X` или `X()` и е `exact`.
// Методът се търси в типа на получателя и после нагоре по extends/implements, така че реброто сочи
// класа, в който е деклариран (`Order` → `AbstractEntity#getId`).
// Извикванията без ребро, чието име съвпада с член в проекта, се връщат в `unresolved` (D-011):
// получател без тип (`$sm->get('X')->run()`) или функция, която не е намерена. Получател от
// външен тип (`AsyncSession`, `ContainerInterface`) е известен и не е пропуск.
export function callEdges(
  nodes: Node[],
  edges: Edge[],
  types: Record<string, TypeShape>,
  calls: CallSite[],
): { edges: Edge[]; unresolved: UnresolvedCall[] } {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const parents = new Map<string, string[]>();
  for (const e of edges)
    if (e.kind === 'extends' || e.kind === 'implements')
      parents.set(e.from.node, [...(parents.get(e.from.node) ?? []), e.to.node]);
  const fields = new Map(Object.values(types).flatMap((t) => (t.nodeId ? [[t.nodeId, t.fields] as const] : [])));

  // Първият клас нагоре по наследяването, в който `pick` намира нещо.
  const lookup = <T>(
    id: string,
    pick: (n: Node) => T | undefined,
    seen = new Set<string>(),
  ): [string, T] | undefined => {
    const n = byId.get(id);
    if (!n || seen.has(id)) return undefined;
    seen.add(id);
    const found = pick(n);
    if (found !== undefined) return [id, found];
    for (const p of parents.get(id) ?? []) {
      const up = lookup(p, pick, seen);
      if (up) return up;
    }
    return undefined;
  };

  const typeOf = (e: Expr, depth = 0): TypeRef[] => {
    if (depth > 20) return [];
    switch (e.kind) {
      case 'type':
        return [e.type];
      case 'call': {
        const n = byId.get(e.id);
        if (n?.kind === 'function') return n.members[0]?.output ? [n.members[0].output.type] : [];
        return n ? [{ kind: 'named', id: n.id }] : [EXTERNAL];
      }
      case 'field':
      case 'result': {
        const of = typeOf(e.of, depth + 1);
        const found = classes(of).flatMap((id): TypeRef[] => {
          if (!byId.has(id)) return [EXTERNAL];
          const hit =
            e.kind === 'field'
              ? lookup(id, () => fields.get(id)?.find((x) => x.name === e.name))?.[1].type
              : lookup(id, (n) => n.members.find((x) => x.name === e.name))?.[1].output?.type;
          return hit ? [hit] : [];
        });
        // Метод на dict, list или външен клас: резултатът е извън проекта, но не е неизвестен.
        return found.length > 0 || !of.some((t) => t.kind !== 'unknown' && t.kind !== 'named') ? found : [EXTERNAL];
      }
      case 'element':
        return typeOf(e.of, depth + 1).flatMap(element);
    }
  };

  const memberNames = new Set(nodes.flatMap((n) => n.members.map((m) => m.name)));
  const modules = new Set(nodes.map((n) => owner(n.id)));
  const result: Edge[] = [];
  const unresolved: UnresolvedCall[] = [];
  const missing = (c: CallSite, name: string) => {
    if (memberNames.has(name) && !CONSTRUCTORS.has(name)) unresolved.push({ from: c.from, name, line: c.line });
  };
  for (const c of calls) {
    if (c.kind === 'new') {
      if (byId.get(c.id)?.kind === 'class')
        result.push(edge('creates', { node: c.from.node, member: c.from.member }, { node: c.id }));
    } else if (c.kind === 'function') {
      const n = byId.get(c.id);
      if (n?.kind === 'class')
        result.push(edge('creates', { node: c.from.node, member: c.from.member }, { node: n.id }));
      else if (n?.kind === 'function' && n.members[0])
        result.push(edge('calls', c.from, { node: n.id, member: n.members[0].name }, 'inferred'));
      // Функция, която я няма: пропуск, ако модулът е от проекта или името е без модул.
      // `alembic.context.run_migrations` е външна, дори да има наша `run_migrations`.
      else if (!n && (modules.has(owner(c.id)) || !/[.\\#]/.test(c.id.replace(/^\w+:/, ''))))
        missing(c, lastName(c.id));
    } else if (!CONSTRUCTORS.has(c.name)) {
      // parent::__construct() и super().__init__() са част от наследяването, не извикване.
      const receiver = typeOf(c.on);
      for (const id of classes(receiver)) {
        const m = lookup(id, (n) => n.members.find((x) => x.name === c.name));
        if (m) result.push(edge('calls', c.from, { node: m[0], member: c.name }, 'inferred'));
      }
      // Получател с известен тип извън проекта (dict, list, външен клас) не е пропуск.
      if (receiver.every((t) => t.kind === 'unknown' && t !== EXTERNAL)) missing(c, c.name);
    }
  }
  // Едно и също име от един член е един пропуск; остава първият ред.
  const seen = new Set<string>();
  return {
    edges: result,
    unresolved: unresolved.filter((u) => {
      const key = `${u.from.node}#${u.from.member}->${u.name}`;
      return !seen.has(key) && seen.add(key);
    }),
  };
}

// `python:app.orders.place` → `place`, `php:App\money` → `money`, `node:src/a.ts#run` → `run`.
function lastName(id: string): string {
  return id.split(/[.\\#:/]/).pop() ?? id;
}

// Модулът или класът, в който е id-то: `python:app.orders.place` → `python:app.orders`.
function owner(id: string): string {
  return id.replace(/[.\\#][^.\\#]*$/, '');
}

// Тип извън проекта: резултат от външна функция или метод на външен клас. Не води до ребро,
// но и не е пропуск, за разлика от получател без тип.
const EXTERNAL: TypeRef = { kind: 'unknown', hint: 'external' };

// Нодовете зад тип: `Order`, `?Order`, `Order|Draft`.
function classes(types: TypeRef[]): string[] {
  return types.flatMap((t) => (t.kind === 'named' ? [t.id] : t.kind === 'union' ? classes(t.of) : []));
}

// Елемент на колекция: `list<X>`, `X[]`, `dict[K, V]` → V, `Collection<int, X>` → последния аргумент.
function element(t: TypeRef): TypeRef[] {
  if (t.kind === 'array') return [t.of];
  if (t.kind === 'map') return [t.value];
  if (t.kind === 'union') return t.of.flatMap(element);
  if (t.kind === 'named' && t.args?.length) return [t.args[t.args.length - 1] as TypeRef];
  return [];
}
