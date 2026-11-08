import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { label, signature, typeText, where, type GraphQuery, type Target } from '@archgraph/engine';
import type { Edge, Member, Node, TypeRef } from '@archgraph/model';

// Маркирани нодове + задача → Markdown план за AI агент. Планът е детерминистичен: не измисля
// решение, а събира всичко, което агентът иначе би търсил из проекта: кода на засегнатите методи,
// кой ги вика, как са свързани класовете (образец за нови) и в какъв ред да се променят.

const MAX_SOURCE_LINES = 60;

export function plan(query: GraphQuery, task: string, targets: Target[]): string {
  const { graph } = query;
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  const nodes = [...new Map(targets.map((t) => [t.node.id, t.node])).values()];
  const lines = [`# План: ${task}`, '', `Проект: \`${graph.root}\``, ''];

  const headers = fileHeaders(graph.root, nodes);
  if (headers.length)
    lines.push(
      '## Началото на файловете',
      '',
      'Namespace, импорти и конвенции; нов клас до тях започва по същия начин.',
      '',
      ...headers,
    );
  lines.push('## Засегнати', '');
  for (const t of targets) lines.push(...affected(query, t, byId), '');

  const wiring = nodes
    .map((n) => wiringOf(graph.root, n, graph.edges, byId))
    .filter((w) => w.length)
    .flatMap((w, i) => (i ? ['', ...w] : w));
  if (wiring.length)
    lines.push('## Как са свързани', '', 'Нов клас от същия вид се свързва по същия начин.', '', ...wiring, '');

  const shapes = dataTypes(targets, query);
  if (shapes.length) lines.push('## Типове в сигнатурите', '', ...shapes, '');

  // нарушенията, в които участват засегнатите: промяната не бива да ги задълбочава
  const broken = (graph.violations ?? []).filter((v) => v.nodes.some((id) => nodes.some((n) => n.id === id)));
  if (broken.length)
    lines.push('## Нарушения на архитектурата', '', ...broken.map((v) => `- ${v.kind}: ${v.message}`), '');
  const rules = nodes.filter((n) => n.role || n.layer || n.context);
  if (rules.length)
    lines.push(
      '## Архитектура',
      '',
      ...rules.map(
        (n) =>
          `- ${n.name}: ${[n.role && `роля ${n.role}`, n.layer && `слой ${n.layer}`, n.context && `контекст ${n.context}`].filter(Boolean).join(', ')}`,
      ),
      '',
    );

  lines.push(
    '## Ред на изпълнение',
    '',
    ...order(nodes, graph.edges).map((n, i) => `${i + 1}. ${n.name}  ${where({ node: n })}`),
  );
  const callers = outsideCallers(query, targets, nodes);
  if (callers.length)
    lines.push(
      '',
      'След това провери извикващите извън плана, ако сигнатурата се промени:',
      '',
      ...callers.map((c) => `- ${c}`),
    );
  return `${lines.join('\n')}\n`;
}

// Метод: класът му, код, кого вика и кой го вика. Клас: целият код, ако е кратък, иначе описанието.
function affected(query: GraphQuery, t: Target, byId: Map<string, Node>): string[] {
  const head = `### ${label(t)}  \`${where(t)}\``;
  const { root } = query.graph;
  if (!t.member) {
    const { line, endLine } = t.node.location;
    const body =
      endLine - line < MAX_SOURCE_LINES ? fence(root, t.node, t.node) : `\`\`\`\n${query.describe(t)}\n\`\`\``;
    return [head, '', `id: \`${t.node.id}\``, '', body];
  }
  const ctor = t.node.members.find((m) => CONSTRUCTORS.has(m.name));
  const owner =
    t.node.kind === 'function'
      ? `функция, id: \`${t.node.id}\``
      : `${t.node.kind} ${t.node.name}, id: \`${t.node.id}\`, ${ctor ? `конструктор \`${signature(ctor, byId)}\` :${ctor.location.line}` : 'без конструктор'}`;
  return [
    head,
    '',
    owner,
    '',
    fence(root, t.node, t.member),
    '',
    'Вика:',
    '```',
    query.trace(t, 'down', 1).split('\n').slice(1).join('\n') || '  (нищо от проекта)',
    '```',
    'Викан от:',
    '```',
    query.trace(t, 'up', 2).split('\n').slice(1).join('\n') || '  (никой в проекта)',
    '```',
  ];
}

function fence(root: string, node: Node, part: { location: Member['location'] }): string {
  const { file, line, endLine } = part.location;
  let text: string[];
  try {
    text = readFileSync(join(root, file), 'utf8')
      .split('\n')
      .slice(line - 1, endLine);
  } catch {
    return `(\`${file}\` не се чете)`;
  }
  const cut = text.length > MAX_SOURCE_LINES;
  const body = (cut ? text.slice(0, MAX_SOURCE_LINES) : text).join('\n');
  return `\`\`\`${node.language === 'node' ? 'ts' : node.language}\n${body}${cut ? `\n// … още ${text.length - MAX_SOURCE_LINES} реда` : ''}\n\`\`\``;
}

// Всичко преди първата декларация във файла: namespace, `declare`, импорти. Повече от 20 реда се режат.
function fileHeaders(root: string, nodes: Node[]): string[] {
  const first = new Map<string, Node>();
  for (const n of nodes) {
    const seen = first.get(n.location.file);
    if (!seen || n.location.line < seen.location.line) first.set(n.location.file, n);
  }
  return [...first.values()].flatMap((n) => {
    let text: string[];
    try {
      text = readFileSync(join(root, n.location.file), 'utf8')
        .split('\n')
        .slice(0, n.location.line - 1);
    } catch {
      return [];
    }
    while (text.length && !text.at(-1)?.trim()) text.pop();
    if (!text.length) return [];
    const head = text.length > 20 ? [...text.slice(0, 20), '…'] : text;
    const lang = n.language === 'node' ? 'ts' : n.language;
    return [`\`${n.location.file}\``, `\`\`\`${lang}`, ...head, '```', ''];
  });
}

// Как класът влиза в приложението: кой го създава, какво имплементира, какво получава, къде е регистриран.
function wiringOf(root: string, n: Node, edges: Edge[], byId: Map<string, Node>): string[] {
  const name = (id: string) => byId.get(id)?.name ?? id;
  const at = (e: Edge, end: 'from' | 'to') => {
    const node = byId.get(e[end].node);
    const m = node?.members.find((x) => x.name === e[end].member);
    return node ? where(m ? { node, member: m } : { node }) : '';
  };
  const facts: string[] = [];
  const creators: Edge[] = [];
  for (const e of edges) {
    if (e.kind === 'creates' && e.to.node === n.id) creators.push(e);
    if ((e.kind === 'implements' || e.kind === 'extends') && e.from.node === n.id)
      facts.push(`${e.kind} ${name(e.to.node)}  \`${at(e, 'to')}\``);
    if (e.kind === 'injects' && e.to.node === n.id)
      facts.push(`получава ${name(e.from.node)} в ${e.to.member}(${e.to.port})`);
    if (e.kind === 'injects' && e.from.node === n.id) facts.push(`инжектира се в ${name(e.to.node)}`);
    if (e.kind === 'binds' && (e.from.node === n.id || e.to.node === n.id))
      facts.push(
        `регистрация ${name(e.from.node)} → ${name(e.to.node)}${e.location ? `  \`${e.location.file}:${e.location.line}\`` : ''}`,
      );
  }
  // Всички места, където се създава, с кода им: от него личи дали нова зависимост се подава с `new`
  // или идва от DI контейнера.
  if (creators.length) {
    facts.push(`създава се на ${creators.length === 1 ? 'едно място' : `${creators.length} места`} в проекта:`);
    for (const e of creators) {
      const node = byId.get(e.from.node);
      const m = node?.members.find((x) => x.name === e.from.member);
      if (!node || !m) continue;
      facts.push(`  ${label({ node, member: m })}  \`${where({ node, member: m })}\``);
      if (m.location.endLine - m.location.line < 20) facts.push(indent(fence(root, node, m)));
    }
  }
  return facts.length ? [`**${n.name}**`, ...facts.map((f) => (f.startsWith('  ') ? f : `- ${f}`))] : [];
}

const CONSTRUCTORS = new Set(['__construct', 'constructor', '__init__']);

function indent(text: string): string {
  return text
    .split('\n')
    .map((l) => `    ${l}`)
    .join('\n');
}

function named(t: TypeRef): string[] {
  if (t.kind === 'named') return [t.id, ...(t.args ?? []).flatMap(named)];
  if (t.kind === 'array') return named(t.of);
  if (t.kind === 'map') return [...named(t.key), ...named(t.value)];
  if (t.kind === 'union') return t.of.flatMap(named);
  return [];
}

// Полетата на типовете от проекта, които се срещат в сигнатурите на засегнатите методи.
function dataTypes(targets: Target[], query: GraphQuery): string[] {
  const byId = new Map(query.graph.nodes.map((n) => [n.id, n]));
  const ids = new Set(
    targets
      .flatMap((t) => (t.member ? [...t.member.inputs, ...(t.member.output ? [t.member.output] : [])] : []))
      .flatMap((p) => named(p.type)),
  );
  return [...ids].flatMap((id) => {
    const shape = query.graph.types[id];
    const node = byId.get(id);
    if (!shape || !node || node.kind === 'interface') return [];
    const fields = shape.fields.map((f) => `${f.name}${f.optional ? '?' : ''}: ${typeText(f.type, byId)}`);
    return [`- **${node.name}** \`${where({ node })}\`: ${fields.join(', ')}`];
  });
}

// Първо това, от което другите зависят (ребра и типове в сигнатурите между засегнатите), после потребителите.
function order(nodes: Node[], edges: Edge[]): Node[] {
  const ids = new Set(nodes.map((n) => n.id));
  const deps = new Map(nodes.map((n) => [n.id, new Set<string>()]));
  for (const n of nodes)
    for (const m of n.members)
      for (const p of [...m.inputs, ...(m.output ? [m.output] : [])])
        for (const id of named(p.type)) if (id !== n.id && ids.has(id)) deps.get(n.id)?.add(id);
  for (const e of edges) {
    if (!['calls', 'injects', 'creates', 'implements', 'extends'].includes(e.kind)) continue;
    // injects е от зависимостта към потребителя, останалите са от потребителя към зависимостта
    const [user, dep] = e.kind === 'injects' ? [e.to.node, e.from.node] : [e.from.node, e.to.node];
    if (user !== dep && ids.has(user) && ids.has(dep)) deps.get(user)?.add(dep);
  }
  const result: Node[] = [];
  const done = new Set<string>();
  const visit = (n: Node, path: Set<string>) => {
    if (done.has(n.id) || path.has(n.id)) return;
    path.add(n.id);
    for (const d of deps.get(n.id) ?? []) visit(nodes.find((x) => x.id === d) as Node, path);
    done.add(n.id);
    result.push(n);
  };
  for (const n of nodes) visit(n, new Set());
  return result;
}

function outsideCallers(query: GraphQuery, targets: Target[], nodes: Node[]): string[] {
  const inside = new Set(nodes.map((n) => n.id));
  const out = new Set<string>();
  for (const t of targets)
    if (t.member)
      for (const [c, arrow] of query.callers(t))
        if (!inside.has(c.node.id))
          out.add(
            `${label(c)}  \`${where(c)}\`${arrow.startsWith('??') ? '  (може би: извикване по име, получателят е неизвестен)' : ''}`,
          );
  return [...out];
}
