import type { Edge, GraphModel, Location, Member, Node, TypeRef, UnresolvedCall } from '@archgraph/model';

// Заявки върху готов граф: за MCP сървъра и по-късно за интерфейса. Отговорите са кратък текст
// с `file:line`, защото основният потребител е агент, който ще отвори точно тези места.

export interface Target {
  node: Node;
  member?: Member;
}

export class GraphQuery {
  readonly graph: GraphModel;
  private readonly byId: Map<string, Node>;
  private readonly out: Map<string, Edge[]>;
  private readonly in: Map<string, Edge[]>;
  // Извикванията без ребро (D-011): по име на извиквания член и по извикващия.
  private readonly unresolvedTo: Map<string, UnresolvedCall[]>;
  private readonly unresolvedFrom: Map<string, UnresolvedCall[]>;
  private readonly membersByName: Map<string, Target[]>;

  constructor(graph: GraphModel) {
    this.graph = graph;
    this.byId = new Map(graph.nodes.map((n) => [n.id, n]));
    this.out = Map.groupBy(graph.edges, (e) => e.from.node);
    this.in = Map.groupBy(graph.edges, (e) => e.to.node);
    const unresolved = graph.unresolved ?? [];
    this.unresolvedTo = Map.groupBy(unresolved, (u) => u.name);
    this.unresolvedFrom = Map.groupBy(unresolved, (u) => `${u.from.node}#${u.from.member}`);
    this.membersByName = Map.groupBy(
      graph.nodes.flatMap((node) => node.members.map((member) => ({ node, member }))),
      (t) => t.member.name,
    );
  }

  // `OrdersService#place`, `OrderService::place`, `OrderService.place`, пълно id или само име.
  // Връща всички съвпадения: при повече от едно извикващият показва избор.
  find(query: string): Target[] {
    const exact = this.byId.get(query);
    if (exact) return [{ node: exact }];
    const m = /^(.+?)(?:#|::|->|\.)([A-Za-z_$][\w$]*)$/.exec(query);
    const targets: Target[] = [];
    if (m) {
      const [, owner = '', member = ''] = m;
      for (const node of this.named(owner)) {
        const found = node.members.find((x) => x.name === member);
        if (found) targets.push({ node, member: found });
      }
    }
    if (targets.length > 0) return targets;
    // Функцията е нод с един член със същото име: заявката е за члена.
    return this.named(query).map((node) =>
      node.kind === 'function' && node.members[0] ? { node, member: node.members[0] } : { node },
    );
  }

  private named(name: string): Node[] {
    const byId = this.byId.get(name);
    if (byId) return [byId];
    return this.graph.nodes.filter((n) => n.name === name || n.id.endsWith(`\\${name}`) || n.id.endsWith(`.${name}`));
  }

  // Веригата от метод надолу (кого вика) или нагоре (кой го вика) до дълбочина `depth`.
  // Надолу през интерфейс се показват и имплементациите (`⇒`), иначе веригата спира на договора.
  trace(start: Target, direction: 'down' | 'up', depth: number): string {
    const lines: string[] = [];
    const seen = new Set<string>();
    const walk = (t: Target, level: number, arrow: string) => {
      const key = targetId(t);
      const repeated = seen.has(key);
      lines.push(`${'  '.repeat(level)}${arrow}${label(t)}  ${where(t)}${repeated ? '  (вече показан)' : ''}`);
      if (repeated || level >= depth) return;
      seen.add(key);
      // Начало от клас надолу: веригата тръгва от всеки негов метод.
      const methods: [Target, string][] = t.node.members.map((member) => [{ node: t.node, member }, '· ']);
      const next = direction === 'up' ? this.callers(t) : level === 0 && !t.member ? methods : this.callees(t);
      for (const [n, a] of next) walk(n, level + 1, a);
      if (direction === 'down' && t.member)
        for (const note of this.unknownCallees(t)) lines.push(`${'  '.repeat(level + 1)}${note}`);
    };
    walk(start, 0, '');
    return lines.join('\n');
  }

  private callees(t: Target): [Target, string][] {
    if (!t.member) return [];
    const result: [Target, string][] = [];
    for (const e of this.out.get(t.node.id) ?? []) {
      if (e.from.member !== t.member.name) continue;
      const to = this.target(e.to.node, e.to.member);
      if (!to) continue;
      if (e.kind === 'calls') result.push([to, e.confidence === 'exact' ? '→ ' : '→? ']);
      else if (e.kind === 'creates') result.push([to, 'new ']);
    }
    // Неразрешено извикване с един кандидат по име: показва се като възможно продължение.
    for (const u of this.unresolvedFrom.get(targetId(t)) ?? []) {
      const candidates = this.candidates(u.name);
      if (candidates.length === 1) result.push([candidates[0] as Target, '?? ']);
    }
    // Интерфейсен метод: имплементациите (или това, което DI реално дава, ако има `binds`).
    if (t.node.kind === 'interface')
      for (const impl of this.implementations(t.node)) {
        const m = impl.members.find((x) => x.name === t.member?.name);
        if (m) result.push([{ node: impl, member: m }, '⇒ ']);
      }
    return result;
  }

  callers(t: Target): [Target, string][] {
    const result: [Target, string][] = [];
    const add = (node: Node, member: string | undefined) => {
      for (const e of this.in.get(node.id) ?? []) {
        if (e.kind !== 'calls' && e.kind !== 'creates') continue;
        if (member !== undefined && e.to.member !== member) continue;
        const from = this.target(e.from.node, e.from.member);
        if (from) result.push([from, e.kind === 'creates' ? 'new ← ' : '← ']);
      }
    };
    add(t.node, t.member?.name);
    // Извикванията сочат договора, затова за имплементация се търсят и извикванията на интерфейса.
    if (t.member)
      for (const contract of this.contracts(t.node))
        if (contract.members.some((m) => m.name === t.member?.name)) add(contract, t.member.name);
    // Възможни извикващи: извикване със същото име, чийто получател не е известен.
    const known = new Set(result.map(([from]) => targetId(from)));
    for (const [from] of this.possibleCallers(t)) if (!known.has(targetId(from))) result.push([from, '?? ← ']);
    return result;
  }

  // Извикванията със същото име като члена, които графът не можа да свърже, с реда на извикването.
  possibleCallers(t: Target): [Target, Location][] {
    if (!t.member) return [];
    return (this.unresolvedTo.get(t.member.name) ?? []).flatMap((u): [Target, Location][] => {
      const from = this.target(u.from.node, u.from.member);
      return from ? [[from, { file: from.node.location.file, line: u.line, endLine: u.line }]] : [];
    });
  }

  // Членовете с това име. Имплементация на друг кандидат не е отделна възможност: остава договорът.
  private candidates(name: string): Target[] {
    const all = this.membersByName.get(name) ?? [];
    const ids = new Set(all.map((c) => c.node.id));
    return all.filter((c) => !this.contracts(c.node).some((p) => ids.has(p.id)));
  }

  // Бележки за неразрешените извиквания от член с повече от един кандидат.
  private unknownCallees(t: Target): string[] {
    return (this.unresolvedFrom.get(targetId(t)) ?? []).flatMap((u) => {
      const candidates = this.candidates(u.name);
      if (candidates.length < 2) return [];
      const names = candidates.length <= MAX_CANDIDATES ? `: ${candidates.map(label).join(', ')}` : '';
      return [`?? ${u.name}()  :${u.line}  (получателят е неизвестен, ${candidates.length} члена с това име${names})`];
    });
  }

  private implementations(iface: Node): Node[] {
    const bound = (this.out.get(iface.id) ?? []).filter((e) => e.kind === 'binds').map((e) => e.to.node);
    const ids =
      bound.length > 0
        ? bound
        : (this.in.get(iface.id) ?? []).filter((e) => e.kind === 'implements').map((e) => e.from.node);
    return [...new Set(ids)].flatMap((id) => this.byId.get(id) ?? []);
  }

  private contracts(node: Node): Node[] {
    return (this.out.get(node.id) ?? [])
      .filter((e) => e.kind === 'implements' || e.kind === 'extends')
      .flatMap((e) => this.byId.get(e.to.node) ?? []);
  }

  // Кой зависи от нода: извиквания, инжекции, наследяване, създаване и портове с този тип.
  dependents(node: Node): string {
    const groups = new Map<string, Set<string>>();
    const add = (kind: string, t: Target | undefined) => {
      if (t) groups.set(kind, (groups.get(kind) ?? new Set()).add(`${label(t)}  ${where(t)}`));
    };
    for (const e of this.in.get(node.id) ?? [])
      add(e.kind === 'calls' && e.to.member ? `calls ${e.to.member}` : e.kind, this.target(e.from.node, e.from.member));
    for (const n of this.graph.nodes)
      for (const m of n.members) {
        const ports = [...m.inputs, ...(m.output ? [m.output] : [])];
        if (ports.some((p) => mentions(p.type, node.id))) add('uses-type', { node: n, member: m });
      }
    const kind = 'може би (извикване по име, получателят е неизвестен; провери в кода)';
    for (const member of node.members)
      for (const [from, at] of this.possibleCallers({ node, member }))
        groups.set(kind, (groups.get(kind) ?? new Set()).add(`${member.name} ← ${label(from)}  ${loc(at)}`));
    if (groups.size === 0) return `${label({ node })}: никой не зависи от него`;
    return [...groups]
      .map(([kind, items]) => `${kind} (${items.size}):\n${[...items].map((i) => `  ${i}`).join('\n')}`)
      .join('\n');
  }

  // Кратко описание: вид, място, наследяване, сигнатури, полета и зависимости.
  describe(t: Target): string {
    const { node } = t;
    const meta = [node.kind, node.role, node.framework, ...(node.tags ?? [])].filter(Boolean).join(', ');
    const lines = [`${node.name}  (${meta})  ${loc(node.location)}`, `id: ${node.id}`];
    const rel = (kind: string) =>
      (this.out.get(node.id) ?? [])
        .filter((e) => e.kind === kind)
        .map((e) => this.byId.get(e.to.node)?.name ?? e.to.node);
    for (const kind of ['extends', 'implements']) if (rel(kind).length) lines.push(`${kind} ${rel(kind).join(', ')}`);
    const members = t.member ? [t.member] : node.members;
    if (members.length) lines.push('', ...members.map((m) => `${signature(m, this.byId)}  :${m.location.line}`));
    const fields = this.graph.types[node.id]?.fields ?? [];
    if (fields.length && !t.member)
      lines.push(
        '',
        'полета:',
        ...fields.map((f) => `  ${f.name}${f.optional ? '?' : ''}: ${typeText(f.type, this.byId)}`),
      );
    // injects е от инжектирания тип към порта на конструктора.
    const receives = (this.in.get(node.id) ?? []).filter((e) => e.kind === 'injects');
    const givenTo = (this.out.get(node.id) ?? []).filter((e) => e.kind === 'injects');
    if (receives.length)
      lines.push('', `получава: ${receives.map((e) => this.byId.get(e.from.node)?.name).join(', ')}`);
    if (givenTo.length) lines.push(`инжектиран в: ${givenTo.map((e) => this.byId.get(e.to.node)?.name).join(', ')}`);
    const unknown = members.flatMap((m) => this.unresolvedFrom.get(targetId({ node, member: m })) ?? []);
    if (unknown.length)
      lines.push(
        '',
        `неразрешени извиквания (${unknown.length}): ${unknown.map((u) => `${u.name}() :${u.line}`).join(', ')}`,
      );
    return lines.join('\n');
  }

  // По роля (от правилата, етап 6), вид (`class`, `interface`) или таг (`abstract`).
  findBy(value: string): Node[] {
    return this.graph.nodes.filter((n) => n.role === value || n.kind === value || n.tags?.includes(value));
  }

  private target(id: string, member?: string): Target | undefined {
    const node = this.byId.get(id);
    if (!node) return undefined;
    const m = member === undefined ? undefined : node.members.find((x) => x.name === member);
    return m ? { node, member: m } : { node };
  }
}

// Над толкова кандидати по име (`get`, `update`) бележката в trace дава само броя.
const MAX_CANDIDATES = 3;

export function label(t: Target): string {
  if (!t.member || (t.node.kind === 'function' && t.member.name === t.node.name)) return t.node.name;
  return `${t.node.name}#${t.member.name}`;
}

export function where(t: Target): string {
  return loc(t.member?.location ?? t.node.location);
}

function loc(l: Location): string {
  return `${l.file}:${l.line}`;
}

function targetId(t: Target): string {
  return `${t.node.id}#${t.member?.name ?? ''}`;
}

function mentions(t: TypeRef, id: string): boolean {
  switch (t.kind) {
    case 'named':
      return t.id === id || (t.args ?? []).some((a) => mentions(a, id));
    case 'array':
      return mentions(t.of, id);
    case 'map':
      return mentions(t.key, id) || mentions(t.value, id);
    case 'union':
      return t.of.some((x) => mentions(x, id));
    case 'shape':
      return t.fields.some((f) => mentions(f.type, id));
    default:
      return false;
  }
}

export function signature(m: Member, byId: Map<string, Node>): string {
  const inputs = m.inputs
    .map((p) => `${p.variadic ? '...' : ''}${p.name}${p.optional ? '?' : ''}: ${typeText(p.type, byId)}`)
    .join(', ');
  const output = m.output ? `: ${typeText(m.output.type, byId)}` : '';
  const mods = [m.visibility !== 'public' ? m.visibility : '', m.static ? 'static' : '', m.async ? 'async' : '']
    .filter(Boolean)
    .join(' ');
  return `${mods ? `${mods} ` : ''}${m.name}(${inputs})${output}`;
}

// Типът като кратък текст. Имената на нодове от проекта са без пакета.
export function typeText(t: TypeRef, byId: Map<string, Node>): string {
  switch (t.kind) {
    case 'primitive':
      return t.name;
    case 'named': {
      const name = byId.get(t.id)?.name ?? t.id.replace(/^[a-z]+:/, '');
      return t.args?.length ? `${name}<${t.args.map((a) => typeText(a, byId)).join(', ')}>` : name;
    }
    case 'array':
      return `${typeText(t.of, byId)}[]`;
    case 'map':
      return `map<${typeText(t.key, byId)}, ${typeText(t.value, byId)}>`;
    case 'union':
      return t.of.map((x) => typeText(x, byId)).join(' | ');
    case 'shape':
      return `{${t.fields.map((f) => `${f.name}${f.optional ? '?' : ''}: ${typeText(f.type, byId)}`).join(', ')}}`;
    default:
      return '?';
  }
}
