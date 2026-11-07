import { edge, type CallSite, type Edge, type Expr, type Node, type TypeRef, type TypeShape } from '@archgraph/model';

// Превръща извикванията от адаптерите в ребра. `calls` е по евристика (типът на получателя е изведен,
// не доказан), затова е `inferred`. `creates` идва от `new X` или `X()` и е `exact`.
// Методът се търси в типа на получателя и после нагоре по extends/implements, така че реброто сочи
// класа, в който е деклариран (`Order` → `AbstractEntity#getId`).
export function callEdges(nodes: Node[], edges: Edge[], types: Record<string, TypeShape>, calls: CallSite[]): Edge[] {
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
        return n ? [{ kind: 'named', id: n.id }] : [];
      }
      case 'field':
        return classes(typeOf(e.of, depth + 1)).flatMap((id) => {
          const f = lookup(id, () => fields.get(id)?.find((x) => x.name === e.name));
          return f ? [f[1].type] : [];
        });
      case 'result':
        return classes(typeOf(e.of, depth + 1)).flatMap((id) => {
          const m = lookup(id, (n) => n.members.find((x) => x.name === e.name));
          return m?.[1].output ? [m[1].output.type] : [];
        });
      case 'element':
        return typeOf(e.of, depth + 1).flatMap(element);
    }
  };

  const result: Edge[] = [];
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
    } else {
      for (const id of classes(typeOf(c.on))) {
        const m = lookup(id, (n) => n.members.find((x) => x.name === c.name));
        if (m) result.push(edge('calls', c.from, { node: m[0], member: c.name }, 'inferred'));
      }
    }
  }
  return result;
}

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
