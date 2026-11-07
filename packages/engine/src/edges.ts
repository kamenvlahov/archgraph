import { edge, type Edge, type Node, type TypeRef } from '@archgraph/model';

const CONSTRUCTORS = new Set(['__construct', 'constructor', '__init__']);

// Довършва ребрата от адаптерите, след като всички нодове са известни:
// - `injects` от всеки тип от проекта в порт на конструктор;
// - клас, който „наследява“ интерфейс, го имплементира (Python Protocol);
// - ребра към външни типове отпадат, защото те нямат нодове.
export function linkEdges(nodes: Node[], edges: Edge[]): Edge[] {
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

  for (const n of nodes) {
    if (n.kind === 'interface') continue;
    for (const m of n.members.filter((m) => CONSTRUCTORS.has(m.name)))
      for (const port of m.inputs)
        for (const id of namedIds(port.type))
          add(edge('injects', { node: id }, { node: n.id, member: m.name, port: port.name }));
  }
  return [...result.values()];
}

// `Foo` и `?Foo` инжектират Foo. Масив от Foo е колекция, не инжекция.
function namedIds(t: TypeRef): string[] {
  if (t.kind === 'named') return [t.id];
  if (t.kind === 'union') return t.of.flatMap(namedIds);
  return [];
}
