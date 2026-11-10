import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  label,
  signature,
  statusReport,
  typeText,
  where,
  type Blueprint,
  type GraphQuery,
  type PatternResult,
  type Target,
} from '@archgraph/engine';
import type { Edge, GraphModel, Member, Node, TypeRef } from '@archgraph/model';
import { STYLE_ALLOW, type Design } from '@archgraph/rules';

// Маркирани нодове + задача → Markdown план за AI агент. Планът е детерминистичен: не измисля
// решение, а събира всичко, което агентът иначе би търсил из проекта: кода на засегнатите методи,
// кой ги вика, как са свързани класовете (образец за нови) и в какъв ред да се променят.

const MAX_SOURCE_LINES = 60;

export function plan(query: GraphQuery, task: string, targets: Target[]): string {
  const { graph } = query;
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  const nodes = [...new Map(targets.map((t) => [t.node.id, t.node])).values()];
  // без задача е само контекст: задачата се пише в чата с агента, над него
  const title = task.trim() ? `# План: ${task}` : `# Контекст: ${nodes.map((n) => n.name).join(', ')}`;
  const lines = [title, '', `Проект: \`${graph.root}\``, ''];

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

// Отвътре навън: първо това, от което другите зависят.
const INSIDE_OUT = ['domain', 'infrastructure', 'application', 'presentation', 'composition'];

// План за шаблон „като този“: новите файлове със сигнатурите и образеца им, редовете за регистрация
// с мястото и новата версия, редът на изпълнение.
export function patternPlan(p: PatternResult, example: string): string {
  const rank = (layer?: string) => {
    const i = INSIDE_OUT.indexOf(layer ?? '');
    return i < 0 ? INSIDE_OUT.length : i;
  };
  const ghosts = [...p.ghosts].sort((a, b) => rank(a.layer) - rank(b.layer) || a.file.localeCompare(b.file));
  const lines = [
    `# План: ${p.to} по образеца на ${example}`,
    '',
    `Всяко ново нещо повтаря структурата на образеца си, като \`${p.from}\` става \`${p.to}\` във всичките форми (име, файл, променливи, множествено число). Отвори образеца и следвай него, не измисляй нова структура.`,
    '',
    '## Нови класове и функции (по реда на изпълнение)',
    '',
  ];
  ghosts.forEach((g, i) => {
    lines.push(
      `${i + 1}. **${g.name}**${g.role ? ` (${g.role})` : ''} в \`${g.file}\` — образец \`${g.exampleFile}\` (${g.example})`,
    );
    for (const m of g.members) lines.push(`   - \`${m}\``);
  });
  if (p.registrations.length) {
    lines.push('', '## Регистрации', '', 'Същите редове като за образеца, в същите файлове:', '');
    for (const r of p.registrations) lines.push(`- \`${r.file}:${r.line}\`: \`${r.text}\` → \`${r.suggested}\``);
  }
  return `${lines.join('\n')}\n`;
}

// Чертежът (етап 11) → задачата за агента, на английски: какво да се мести, да се напише, да се промени
// и да се махне, по проверката срещу кода (statusReport). Написаното и съвпадащото не влиза.
export function designPlan(graph: GraphModel, design: Design, bp: Blueprint): string {
  const report = statusReport(graph, design, bp);
  const byId = new Map([...bp.nodes, ...graph.nodes].map((n) => [n.id, n]));
  // отвътре навън по зависимостите: слоят е след тези, от които зависи (domain, после infrastructure…)
  const allow = STYLE_ALLOW[bp.style.style] ?? {};
  const depth = (l: string, seen: string[] = []): number =>
    seen.includes(l) ? 0 : Math.max(-1, ...(allow[l] ?? []).map((d) => depth(d, [...seen, l]))) + 1;
  const order = (n: Node) => depth(n.layer ?? '');
  const lines = [
    `# Plan: ${bp.style.label} in ${bp.stack.label}`,
    '',
    `Project: \`${graph.root}\` · done ${report.done} of ${report.total}`,
    '',
    bp.style.brief,
    '',
  ];
  if (!graph.nodes.some((n) => !(n.tags ?? []).includes('ghost')))
    lines.push('## Start', '', `Empty project: \`${bp.stack.bootstrap}\``, '');
  lines.push('Use exactly these names and files: archgraph recognizes the written code by them.', '');

  if (report.moves.length) {
    lines.push('## Move', '', 'Same class, new file. Update the namespace and every import.', '');
    for (const m of report.moves) lines.push(`- **${m.name}**: \`${m.from}\` → \`${m.to}\``);
    lines.push('');
  }

  const fresh = new Set(report.classes.filter((c) => c.state === 'missing').map((c) => `${c.name} ${c.file}`));
  const todo = bp.nodes
    .filter((n) => fresh.has(`${n.name} ${n.location.file}`))
    .sort((a, b) => order(a) - order(b) || a.location.file.localeCompare(b.location.file));
  if (todo.length) {
    lines.push('## New (inside out)', '');
    todo.forEach((n, i) => {
      const kind = n.kind === 'class' ? '' : `${n.kind} `;
      lines.push(`${i + 1}. ${kind}**${n.name}** (${n.role}, layer ${n.layer}) in \`${n.location.file}\``);
      const fields = bp.types[n.id]?.fields ?? [];
      if (fields.length)
        lines.push(`   - fields: ${fields.map((f) => `\`${f.name}: ${typeText(f.type, byId)}\``).join(', ')}`);
      for (const m of n.members) lines.push(`   - \`${signature(m, byId)}\``);
      const base = bp.edges.find((e) => e.kind === 'implements' && e.from.node === n.id);
      if (base) lines.push(`   - implements ${byId.get(base.to.node)?.name ?? base.to.node}`);
    });
    lines.push('');
  }

  if (report.changes.length) {
    lines.push('## Change', '');
    for (const c of report.changes) {
      lines.push(`- **${c.name}** in \`${c.file}:${c.line}\``);
      for (const m of c.missing) lines.push(`  - add \`${m}\``);
      for (const d of c.differs) lines.push(`  - \`${d.code}\` → \`${d.designed}\``);
      if (c.fields.length) lines.push(`  - add fields: ${c.fields.map((f) => `\`${f}\``).join(', ')}`);
    }
    lines.push('');
  }

  if (report.extra.length) {
    lines.push(
      '## Remove',
      '',
      `Not part of ${bp.style.label} at this level. Move their logic into the classes above first, then delete the files and their registrations.`,
      '',
    );
    for (const e of report.extra) lines.push(`- ${e.kind} **${e.name}** — \`${e.file}:${e.line}\``);
    lines.push('');
  }

  const ghosts = new Set(graph.nodes.filter((n) => (n.tags ?? []).includes('ghost')).map((n) => n.id));
  const routes = bp.nodes.filter((n) => n.kind === 'route' && ghosts.has(n.id));
  if (routes.length) {
    lines.push('## Routes', '');
    for (const r of routes) {
      const to = bp.edges.find((e) => e.kind === 'routes-to' && e.from.node === r.id)?.to;
      const target = to ? `${byId.get(to.node)?.name ?? to.node}${to.member ? `#${to.member}` : ''}` : '';
      const line = bp.registrations.find((x) => x.route === r.id);
      lines.push(`- \`${r.name}\` → ${target}${line ? ` · in \`${line.file}\`: \`${line.text}\`` : ''}`);
    }
    lines.push('');
  }
  if (bp.stack.wiring) lines.push('## Wiring', '', bp.stack.wiring, '');
  lines.push('## Layers', '', 'Each layer depends only on the listed ones; the reverse direction is a violation.', '');
  for (const l of bp.style.layers) lines.push(`- **${l}** → ${(allow[l] ?? []).join(', ') || 'nothing'}`);
  if (!report.mismatches && !routes.length) lines.push('', 'Everything in the design is in the code and matches.');
  return `${lines.join('\n')}\n`;
}
