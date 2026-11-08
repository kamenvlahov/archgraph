import { posix } from 'node:path';
import type { GraphModel, Node } from '@archgraph/model';
import { roleOf } from './process.ts';

// Изгледът „слой“: всички класове на един слой, групирани по модул, компактно. Функциите на ниво модул
// (Python services.py) са една единица на файл, иначе слоят е стотици малки нодове. Стрелки има само
// между единиците в слоя; връзките към другите слоеве са броячи.

export interface LayerView {
  layer: string;
  groups: { name: string; units: Unit[] }[];
  edges: { id: string; from: string; to: string; count: number; violation?: string }[];
}

export interface Unit {
  id: string; // id на класа или `file:<път>` за функциите във файл
  label: string;
  role: string;
  file: string;
  line: number;
  members: { name: string; line: number; target: string }[]; // target: начало на процес
  up: number; // колко единици от други слоеве зависят от тази
  down: number; // от колко единици в други слоеве зависи тя
  violations: string[];
}

export interface LayerSummary {
  name: string;
  units: number;
}

// Посоката на зависимостта: `injects` е от инжектирания тип към потребителя, затова се обръща.
const DEPENDS: Record<string, 'forward' | 'back'> = {
  calls: 'forward',
  creates: 'forward',
  extends: 'forward',
  implements: 'forward',
  injects: 'back',
};

export function layers(graph: GraphModel, order: string[]): LayerSummary[] {
  const units = new Map<string, Set<string>>();
  for (const n of graph.nodes) if (n.layer) units.set(n.layer, (units.get(n.layer) ?? new Set()).add(unitOf(n)));
  return [...units]
    .sort(([a], [b]) => rank(order, a) - rank(order, b))
    .map(([name, set]) => ({ name, units: set.size }));
}

export function layerView(graph: GraphModel, layer: string): LayerView {
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  const inLayer = graph.nodes.filter((n) => n.layer === layer && n.kind !== 'route');
  const units = new Map<string, Unit>();
  const group = new Map<string, string>();
  for (const n of inLayer) {
    const id = unitOf(n);
    const unit = units.get(id) ?? newUnit(n, id);
    units.set(id, unit);
    group.set(id, n.context ?? posix.basename(posix.dirname(n.location.file)) ?? '');
    const members = n.kind === 'function' ? n.members.slice(0, 1) : n.members;
    for (const m of members)
      unit.members.push({
        name: m.name,
        line: m.location.line,
        target: n.kind === 'function' ? n.id : `${n.id}#${m.name}`,
      });
  }

  // Зависимостите на ниво единица: вътре в слоя са стрелки, навън — броячи.
  const inner = new Map<string, LayerView['edges'][number]>();
  const up = new Map<string, Set<string>>();
  const down = new Map<string, Set<string>>();
  for (const e of graph.edges) {
    const dir = DEPENDS[e.kind];
    if (!dir) continue;
    const [fromId, toId] = dir === 'forward' ? [e.from.node, e.to.node] : [e.to.node, e.from.node];
    const from = byId.get(fromId);
    const to = byId.get(toId);
    if (!from || !to) continue;
    const a = unitOf(from);
    const b = unitOf(to);
    if (a === b) continue;
    if (units.has(a) && units.has(b)) {
      const id = `${a}->${b}`;
      const edge = inner.get(id) ?? { id, from: a, to: b, count: 0 };
      edge.count++;
      inner.set(id, edge);
    } else if (units.has(a)) down.set(a, (down.get(a) ?? new Set()).add(b));
    else if (units.has(b)) up.set(b, (up.get(b) ?? new Set()).add(a));
  }
  for (const v of graph.violations ?? []) {
    const ids = [...new Set(v.nodes.flatMap((id) => (byId.has(id) ? [unitOf(byId.get(id) as Node)] : [])))];
    for (const id of ids) units.get(id)?.violations.push(v.message);
    const [a, b] = ids;
    const edge = a && b ? inner.get(`${a}->${b}`) : undefined;
    if (edge && (v.kind === 'layer' || v.kind === 'context')) edge.violation = v.message;
  }
  for (const [id, unit] of units) {
    unit.up = up.get(id)?.size ?? 0;
    unit.down = down.get(id)?.size ?? 0;
  }

  const groups = Map.groupBy([...units.values()], (u) => group.get(u.id) ?? '');
  return {
    layer,
    groups: [...groups]
      .map(([name, list]) => ({ name, units: list.sort((x, y) => x.label.localeCompare(y.label)) }))
      .sort((x, y) => x.name.localeCompare(y.name)),
    edges: [...inner.values()],
  };
}

// Функциите на ниво модул са една единица на файл; класовете са сами.
function unitOf(n: Node): string {
  return n.kind === 'function' ? `file:${n.location.file}` : n.id;
}

function newUnit(n: Node, id: string): Unit {
  const isFile = id.startsWith('file:');
  return {
    id,
    label: isFile ? posix.basename(n.location.file).replace(/\.[^.]+$/, '') : n.name,
    role: roleOf(n, false),
    file: n.location.file,
    line: isFile ? 1 : n.location.line,
    members: [],
    up: 0,
    down: 0,
    violations: [],
  };
}

function rank(order: string[], layer: string): number {
  const i = order.indexOf(layer);
  return i < 0 ? order.length : i;
}
