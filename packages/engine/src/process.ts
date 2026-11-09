import type { Member, Node, TypeRef } from '@archgraph/model';
import { typeText, type GraphQuery, type Target } from './query.ts';

// Изгледът „процес“ за интерфейса: една верига от ендпойнт (или метод) отляво надясно.
// Само нодовете и методите, които участват, а не целият граф.

export interface ProcessView {
  title: string;
  nodes: ProcessNode[];
  edges: ProcessEdge[];
}

export interface ProcessNode {
  id: string;
  name: string;
  kind: string;
  role: string; // от правилата (етап 6) или временна по име
  layer?: string; // от architecture.yaml или от каталога на ролите
  file: string;
  line: number;
  column: number; // дълбочина във веригата; имплементацията е в колоната на договора
  language: string;
  tags: string[]; // abstract, final, readonly, duplicate
  bases: { kind: 'extends' | 'implements'; name: string }[];
  members: ProcessMember[]; // методите, които участват в процеса
  others: ProcessMember[]; // останалите методи, свити под „още N“
  deps: Slot[]; // инжектирани зависимости (параметри на конструктора с тип от проекта)
  fields: Slot[]; // собствените полета без зависимостите
  usedBy: Usage[]; // кой ползва класа в целия проект (извиква, инжектира, създава, наследява)
  violations: string[]; // нарушенията на архитектурата, в които участва (етап 7)
}

export interface ProcessMember {
  name: string;
  line: number;
  visibility: string;
  static: boolean;
  async: boolean;
  inputs: Slot[];
  output?: Slot;
  unresolved: { name: string; line: number }[]; // извиквания, които графът не може да свърже (D-011)
}

export interface Usage {
  kind: string;
  label: string;
  file: string;
  line: number;
}

// Порт или поле. `fields` е структурата на DTO типа, за разгъване с ▸ (едно ниво).
export interface Slot {
  name: string;
  type: string;
  kind: 'primitive' | 'dto' | 'entity' | 'contract' | 'class' | 'collection' | 'external' | 'unknown';
  optional?: boolean;
  fields?: Slot[];
}

export interface ProcessEdge {
  id: string;
  kind: 'routes-to' | 'calls' | 'creates' | 'renders' | 'implements' | 'maybe';
  from: { node: string; member?: string };
  to: { node: string; member?: string };
  inferred: boolean;
  violation?: string; // зависимостта е извън `allow` между слоеве или контексти
}

const ARROWS: Record<string, ProcessEdge['kind']> = {
  '⇢ ': 'routes-to',
  '→ ': 'calls',
  '→? ': 'calls',
  'new ': 'creates',
  '▭ ': 'renders',
  '⇒ ': 'implements',
  '?? ': 'maybe',
};

// `start` може да е и няколко начала (ghost нодовете на шаблон): всички са в първата колона.
export function processView(query: GraphQuery, start: Target | Target[], depth: number): ProcessView {
  const starts = Array.isArray(start) ? start : [start];
  const { graph } = query;
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  const nodes = new Map<string, ProcessNode>();
  const edges = new Map<string, ProcessEdge>();

  const visit = (t: Target, column: number) => {
    const node = nodes.get(t.node.id) ?? addNode(t.node, column);
    if (t.member && !node.members.some((m) => m.name === t.member?.name)) node.members.push(member(t.member));
  };
  const addNode = (n: Node, column: number): ProcessNode => {
    const view: ProcessNode = {
      id: n.id,
      name: n.name,
      kind: n.kind,
      role: roleOf(n, graph.types[n.id] !== undefined),
      ...(n.layer ? { layer: n.layer } : {}),
      file: n.location.file,
      line: n.location.line,
      column,
      language: n.language,
      tags: n.tags ?? [],
      bases: graph.edges
        .filter((e) => (e.kind === 'extends' || e.kind === 'implements') && e.from.node === n.id)
        .map((e) => ({ kind: e.kind as 'extends' | 'implements', name: byId.get(e.to.node)?.name ?? e.to.node })),
      members: [],
      others: [],
      deps: deps(n),
      fields: [],
      usedBy: usedBy(n),
      violations: (graph.violations ?? []).filter((v) => v.nodes.includes(n.id)).map((v) => v.message),
    };
    nodes.set(n.id, view);
    return view;
  };
  const member = (m: Member): ProcessMember => {
    const view: ProcessMember = {
      name: m.name,
      line: m.location.line,
      visibility: m.visibility,
      static: m.static ?? false,
      async: m.async ?? false,
      inputs: m.inputs.map((p) => slot(p.name, p.type, p.optional)),
      unresolved: (unresolved.get(`${owner(m)}#${m.name}`) ?? []).map((u) => ({ name: u.name, line: u.line })),
    };
    if (m.output) view.output = slot('', m.output.type);
    return view;
  };
  const slot = (name: string, type: TypeRef, optional?: boolean, nested = true): Slot => {
    const s: Slot = { name, type: typeText(type, byId), kind: slotKind(type, (id) => kindOf(id)) };
    if (optional) s.optional = true;
    const shape = nested ? graph.types[dataId(type) ?? ''] : undefined;
    if (shape && byId.get(shape.nodeId ?? '')?.kind !== 'interface')
      s.fields = shape.fields.map((f) => slot(f.name, f.type, f.optional, false));
    return s;
  };
  const deps = (n: Node): Slot[] =>
    graph.edges
      .filter((e) => e.kind === 'injects' && e.to.node === n.id)
      .map((e) => ({
        name: e.to.port ?? '',
        type: byId.get(e.from.node)?.name ?? e.from.node,
        kind: kindOf(e.from.node),
      }));
  const unresolved = Map.groupBy(graph.unresolved ?? [], (u) => `${u.from.node}#${u.from.member}`);
  const owners = new Map(graph.nodes.flatMap((n) => n.members.map((m) => [m, n.id] as const)));
  const owner = (m: Member) => owners.get(m) ?? '';
  // Кой ползва класа в целия проект, не само в процеса. Връзките вътре в класа не се броят.
  const usedBy = (n: Node): Usage[] => {
    const seen = new Map<string, Usage>();
    for (const e of graph.edges) {
      // injects е от инжектирания тип към потребителя, останалите са от потребителя към класа
      const [user, used] = e.kind === 'injects' ? [e.to, e.from] : [e.from, e.to];
      if (used.node !== n.id || user.node === n.id) continue;
      if (!['calls', 'creates', 'injects', 'extends', 'implements', 'routes-to'].includes(e.kind)) continue;
      const from = byId.get(user.node);
      const m = from?.members.find((x) => x.name === user.member);
      if (!from) continue;
      const label = m && m.name !== from.name ? `${from.name}#${m.name}` : from.name;
      const loc = m?.location ?? from.location;
      seen.set(`${e.kind} ${label}`, { kind: e.kind, label, file: loc.file, line: loc.line });
    }
    return [...seen.values()];
  };
  // Цветът на порт с тип от проекта идва от ролята на типа (договор, DTO, entity).
  const kindOf = (id: string): Slot['kind'] => {
    const n = byId.get(id);
    if (!n) return 'external';
    const role = roleOf(n, graph.types[id] !== undefined);
    return role === 'interface' ? 'contract' : role === 'dto' || role === 'entity' ? role : 'class';
  };

  // Обхождане в ширина: колоната е първата дълбочина, на която нодът се среща.
  const seen = new Set<string>();
  // `entry` е клас, който е начало на процеса (избран или сочен от route): тръгва се от всеки негов
  // метод. Клас, стигнат с `new X`, не се разгъва, защото процесът не минава през всичките му методи.
  let level: [Target, number, boolean][] = starts.map((s) => [s, 0, true]);
  for (let d = 0; d <= depth && level.length; d++) {
    const next: [Target, number, boolean][] = [];
    for (const [t, column, entry] of level) {
      visit(t, column);
      const key = `${t.node.id}#${t.member?.name ?? ''}`;
      if (seen.has(key) || d === depth) continue;
      seen.add(key);
      if (entry && !t.member && t.node.kind !== 'route') {
        for (const member of t.node.members) next.push([{ node: t.node, member }, column, false]);
        continue;
      }
      const children = t.node.kind === 'route' ? query.handlers(t.node) : query.callees(t);
      for (const [child, arrow] of children) {
        const kind = ARROWS[arrow] ?? 'calls';
        const from = { node: t.node.id, ...(t.member ? { member: t.member.name } : {}) };
        const to = { node: child.node.id, ...(child.member ? { member: child.member.name } : {}) };
        const id = `${kind}:${from.node}#${from.member ?? ''}->${to.node}#${to.member ?? ''}`;
        edges.set(id, { id, kind, from, to, inferred: arrow === '→? ' || arrow === '?? ' });
        // Имплементацията стои под договора си, а не колона по-надясно.
        next.push([child, kind === 'implements' ? column : column + 1, kind === 'routes-to']);
      }
    }
    level = next;
  }

  // Това, към което сочи route, е controller, каквото и да е по име (FastAPI функция, Mezzio handler).
  for (const e of edges.values())
    if (e.kind === 'routes-to') {
      const handler = nodes.get(e.to.node);
      if (handler && !byId.get(handler.id)?.role) handler.role = 'controller';
    }
  for (const n of nodes.values()) {
    const deps = new Set(n.deps.map((d) => d.name));
    n.fields = (graph.types[n.id]?.fields ?? [])
      .filter((f) => !deps.has(f.name))
      .map((f) => slot(f.name, f.type, f.optional));
    const shown = new Set(n.members.map((m) => m.name));
    n.others = (byId.get(n.id)?.members ?? []).filter((m) => !shown.has(m.name)).map(member);
  }
  // Проводник между два нода с нарушение на слой или контекст се оцветява.
  for (const v of graph.violations ?? []) {
    if (v.kind !== 'layer' && v.kind !== 'context') continue;
    const [a, b] = v.nodes;
    for (const e of edges.values()) if (e.from.node === a && e.to.node === b) e.violation = v.message;
  }
  const [first] = starts;
  const startName = !first ? '' : first.member ? `${first.node.name}#${first.member.name}` : first.node.name;
  return { title: startName, nodes: [...nodes.values()], edges: [...edges.values()] };
}

function dataId(t: TypeRef): string | undefined {
  if (t.kind === 'named') return t.id;
  if (t.kind === 'array') return dataId(t.of);
  if (t.kind === 'union') return t.of.map(dataId).find(Boolean);
  return undefined;
}

function slotKind(t: TypeRef, kindOf: (id: string) => Slot['kind']): Slot['kind'] {
  switch (t.kind) {
    case 'primitive':
      return 'primitive';
    case 'named':
      return kindOf(t.id);
    case 'array':
    case 'map':
      return 'collection';
    case 'union': {
      const kinds = t.of.map((x) => slotKind(x, kindOf)).filter((k) => k !== 'primitive');
      return kinds[0] ?? 'primitive';
    }
    case 'shape':
      return 'collection';
    default:
      return 'unknown';
  }
}

// Роля за проекти без правила за framework: по вида, името и мястото.
export function roleOf(n: Node, hasFields: boolean): string {
  if (n.role) return n.role;
  if (n.kind === 'route' || n.kind === 'interface' || n.kind === 'function' || n.kind === 'enum') return n.kind;
  // Правилата на framework-а са минали и не са дали роля: без отгатване по име.
  if (n.framework) return 'class';
  const rules: [RegExp, string][] = [
    [/(Controller|Handler|Action|Resource)$/, 'controller'],
    [/Repository$/, 'repository'],
    [/Factory$/, 'factory'],
    [/(Service|Calculator|Manager|Policy|Provider)$/, 'service'],
    [/(Dto|DTO|Request|Response|Input|Output|In|Out|View|Command|Query)$/, 'dto'],
  ];
  for (const [re, role] of rules) if (re.test(n.name)) return role;
  // entity/Order.php, models.py, order.entity.ts
  if (/(^|\/)(entity|entities|model|models|domain)(\/|\.py$)|\.entity\.[jt]s$/i.test(n.location.file) && hasFields)
    return 'entity';
  return 'class';
}
