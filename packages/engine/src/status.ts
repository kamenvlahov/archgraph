import type { GraphModel, Member, TypeRef } from '@archgraph/model';
import { assignLayers, DESIGN_STACKS, DESIGN_STYLES, loadDesign, type Design, type RoleFacts } from '@archgraph/rules';
import { blueprint, designWarnings, merge, type Blueprint } from './design.ts';
import { typeText } from './query.ts';
import { violations } from './violations.ts';

// Докъде е кодът спрямо чертежа (етап 11): какво още го няма, кои методи и полета липсват в написаните
// класове, къде сигнатурата се разминава и кои класове са от друга архитектура. Чертежът може да е и
// незаписан (друг стил или стек): тогава проверката показва какво ще се счупи, ако го приложиш.

// слоевете на чертежа са само по пътища (path_glob), затова фактите от сканирането не трябват
const NO_FACTS: RoleFacts = {
  ancestors: new Map(),
  extending: new Map(),
  decorators: new Map(),
  injected: new Set(),
  handlers: new Set(),
};

export function designStatus(graph: GraphModel, design: Design, bp: Blueprint): string {
  const byId = new Map([...bp.nodes, ...graph.nodes].map((n) => [n.id, n]));
  const code = graph.nodes.filter((n) => !(n.tags ?? []).includes('ghost'));
  const real = new Map(code.map((n) => [n.id, n]));
  // какво липсва, се смята спрямо проверявания чертеж, не спрямо записания, по който е сканиран графът
  const plan = merge(graph.root, code, bp);
  const ghosts = plan.nodes.filter((n) => (n.tags ?? []).includes('ghost'));
  const text = (t: TypeRef) => typeText(t, byId);
  const sig = (m: Member) =>
    `${m.name}(${m.inputs.map((p) => `${p.name}: ${text(p.type)}`).join(', ')})${m.output ? `: ${text(m.output.type)}` : ''}`;

  const missing: string[] = [];
  const differs: string[] = [];
  const extra: string[] = [];
  const fields: string[] = [];
  const edited = new Set<string>(); // написаните класове, които трябва да се променят
  for (const n of bp.nodes) {
    const code = real.get(n.id);
    if (!code || n.kind === 'route' || n.kind === 'template') continue;
    const where = `${code.location.file}:${code.location.line}`;
    for (const m of n.members) {
      const found = code.members.find((x) => x.name === m.name);
      if (!found) {
        missing.push(`- ${n.name}#${sig(m)} — ${where}`);
        edited.add(code.location.file);
      } else if (isCtor(m) && extends_(m, found)) {
        const more = found.inputs.slice(m.inputs.length).map((p) => `${p.name}: ${text(p.type)}`);
        extra.push(`- ${n.name}: ${more.join(', ')} — ${where}`);
      } else if (!sameSignature(m, found)) {
        differs.push(`- ${n.name}#${m.name} — ${where}\n  чертеж: \`${sig(m)}\`\n  код:    \`${sig(found)}\``);
        edited.add(code.location.file);
      }
    }
    const have = new Set((graph.types[n.id]?.fields ?? []).map((f) => f.name));
    const lack = (bp.types[n.id]?.fields ?? []).filter((f) => !have.has(f.name));
    if (lack.length) {
      fields.push(`- ${n.name}: ${lack.map((f) => `${f.name}: ${text(f.type)}`).join(', ')} — ${where}`);
      edited.add(code.location.file);
    }
  }

  // Класовете, които друга архитектура или друг стек би имал за същите ендпойнти, а този чертеж не:
  // CreateAlbumCommand в onion, целият PHP код при NestJS. Помощните класове, които никой стил не чертае
  // (PhotoFiles, middleware), не се броят.
  const ids = new Set(bp.nodes.map((n) => n.id));
  const others = new Set(
    DESIGN_STACKS.flatMap((stack) =>
      DESIGN_STYLES.filter((s) => s.style !== design.style || stack.stack !== design.stack).flatMap((s) =>
        blueprint({ ...design, stack: stack.stack, style: s.style }).nodes.map((n) => n.id),
      ),
    ),
  );
  const foreignNodes = code.filter((n) => n.kind !== 'route' && others.has(n.id) && !ids.has(n.id));
  // същото име на друго място на същия език: класът се мести (Application/AlbumItem.php → Dto/AlbumItem.php);
  // на друг език е за пренаписване, не за местене
  const wanted = new Map(
    ghosts.filter((n) => n.kind !== 'route' && n.language === bp.stack.language).map((n) => [n.name, n]),
  );
  const movable = foreignNodes.filter((n) => n.language === bp.stack.language && wanted.has(n.name));
  const moves = movable.map(
    (n) => `- ${n.name}: ${n.location.file} → ${(wanted.get(n.name) as (typeof ghosts)[number]).location.file}`,
  );
  const moved = new Set(movable.map((n) => n.name));
  const foreign = foreignNodes
    .filter((n) => !movable.includes(n))
    .map((n) => `- ${n.kind} ${n.name} — ${n.location.file}:${n.location.line}`);

  // Слоевете: по записаната архитектура (може да е изрична, architecture.yaml), а при друг стил или стек —
  // наново по пътищата на проверявания чертеж.
  const saved = loadDesign(graph.root);
  const preview = !saved || saved.style !== design.style || saved.stack !== design.stack;
  const found = preview
    ? violations(assignLayers(code, bp.architecture, NO_FACTS), graph.edges, bp.architecture)
    : (graph.violations ?? []);

  const out = [`# Чертеж: ${bp.style.label} · ${bp.stack.label} — готово ${plan.done} от ${plan.total}`];
  const section = (title: string, lines: string[]) =>
    lines.length && out.push('', `## ${title} (${lines.length})`, ...lines);

  // Усилието за рефакторинг: в класове, файлове и редове, не в часове.
  const fresh = ghosts.filter((n) => n.kind !== 'route' && n.kind !== 'template' && !moved.has(n.name));
  const removed = foreignNodes.filter((n) => !movable.includes(n));
  const lines = removed.reduce((sum, n) => sum + n.location.endLine - n.location.line + 1, 0);
  const files = new Set([
    ...fresh.map((n) => n.location.file),
    ...foreignNodes.map((n) => n.location.file),
    ...[...wanted.values()].filter((n) => moved.has(n.name)).map((n) => n.location.file),
    ...edited,
  ]);
  const effort = [
    fresh.length &&
      `- ${count(fresh.length, 'нов клас', 'нови класа')} за писане (${count(
        fresh.reduce((sum, n) => sum + n.members.length, 0),
        'метод',
        'метода',
      )})`,
    moves.length && `- ${count(moves.length, 'клас', 'класа')} за местене`,
    removed.length &&
      `- ${count(removed.length, 'клас', 'класа')} за махане; логиката им (около ${lines} реда) се пренася в новите`,
    edited.size && `- ${count(edited.size, 'клас', 'класа')} за промяна: методи, сигнатури, полета`,
  ].filter((x): x is string => typeof x === 'string');
  if (effort.length) {
    const size = files.size <= 10 ? 'малък' : files.size <= 40 ? 'среден' : 'голям';
    out.push('', `## Усилие: ${size} рефакторинг, ${count(files.size, 'файл', 'файла')}`, ...effort);
  }
  section(
    'Предупреждения',
    designWarnings(design).map((w) => `- ${w}`),
  );
  section(
    'Още ги няма',
    ghosts
      .filter((n) => n.kind !== 'route' && !moved.has(n.name))
      .map((n) => `- ${n.kind} ${n.name} → ${n.location.file}`),
  );
  section('Да се преместят', moves);
  const routes = ghosts.filter((n) => n.kind === 'route');
  section(
    'Route-ове, които не се виждат',
    routes.map((n) => `- ${n.name}`),
  );
  if (routes.length)
    out.push(
      '',
      'Route-ът се разпознава, когато framework-ът е в манифеста (composer.json, package.json, pyproject.toml) и редът е регистриран.',
    );
  section(`Излишни за ${bp.style.label}`, foreign);
  section('Липсващи методи', missing);
  section('Различни сигнатури', differs);
  // конструктор с още зависимости разширява чертежа, не му противоречи: напр. връзка между ресурси
  section('Зависимости извън чертежа', extra);
  section('Липсващи полета', fields);
  section(
    'Нарушения на архитектурата',
    found.filter((v) => v.nodes.some((x) => ids.has(x) || others.has(x))).map((v) => `- ${v.message}`),
  );
  if (out.every((l) => !l.startsWith('## ') || l.startsWith('## Зависимости')))
    out.push('', 'Всичко от чертежа е в кода и съвпада.');
  return out.join('\n');
}

const count = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

const isCtor = (m: Member) => ['__construct', 'constructor', '__init__'].includes(m.name);

// Конструкторът в кода има зависимостите от чертежа (в същия ред) и още.
function extends_(designed: Member, code: Member): boolean {
  return (
    code.inputs.length > designed.inputs.length &&
    designed.inputs.every((p, i) => sameType(p.type, (code.inputs[i] as (typeof code.inputs)[number]).type))
  );
}

// Сигнатурата съвпада, ако броят на параметрите е същият и типовете не си противоречат. Липсващ тип в кода
// (без анотация) не е разминаване; `array` в PHP или `list`/`dict` в Python покриват масив от чертежа.
function sameSignature(designed: Member, code: Member): boolean {
  if (designed.inputs.length !== code.inputs.length) return false;
  if (designed.inputs.some((p, i) => !sameType(p.type, (code.inputs[i] as (typeof code.inputs)[number]).type)))
    return false;
  if (!designed.output || !code.output) return true;
  return sameType(designed.output.type, code.output.type);
}

function sameType(a: TypeRef, b: TypeRef): boolean {
  if (a.kind === 'unknown' || b.kind === 'unknown') return true;
  if (a.kind === 'array' && b.kind === 'array') return sameType(a.of, b.of);
  if (a.kind === 'array' || b.kind === 'array') {
    const other = a.kind === 'array' ? b : a;
    return other.kind === 'primitive' && ['array', 'iterable', 'list', 'dict'].includes(short(other.name));
  }
  if (b.kind === 'primitive' && ['self', 'static'].includes(b.name)) return true;
  return short(id(a)) === short(id(b));
}

const id = (t: TypeRef) => (t.kind === 'named' ? t.id : t.kind === 'primitive' ? t.name : t.kind);
// `php:App\Gallery\Entity\Gallery`, `\DateTimeImmutable`, `node:src/x.ts#Gallery` → последното име
const short = (s: string) =>
  s
    .split(/[\\.#:/]/)
    .at(-1)
    ?.toLowerCase() ?? s;
