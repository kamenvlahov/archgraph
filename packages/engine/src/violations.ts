import type { Edge, Node, Violation } from '@archgraph/model';
import { allowOf, type Architecture } from '@archgraph/rules';
import { CONSTRUCTORS } from './edges.ts';

// Нарушенията на архитектурата (етап 7, docs/RULES.md):
// - слой: зависимост от слой A към слой B, която не е в `allow` (по стила, ако не е изрична);
// - контекст: ребро между два контекста, чийто вид не е в `allow_cross` (само ако е зададен);
// - цикъл: класове, които зависят един от друг в кръг;
// - договор: имплементацията няма метод на интерфейса или иска повече параметри от него.

// Посоката на зависимостта: `injects` е от инжектирания тип към потребителя, затова се обръща.
const DEPENDS: Record<string, 'forward' | 'back'> = {
  calls: 'forward',
  creates: 'forward',
  extends: 'forward',
  implements: 'forward',
  injects: 'back',
};

export function violations(nodes: Node[], edges: Edge[], arch: Architecture | undefined): Violation[] {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const ignored = new Set(arch?.ignore_edges ?? []);
  const deps = edges.flatMap((e) => {
    const dir = DEPENDS[e.kind];
    if (!dir || ignored.has(e.kind)) return [];
    const [from, to] = dir === 'forward' ? [e.from.node, e.to.node] : [e.to.node, e.from.node];
    const a = byId.get(from);
    const b = byId.get(to);
    return a && b && a !== b ? [{ edge: e, from: a, to: b }] : [];
  });
  return [
    ...layerViolations(deps, arch),
    ...contextViolations(deps, arch),
    ...cycles(deps),
    ...contracts(nodes, edges, byId),
  ];
}

type Dep = { edge: Edge; from: Node; to: Node };

function layerViolations(deps: Dep[], arch: Architecture | undefined): Violation[] {
  const allow = allowOf(arch);
  const found = new Map<string, Violation>();
  for (const { edge, from, to } of deps) {
    if (!from.layer || !to.layer || from.layer === to.layer) continue;
    // слой, който правилата не познават, не се проверява
    if (!(from.layer in allow) || (allow[from.layer] ?? []).includes(to.layer)) continue;
    const key = `${from.id} ${to.id} ${edge.kind}`;
    if (!found.has(key))
      found.set(key, {
        kind: 'layer',
        message: `${from.name} (${from.layer}) ${edge.kind} ${to.name} (${to.layer}): ${from.layer} не може да зависи от ${to.layer}`,
        nodes: [from.id, to.id],
        edge: edge.id,
      });
  }
  return [...found.values()];
}

function contextViolations(deps: Dep[], arch: Architecture | undefined): Violation[] {
  const allowed = arch?.contexts?.allow_cross;
  if (!allowed) return [];
  const found = new Map<string, Violation>();
  for (const { edge, from, to } of deps) {
    if (!from.context || !to.context || from.context === to.context || allowed.includes(edge.kind)) continue;
    const key = `${from.id} ${to.id} ${edge.kind}`;
    if (!found.has(key))
      found.set(key, {
        kind: 'context',
        message: `${from.name} (${from.context}) ${edge.kind} ${to.name} (${to.context}): между контексти само ${allowed.join(', ')}`,
        nodes: [from.id, to.id],
        edge: edge.id,
      });
  }
  return [...found.values()];
}

// Силно свързаните компоненти (Tarjan, без рекурсия): всеки с повече от един клас е цикъл.
function cycles(deps: Dep[]): Violation[] {
  const next = new Map<string, Set<string>>();
  const names = new Map<string, string>();
  for (const { from, to } of deps) {
    next.set(from.id, (next.get(from.id) ?? new Set()).add(to.id));
    names.set(from.id, from.name);
    names.set(to.id, to.name);
  }
  const index = new Map<string, number>();
  const low = new Map<string, number>();
  const onStack = new Set<string>();
  const stack: string[] = [];
  const result: Violation[] = [];
  let counter = 0;
  for (const root of names.keys()) {
    if (index.has(root)) continue;
    const work: [string, string[]][] = [];
    const enter = (v: string) => {
      index.set(v, counter);
      low.set(v, counter++);
      stack.push(v);
      onStack.add(v);
      work.push([v, [...(next.get(v) ?? [])]]);
    };
    enter(root);
    while (work.length) {
      const top = work[work.length - 1] as [string, string[]];
      const [v, rest] = top;
      const w = rest.shift();
      if (w !== undefined) {
        if (!index.has(w)) enter(w);
        else if (onStack.has(w)) low.set(v, Math.min(low.get(v) ?? 0, index.get(w) ?? 0));
        continue;
      }
      work.pop();
      const parent = work[work.length - 1]?.[0];
      if (parent !== undefined) low.set(parent, Math.min(low.get(parent) ?? 0, low.get(v) ?? 0));
      if (low.get(v) !== index.get(v)) continue;
      const scc: string[] = [];
      for (let x = stack.pop(); x !== undefined; x = stack.pop()) {
        onStack.delete(x);
        scc.push(x);
        if (x === v) break;
      }
      if (scc.length > 1) {
        const members = scc.sort((a, b) => (names.get(a) ?? a).localeCompare(names.get(b) ?? b));
        result.push({
          kind: 'cycle',
          message: `цикъл: ${members.map((id) => names.get(id)).join(', ')} зависят един от друг`,
          nodes: members,
        });
      }
    }
  }
  return result;
}

// Имплементацията (или класовете, които наследява) трябва да има всеки метод на интерфейса и да не
// иска повече задължителни параметри от него.
function contracts(nodes: Node[], edges: Edge[], byId: Map<string, Node>): Violation[] {
  const parents = Map.groupBy(
    edges.filter((e) => e.kind === 'extends'),
    (e) => e.from.node,
  );
  const methodOf = (id: string, name: string, seen = new Set<string>()): Node['members'][number] | undefined => {
    const n = byId.get(id);
    if (!n || seen.has(id)) return undefined;
    seen.add(id);
    return (
      n.members.find((m) => m.name === name) ??
      (parents.get(id) ?? []).map((e) => methodOf(e.to.node, name, seen)).find(Boolean)
    );
  };
  const result: Violation[] = [];
  for (const e of edges) {
    if (e.kind !== 'implements') continue;
    const impl = byId.get(e.from.node);
    const iface = byId.get(e.to.node);
    if (!impl || iface?.kind !== 'interface' || impl.kind === 'interface') continue;
    for (const m of iface.members) {
      if (CONSTRUCTORS.has(m.name)) continue;
      const own = methodOf(impl.id, m.name);
      const required = (ms: Node['members'][number]) => ms.inputs.filter((p) => !p.optional && !p.variadic).length;
      if (!own)
        result.push({
          kind: 'contract',
          message: `${impl.name} няма ${m.name}() от ${iface.name}`,
          nodes: [impl.id, iface.id],
        });
      else if (required(own) > m.inputs.length)
        result.push({
          kind: 'contract',
          message: `${impl.name}.${m.name}() иска ${required(own)} параметъра, а ${iface.name} дава ${m.inputs.length}`,
          nodes: [impl.id, iface.id],
        });
    }
  }
  return result;
}
