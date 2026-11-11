import { join, relative } from 'node:path';
import { edge, type Edge, type GraphModel, type Member, type Node, type TypeRef } from '@archgraph/model';
import { bestRoute } from './requests.ts';

// Проектът с другите от работното пространство (етап 12, `.archgraph/workspace.yaml`). Нодовете
// им са с id `име::id` и файл спрямо този корен, за да се отварят от редактора; заявка без route
// в своя проект се свързва с route в друг. Така процесът минава от portal през api до desk.
export function combine(main: GraphModel, others: { name: string; graph: GraphModel }[]): GraphModel {
  const graph: GraphModel = {
    ...main,
    nodes: [...main.nodes],
    edges: [...main.edges],
    types: { ...main.types },
    ...(main.requests ? { requests: [...main.requests] } : {}),
  };
  const projects = new Map<string, string>(); // id на нод → проектът му ('' за главния)
  for (const n of main.nodes) projects.set(n.id, '');
  for (const { name, graph: other } of others) {
    const moved = prefixed(name, other, main.root);
    for (const n of moved.nodes) projects.set(n.id, name);
    graph.nodes = graph.nodes.concat(moved.nodes);
    graph.edges = graph.edges.concat(moved.edges);
    Object.assign(graph.types, moved.types);
    if (moved.unresolved) graph.unresolved = [...(graph.unresolved ?? []), ...moved.unresolved];
    if (moved.requests) graph.requests = [...(graph.requests ?? []), ...moved.requests];
  }
  // заявка без route в своя проект: най-точният route в друг проект
  const routes = graph.nodes.filter((n) => n.kind === 'route');
  const linked: Edge[] = [];
  const requests = (graph.requests ?? []).map((r) => {
    if (r.to) return r;
    const own = projects.get(r.from.node);
    const route = bestRoute(
      r.method,
      r.path,
      routes.filter((n) => projects.get(n.id) !== own),
    );
    if (!route) return r;
    linked.push(edge('requests', r.from, { node: route.id }, 'inferred'));
    return { ...r, to: route.id };
  });
  if (requests.length) graph.requests = requests;
  graph.edges = graph.edges.concat([...new Map(linked.map((e) => [e.id, e])).values()]);
  return graph;
}

function prefixed(name: string, g: GraphModel, root: string): GraphModel {
  const id = (x: string) => `${name}::${x}`;
  const file = (f: string) => relative(root, join(g.root, f));
  const type = (t: TypeRef): TypeRef => {
    switch (t.kind) {
      case 'named':
        return { ...t, id: id(t.id), ...(t.args ? { args: t.args.map(type) } : {}) };
      case 'array':
        return { ...t, of: type(t.of) };
      case 'map':
        return { ...t, key: type(t.key), value: type(t.value) };
      case 'union':
        return { ...t, of: t.of.map(type) };
      case 'shape':
        return { ...t, fields: t.fields.map((f) => ({ ...f, type: type(f.type) })) };
      default:
        return t;
    }
  };
  const member = (m: Member): Member => ({
    ...m,
    inputs: m.inputs.map((p) => ({ ...p, type: type(p.type) })),
    ...(m.output ? { output: { ...m.output, type: type(m.output.type) } } : {}),
    ...(m.throws ? { throws: m.throws.map(type) } : {}),
    location: { ...m.location, file: file(m.location.file) },
  });
  const node = (n: Node): Node => ({
    ...n,
    id: id(n.id),
    location: { ...n.location, file: file(n.location.file) },
    members: n.members.map(member),
    tags: [...(n.tags ?? []), `project:${name}`],
  });
  const end = (e: Edge['from']) => ({ ...e, node: id(e.node) });
  return {
    ...g,
    nodes: g.nodes.map(node),
    edges: g.edges.map((e) => ({
      ...e,
      id: id(e.id),
      from: end(e.from),
      to: end(e.to),
      ...(e.location ? { location: { ...e.location, file: file(e.location.file) } } : {}),
    })),
    types: Object.fromEntries(
      Object.values(g.types).map((t) => [
        id(t.id),
        {
          ...t,
          id: id(t.id),
          ...(t.nodeId ? { nodeId: id(t.nodeId) } : {}),
          fields: t.fields.map((f) => ({ ...f, type: type(f.type) })),
        },
      ]),
    ),
    ...(g.unresolved ? { unresolved: g.unresolved.map((u) => ({ ...u, from: end(u.from) as typeof u.from })) } : {}),
    ...(g.requests
      ? {
          requests: g.requests.map((r) => ({
            ...r,
            from: end(r.from) as typeof r.from,
            ...(r.to ? { to: id(r.to) } : {}),
          })),
        }
      : {}),
  };
}
