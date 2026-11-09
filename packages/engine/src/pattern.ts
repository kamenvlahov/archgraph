import { existsSync, readFileSync } from 'node:fs';
import { extname, join, posix } from 'node:path';
import { edge, type Edge, type GraphModel, type Member, type Node, type Port, type TypeRef } from '@archgraph/model';
import { DEFAULT_EXCLUDES, listFiles } from './files.ts';
import { processView, type ProcessView } from './process.ts';
import { GraphQuery, signature, type Target } from './query.ts';

// Шаблон „като този“ (етап 8): нов клас по образеца на съществуващ в проекта. От графа се взима
// образецът и свързаното с него, което носи същото име (интерфейс, фабрика, repository, entity, route,
// тестове). Името се сменя навсякъде и резултатът са ghost нодове с таг `ghost`, които още ги няма
// в кода. Редовете за регистрация (DI, route-ове) се търсят в целия проект като образец за новите.
// Archgraph не пише код (D-005): изходът е изглед и план.

export interface PatternResult {
  from: string; // думата в образеца: Order, payment
  to: string; // новата: Invoice, invoice
  ghosts: {
    id: string;
    name: string;
    role?: string;
    layer?: string;
    file: string;
    example: string;
    exampleFile: string;
    members: string[]; // сигнатурите след смяната на имената
  }[];
  registrations: { file: string; line: number; text: string; suggested: string }[];
  view: ProcessView;
}

const MAX_SLICE = 20;
const SUFFIXES =
  /(_?(services?|repository|repositories|handler|controller|factory|interface|routes?|dto|manager|provider|policy|calculator))+$/i;
const DEPEND_KINDS = ['calls', 'creates', 'injects', 'implements', 'extends', 'binds', 'routes-to'];
const TEXT = ['.php', '.ts', '.js', '.py', '.yaml', '.yml'];

export function pattern(graph: GraphModel, example: Target, to: string, from?: string): PatternResult {
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  // Функция в модул (Python services.py) е образец заедно с целия си файл.
  const seeds =
    example.node.kind === 'function'
      ? graph.nodes.filter((n) => n.kind === 'function' && n.location.file === example.node.location.file)
      : [example.node];
  const stem = from ?? stemOf(example.node);
  if (!stem) throw new Error(`не мога да намеря думата за смяна в „${example.node.name}“; подай from`);
  const rename = renamer(stem, to);
  // по името (при функциите — файла), не по пътя: `src/Order/Service/PriceCalculator` не е част от Order
  const label = (n: Node) => (n.kind === 'function' ? posix.basename(n.location.file) : n.name);
  const mentions = (n: Node) => rename(label(n)) !== label(n);

  // Образецът и съседите му (до две стъпки), които носят същото име.
  const slice = new Map(seeds.map((n) => [n.id, n]));
  for (let hop = 0; hop < 2; hop++)
    for (const e of graph.edges) {
      if (!DEPEND_KINDS.includes(e.kind)) continue;
      for (const [a, b] of [
        [e.from.node, e.to.node],
        [e.to.node, e.from.node],
      ] as const) {
        const other = byId.get(b);
        if (slice.has(a) && other && !slice.has(b) && slice.size < MAX_SLICE && mentions(other)) slice.set(b, other);
      }
    }

  // Ghost нодовете: новите имена, файлове и сигнатури. Ако такъв нод вече има, той е истински.
  const ids = new Map([...slice.keys()].map((id) => [id, rename(id)]));
  const ghosts: Node[] = [];
  const result: PatternResult['ghosts'] = [];
  for (const n of slice.values()) {
    const id = ids.get(n.id) ?? n.id;
    if (byId.has(id) || id === n.id) continue;
    const ghost: Node = {
      ...n,
      id,
      name: rename(n.name),
      location: { ...n.location, file: rename(n.location.file) },
      members: n.members.map((m) => renameMember(m, rename, ids)),
      tags: [...(n.tags ?? []).filter((t) => t !== 'duplicate'), 'ghost'],
    };
    ghosts.push(ghost);
    result.push({
      id,
      name: ghost.name,
      ...(n.role ? { role: n.role } : {}),
      ...(n.layer ? { layer: n.layer } : {}),
      file: ghost.location.file,
      example: n.name,
      exampleFile: n.location.file,
      members: [],
    });
  }
  const ghostIds = new Set(ghosts.map((g) => g.id));
  const ghostEdges: Edge[] = graph.edges.flatMap((e) => {
    if (!slice.has(e.from.node) && !slice.has(e.to.node)) return [];
    const end = (x: Edge['from']) => {
      const id = ids.get(x.node) ?? x.node;
      return {
        node: id,
        ...(x.member ? { member: slice.has(x.node) ? rename(x.member) : x.member } : {}),
        ...(x.port ? { port: x.port } : {}),
      };
    };
    const from = end(e.from);
    const to = end(e.to);
    // само ребра, които водят до нов нод (останалото го има в графа)
    if (!ghostIds.has(from.node) && !ghostIds.has(to.node)) return [];
    return [{ ...edge(e.kind, from, to, e.confidence), ...(e.location ? { location: e.location } : {}) }];
  });

  const types = { ...graph.types };
  for (const [old, id] of ids)
    if (ghostIds.has(id) && graph.types[old])
      types[id] = {
        ...graph.types[old],
        id,
        name: rename(graph.types[old].name),
        nodeId: id,
        fields: graph.types[old].fields.map((f) => ({ ...f, type: renameType(f.type, ids) })),
      };

  const merged: GraphModel = {
    ...graph,
    nodes: [...graph.nodes, ...ghosts],
    edges: [...graph.edges, ...ghostEdges],
    types,
  };
  const query = new GraphQuery(merged);
  // Началата на изгледа: новите нодове, към които не води друг нов нод (route, фабрика, образецът).
  const reached = new Set(ghostEdges.filter((e) => ghostIds.has(e.from.node)).map((e) => e.to.node));
  const roots = ghosts.filter((g) => !reached.has(g.id));
  const starts = (roots.length ? roots : ghosts).map((node): Target => ({ node }));
  const all = new Map(merged.nodes.map((n) => [n.id, n]));
  for (const g of result) g.members = (all.get(g.id)?.members ?? []).map((m) => signature(m, all));
  const view = starts.length ? processView(query, starts, 4) : { title: '', nodes: [], edges: [] };
  view.title = `${to} като ${example.node.name}`;

  return {
    from: stem,
    to,
    ghosts: result,
    registrations: registrations(graph.root, [...slice.values()], rename),
    view,
  };
}

// Думата за смяна: името на образеца без ролевите окончания (OrderService → Order,
// payment_services → payment).
function stemOf(n: Node): string {
  const base = n.kind === 'function' ? posix.basename(n.location.file).replace(/\.[^.]+$/, '') : n.name;
  return base.replace(SUFFIXES, '');
}

// Смяна на думата във всичките ѝ форми: Order/order/ORDER, orders, order_item, OrderItem.
export function renamer(from: string, to: string): (s: string) => string {
  const words = (s: string) =>
    s
      .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
      .split(/[\s_\-.]+/)
      .filter(Boolean)
      .map((w) => w.toLowerCase());
  const forms = (w: string[]) => {
    const cap = (x: string) => x.charAt(0).toUpperCase() + x.slice(1);
    const pascal = w.map(cap).join('');
    const camel = (w[0] ?? '') + w.slice(1).map(cap).join('');
    const snake = w.join('_');
    // при съвпадащи форми печели първата: snake преди camel (Python, файлове), kebab последна
    return [pascal, snake, camel, w.join('-'), snake.toUpperCase()];
  };
  const plural = (w: string[]) => {
    const last = w.at(-1) ?? '';
    const p = /[^aeiou]y$/.test(last)
      ? `${last.slice(0, -1)}ies`
      : /(s|x|ch|sh)$/.test(last)
        ? `${last}es`
        : `${last}s`;
    return [...w.slice(0, -1), p];
  };
  const a = words(from);
  const b = words(to);
  // множественото число е първо в алтернативите: `orders` трябва да стане `invoices`, а не `invoice` + `s`
  const pairs = [...zip(forms(plural(a)), forms(plural(b))), ...zip(forms(a), forms(b))].filter(([x]) => x);
  const unique = pairs.filter(([x], i) => pairs.findIndex(([y]) => y === x) === i);
  const re = new RegExp(unique.map(([x]) => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|'), 'g');
  const map = new Map(unique);
  return (s) => s.replace(re, (m) => map.get(m) ?? m);
}

function zip(a: string[], b: string[]): [string, string][] {
  return a.map((x, i) => [x, b[i] ?? x]);
}

function renameMember(m: Member, rename: (s: string) => string, ids: Map<string, string>): Member {
  const port = (p: Port): Port => ({ ...p, name: rename(p.name), type: renameType(p.type, ids) });
  return {
    ...m,
    name: rename(m.name),
    inputs: m.inputs.map(port),
    ...(m.output ? { output: port(m.output) } : {}),
  };
}

function renameType(t: TypeRef, ids: Map<string, string>): TypeRef {
  switch (t.kind) {
    case 'named':
      return { ...t, id: ids.get(t.id) ?? t.id, ...(t.args ? { args: t.args.map((a) => renameType(a, ids)) } : {}) };
    case 'array':
      return { ...t, of: renameType(t.of, ids) };
    case 'map':
      return { ...t, key: renameType(t.key, ids), value: renameType(t.value, ids) };
    case 'union':
      return { ...t, of: t.of.map((x) => renameType(x, ids)) };
    default:
      return t;
  }
}

// Редовете в други файлове, които споменават образеца (DI регистрация, route-ове, include_router,
// Angular routes, импорти в тях): новият клас има нужда от същите. Само цяла дума и не в самите
// файлове на образеца.
function registrations(root: string, slice: Node[], rename: (s: string) => string): PatternResult['registrations'] {
  const own = new Set(slice.map((n) => n.location.file));
  const names = [
    ...new Set(
      slice.map((n) => (n.kind === 'function' ? posix.basename(n.location.file).replace(/\.[^.]+$/, '') : n.name)),
    ),
  ];
  if (!names.length) return [];
  const re = new RegExp(`\\b(${names.map((x) => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})\\b`);
  const found: PatternResult['registrations'] = [];
  for (const file of listFiles(root, DEFAULT_EXCLUDES)) {
    if (own.has(file) || !TEXT.includes(extname(file)) || /(^|\/)(tests?|__tests__)\//.test(file)) continue;
    const path = join(root, file);
    if (!existsSync(path)) continue;
    readFileSync(path, 'utf8')
      .split('\n')
      .forEach((text, i) => {
        // `namespace App\Order\…` в друг файл е мястото на файла, не регистрация
        if (found.length < 40 && re.test(text) && !/^\s*(namespace|package)\b/.test(text))
          found.push({ file, line: i + 1, text: text.trim(), suggested: rename(text.trim()) });
      });
  }
  return found;
}
