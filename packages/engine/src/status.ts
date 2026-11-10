import type { GraphModel, Member, TypeRef } from '@archgraph/model';
import {
  assignLayers,
  DESIGN_STACKS,
  DESIGN_STYLES,
  LEVELS,
  loadDesign,
  type Design,
  type DesignLevel as Level,
  type RoleFacts,
} from '@archgraph/rules';
import { blueprint, designEntities, designWarnings, merge, moduleOf, type Blueprint } from './design.ts';
import { roleOf } from './process.ts';
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

// Класът от чертежа в изгледа „Архитектура“: в кой модул и слой е и как е в кода.
export interface StatusClass {
  name: string;
  kind: string;
  role: string;
  layer: string;
  module?: string;
  file: string;
  state: 'ok' | 'missing' | 'move' | 'changed'; // changed: липсват методи или полета, или сигнатурата е друга
  from?: string; // при move: къде е сега
}
// Клас от друга архитектура, ниво или стек, който този чертеж няма.
export interface StatusExtra {
  name: string;
  kind: string;
  role: string;
  layer?: string; // слоят в архитектурата, от която е
  module?: string;
  file: string;
  line: number;
}
export interface StatusEffort {
  size: 'малък' | 'среден' | 'голям';
  files: number;
  fresh: number; // нови класове
  methods: number; // методите им
  moves: number;
  removed: number;
  lines: number; // редовете на махнатите, логиката им се пренася
  edited: number;
}
export interface StatusReport {
  done: number;
  total: number;
  layers: string[];
  classes: StatusClass[];
  extra: StatusExtra[];
  mismatches: number;
  effort?: StatusEffort;
  sections: { title: string; lines: string[] }[]; // текстът за MCP, без заглавието и усилието
}

export function designStatus(graph: GraphModel, design: Design, bp: Blueprint): string {
  const report = statusReport(graph, design, bp);
  const out = [`# Чертеж: ${bp.style.label} · ${bp.stack.label} — готово ${report.done} от ${report.total}`];
  const e = report.effort;
  if (e) {
    const effort = [
      e.fresh && `- ${count(e.fresh, 'нов клас', 'нови класа')} за писане (${count(e.methods, 'метод', 'метода')})`,
      e.moves && `- ${count(e.moves, 'клас', 'класа')} за местене`,
      e.removed &&
        `- ${count(e.removed, 'клас', 'класа')} за махане; логиката им (около ${e.lines} реда) се пренася в новите`,
      e.edited && `- ${count(e.edited, 'клас', 'класа')} за промяна: методи, сигнатури, полета`,
    ].filter((x): x is string => typeof x === 'string');
    out.push('', `## Усилие: ${e.size} рефакторинг, ${count(e.files, 'файл', 'файла')}`, ...effort);
  }
  for (const { title, lines } of report.sections) {
    if (!lines.length) continue;
    out.push('', `## ${title} (${lines.length})`, ...lines);
    if (title.startsWith('Route-ове'))
      out.push(
        '',
        'Route-ът се разпознава, когато framework-ът е в манифеста (composer.json, package.json, pyproject.toml) и редът е регистриран.',
      );
  }
  if (!e && report.sections.every((x) => !x.lines.length || x.title.startsWith('Зависимости')))
    out.push('', 'Всичко от чертежа е в кода и съвпада.');
  return out.join('\n');
}

export function statusReport(graph: GraphModel, design: Design, bp: Blueprint): StatusReport {
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
  const changed = new Set<string>();
  for (const n of bp.nodes) {
    const code = real.get(n.id);
    if (!code || n.kind === 'route' || n.kind === 'template') continue;
    const where = `${code.location.file}:${code.location.line}`;
    for (const m of n.members) {
      const found = code.members.find((x) => x.name === m.name);
      if (!found) {
        missing.push(`- ${n.name}#${sig(m)} — ${where}`);
        edited.add(code.location.file);
        changed.add(n.id);
      } else if (isCtor(m) && extends_(m, found)) {
        const more = found.inputs.slice(m.inputs.length).map((p) => `${p.name}: ${text(p.type)}`);
        extra.push(`- ${n.name}: ${more.join(', ')} — ${where}`);
      } else if (!sameSignature(m, found)) {
        differs.push(`- ${n.name}#${m.name} — ${where}\n  чертеж: \`${sig(m)}\`\n  код:    \`${sig(found)}\``);
        edited.add(code.location.file);
        changed.add(n.id);
      }
    }
    const have = new Set((graph.types[n.id]?.fields ?? []).map((f) => f.name));
    const lack = (bp.types[n.id]?.fields ?? []).filter((f) => !have.has(f.name));
    if (lack.length) {
      fields.push(`- ${n.name}: ${lack.map((f) => `${f.name}: ${text(f.type)}`).join(', ')} — ${where}`);
      edited.add(code.location.file);
      changed.add(n.id);
    }
  }

  // Класовете, които друга архитектура или друг стек би имал за същите ендпойнти, а този чертеж не:
  // CreateAlbumCommand в onion, целият PHP код при NestJS. Помощните класове, които никой стил не чертае
  // (PhotoFiles, middleware), не се броят.
  const ids = new Set(bp.nodes.map((n) => n.id));
  // Нивото също: LoginUserCommand е излишен, ако аутентикацията е на ниво 1.
  const entities = designEntities(design);
  const atLevel = (level: Level) => Object.fromEntries(entities.map((e) => [e, { ...design.resources?.[e], level }]));
  // Модулът е ресурсът, на който е, както и да се казва папката в стека (albums в NestJS).
  const entityOf = new Map(DESIGN_STACKS.flatMap((x) => entities.map((e) => [moduleOf(x, e), e])));
  const moduleName = (context: string) => entityOf.get(context) ?? context;
  // id → слоят и модулът в архитектурата, от която е (първата, която го чертае)
  const others = new Map<string, { layer?: string; module?: string }>();
  for (const stack of DESIGN_STACKS)
    for (const s of DESIGN_STYLES)
      for (const level of LEVELS)
        for (const n of blueprint({ ...design, stack: stack.stack, style: s.style, resources: atLevel(level) }).nodes)
          if (!others.has(n.id))
            others.set(n.id, {
              ...(n.layer ? { layer: n.layer } : {}),
              ...(n.context ? { module: moduleName(n.context) } : {}),
            });
  const foreignNodes = code.filter((n) => n.kind !== 'route' && others.has(n.id) && !ids.has(n.id));
  // същото име на друго място на същия език: класът се мести (Application/AlbumItem.php → Dto/AlbumItem.php);
  // на друг език е за пренаписване, не за местене
  const wanted = new Map(
    ghosts.filter((n) => n.kind !== 'route' && n.language === bp.stack.language).map((n) => [n.name, n]),
  );
  const movable = foreignNodes.filter((n) => n.language === bp.stack.language && wanted.has(n.name));
  const movedFrom = new Map(movable.map((n) => [n.name, n.location.file]));
  const moves = movable.map(
    (n) => `- ${n.name}: ${n.location.file} → ${(wanted.get(n.name) as (typeof ghosts)[number]).location.file}`,
  );
  const removed = foreignNodes.filter((n) => !movable.includes(n));
  const foreign = removed.map((n) => `- ${n.kind} ${n.name} — ${n.location.file}:${n.location.line}`);

  // Слоевете: по записаната архитектура (може да е изрична, architecture.yaml), а при друг стил или стек —
  // наново по пътищата на проверявания чертеж.
  const saved = loadDesign(graph.root);
  const preview = !saved || saved.style !== design.style || saved.stack !== design.stack;
  const found = preview
    ? violations(assignLayers(code, bp.architecture, NO_FACTS), graph.edges, bp.architecture)
    : (graph.violations ?? []);

  // Усилието за рефакторинг: в класове, файлове и редове, не в часове.
  const fresh = ghosts.filter((n) => n.kind !== 'route' && n.kind !== 'template' && !movedFrom.has(n.name));
  const files = new Set([
    ...fresh.map((n) => n.location.file),
    ...foreignNodes.map((n) => n.location.file),
    ...[...wanted.values()].filter((n) => movedFrom.has(n.name)).map((n) => n.location.file),
    ...edited,
  ]);
  const effort: StatusEffort | undefined =
    fresh.length || moves.length || removed.length || edited.size
      ? {
          size: files.size <= 10 ? 'малък' : files.size <= 40 ? 'среден' : 'голям',
          files: files.size,
          fresh: fresh.length,
          methods: fresh.reduce((sum, n) => sum + n.members.length, 0),
          moves: moves.length,
          removed: removed.length,
          lines: removed.reduce((sum, n) => sum + n.location.endLine - n.location.line + 1, 0),
          edited: edited.size,
        }
      : undefined;

  const classes: StatusClass[] = bp.nodes
    .filter((n) => n.kind !== 'route' && n.kind !== 'template')
    .map((n) => {
      const from = movedFrom.get(n.name);
      return {
        name: n.name,
        kind: n.kind,
        role: roleOf(n, bp.types[n.id] !== undefined),
        layer: n.layer ?? '',
        ...(n.context ? { module: moduleName(n.context) } : {}),
        file: real.get(n.id)?.location.file ?? n.location.file,
        state: from && !real.has(n.id) ? 'move' : !real.has(n.id) ? 'missing' : changed.has(n.id) ? 'changed' : 'ok',
        ...(from && !real.has(n.id) ? { from } : {}),
      };
    });
  const routes = ghosts.filter((n) => n.kind === 'route');
  return {
    done: plan.done,
    total: plan.total,
    layers: bp.style.layers,
    classes,
    extra: removed.map((n) => ({
      name: n.name,
      kind: n.kind,
      role: roleOf(n, graph.types[n.id] !== undefined),
      ...others.get(n.id),
      file: n.location.file,
      line: n.location.line,
    })),
    mismatches: classes.filter((c) => c.state !== 'ok').length + removed.length,
    ...(effort ? { effort } : {}),
    sections: [
      { title: 'Предупреждения', lines: designWarnings(design).map((w) => `- ${w}`) },
      {
        title: 'Още ги няма',
        lines: ghosts
          .filter((n) => n.kind !== 'route' && !movedFrom.has(n.name))
          .map((n) => `- ${n.kind} ${n.name} → ${n.location.file}`),
      },
      { title: 'Да се преместят', lines: moves },
      { title: 'Route-ове, които не се виждат', lines: routes.map((n) => `- ${n.name}`) },
      { title: `Излишни за ${bp.style.label}`, lines: foreign },
      { title: 'Липсващи методи', lines: missing },
      { title: 'Различни сигнатури', lines: differs },
      // конструктор с още зависимости разширява чертежа, не му противоречи: напр. връзка между ресурси
      { title: 'Зависимости извън чертежа', lines: extra },
      { title: 'Липсващи полета', lines: fields },
      {
        title: 'Нарушения на архитектурата',
        lines: found.filter((v) => v.nodes.some((x) => ids.has(x) || others.has(x))).map((v) => `- ${v.message}`),
      },
    ],
  };
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
