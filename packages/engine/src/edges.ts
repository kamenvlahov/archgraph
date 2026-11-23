import { edge, type Edge, type Node, type TypeRef, type TypeShape } from '@archgraph/model';

export const CONSTRUCTORS = new Set(['__construct', 'constructor', '__init__']);

// Довършва ребрата от адаптерите, след като всички нодове са известни:
// - `injects` от всеки тип от проекта в порт на конструктор;
// - клас, който „наследява“ интерфейс, го имплементира (Python Protocol);
// - структурен интерфейс (таг `structural`, Go) се имплементира от всеки клас на същия език, който
//   има всичките му методи със същия брой параметри, вкл. наследените (D-015);
// - `uses-type` от метод (параметри, изход, грешки) и от клас (полета) към всеки тип от проекта:
//   типът в сигнатурата е зависимост, дори нищо да не се вика (интерфейсите на port към model);
// - ребра към външни типове отпадат, защото те нямат нодове.
export function linkEdges(nodes: Node[], edges: Edge[], types: Record<string, TypeShape> = {}): Edge[] {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const result = new Map<string, Edge>();
  const add = (e: Edge) => {
    if (byId.has(e.from.node) && byId.has(e.to.node)) result.set(e.id, e);
  };

  for (const e of edges) {
    const from = byId.get(e.from.node);
    const to = byId.get(e.to.node);
    if (e.kind === 'extends' && from?.kind !== 'interface' && to?.kind === 'interface')
      add(edge('implements', e.from, e.to, e.confidence));
    else add(e);
  }

  for (const e of structural(nodes, [...result.values()])) add(e);

  for (const n of nodes) {
    for (const m of n.members) {
      const refs = [...m.inputs.map((p) => p.type), ...(m.output ? [m.output.type] : []), ...(m.throws ?? [])];
      for (const id of new Set(refs.flatMap(mentioned)))
        if (id !== n.id) add(edge('uses-type', { node: n.id, member: m.name }, { node: id }));
    }
  }
  for (const t of Object.values(types)) {
    if (!t.nodeId) continue;
    for (const id of new Set(t.fields.flatMap((f) => mentioned(f.type))))
      if (id !== t.nodeId) add(edge('uses-type', { node: t.nodeId }, { node: id }));
  }

  for (const n of nodes) {
    if (n.kind === 'interface') continue;
    for (const m of n.members.filter((m) => CONSTRUCTORS.has(m.name)))
      for (const port of m.inputs)
        for (const id of namedIds(port.type))
          add(edge('injects', { node: id }, { node: n.id, member: m.name, port: port.name }));
  }
  return [...result.values()];
}

function structural(nodes: Node[], edges: Edge[]): Edge[] {
  const contracts = nodes.filter((n) => n.kind === 'interface' && n.tags?.includes('structural'));
  if (contracts.length === 0) return [];
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const parents = Map.groupBy(
    edges.filter((e) => e.kind === 'extends'),
    (e) => e.from.node,
  );
  const declared = new Set(edges.filter((e) => e.kind === 'implements').map((e) => `${e.from.node}->${e.to.node}`));
  // методите с наследените (вградените типове в Go): име → брой параметри
  const methodSet = (id: string, seen = new Set<string>()): Map<string, number> => {
    const set = new Map<string, number>();
    if (seen.has(id)) return set;
    seen.add(id);
    for (const e of parents.get(id) ?? []) for (const [k, v] of methodSet(e.to.node, seen)) set.set(k, v);
    for (const m of byId.get(id)?.members ?? []) set.set(m.name, m.inputs.length);
    return set;
  };
  const classes = nodes
    .filter((n) => n.kind === 'class')
    .map((n) => ({ node: n, methods: methodSet(n.id) }))
    .filter((c) => c.methods.size > 0);
  const result: Edge[] = [];
  for (const contract of contracts) {
    const wanted = [...methodSet(contract.id)];
    if (wanted.length === 0) continue;
    for (const c of classes)
      if (
        c.node.language === contract.language &&
        !declared.has(`${c.node.id}->${contract.id}`) &&
        wanted.every(([name, arity]) => c.methods.get(name) === arity)
      )
        result.push(edge('implements', { node: c.node.id }, { node: contract.id }, 'inferred'));
  }
  return result;
}

// Всички типове в един тип: `Order`, `[]Item`, `map[ID]Step`, `Result<Order>`.
function mentioned(t: TypeRef): string[] {
  switch (t.kind) {
    case 'named':
      return [t.id, ...(t.args ?? []).flatMap(mentioned)];
    case 'array':
      return mentioned(t.of);
    case 'map':
      return [...mentioned(t.key), ...mentioned(t.value)];
    case 'union':
      return t.of.flatMap(mentioned);
    case 'shape':
      return t.fields.flatMap((f) => mentioned(f.type));
    default:
      return [];
  }
}

// `Foo` и `?Foo` инжектират Foo. Масив от Foo е колекция, не инжекция.
function namedIds(t: TypeRef): string[] {
  if (t.kind === 'named') return [t.id];
  if (t.kind === 'union') return t.of.flatMap(namedIds);
  return [];
}
