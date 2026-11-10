import type { GraphModel, Member, TypeRef } from '@archgraph/model';
import { designWarnings, type Blueprint } from './design.ts';
import type { Design } from '@archgraph/rules';
import { typeText } from './query.ts';

// Докъде е кодът спрямо чертежа (етап 11): какво още го няма, кои методи и полета липсват в написаните
// класове и къде сигнатурата се разминава с чертежа. За агента след всяко писане (MCP `design_status`).

export function designStatus(graph: GraphModel, design: Design, bp: Blueprint): string {
  const byId = new Map([...bp.nodes, ...graph.nodes].map((n) => [n.id, n]));
  const real = new Map(graph.nodes.filter((n) => !(n.tags ?? []).includes('ghost')).map((n) => [n.id, n]));
  const ghosts = graph.nodes.filter((n) => (n.tags ?? []).includes('ghost'));
  const text = (t: TypeRef) => typeText(t, byId);
  const sig = (m: Member) =>
    `${m.name}(${m.inputs.map((p) => `${p.name}: ${text(p.type)}`).join(', ')})${m.output ? `: ${text(m.output.type)}` : ''}`;

  const missing: string[] = [];
  const differs: string[] = [];
  const fields: string[] = [];
  for (const n of bp.nodes) {
    const code = real.get(n.id);
    if (!code || n.kind === 'route' || n.kind === 'template') continue;
    const where = `${code.location.file}:${code.location.line}`;
    for (const m of n.members) {
      const found = code.members.find((x) => x.name === m.name);
      if (!found) missing.push(`- ${n.name}#${sig(m)} — ${where}`);
      else if (!sameSignature(m, found))
        differs.push(`- ${n.name}#${m.name} — ${where}\n  чертеж: \`${sig(m)}\`\n  код:    \`${sig(found)}\``);
    }
    const have = new Set((graph.types[n.id]?.fields ?? []).map((f) => f.name));
    const lack = (bp.types[n.id]?.fields ?? []).filter((f) => !have.has(f.name));
    if (lack.length) fields.push(`- ${n.name}: ${lack.map((f) => `${f.name}: ${text(f.type)}`).join(', ')} — ${where}`);
  }

  const out = [
    `# Чертеж: ${bp.style.label} · ${bp.stack.label} — готово ${bp.nodes.length - ghosts.length} от ${bp.nodes.length}`,
  ];
  const section = (title: string, lines: string[]) =>
    lines.length && out.push('', `## ${title} (${lines.length})`, ...lines);
  section(
    'Предупреждения',
    designWarnings(design).map((w) => `- ${w}`),
  );
  section(
    'Още ги няма',
    ghosts.filter((n) => n.kind !== 'route').map((n) => `- ${n.kind} ${n.name} → ${n.location.file}`),
  );
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
  section('Липсващи методи', missing);
  section('Различни сигнатури', differs);
  section('Липсващи полета', fields);
  const ids = new Set(bp.nodes.map((n) => n.id));
  section(
    'Нарушения на архитектурата',
    (graph.violations ?? []).filter((v) => v.nodes.some((x) => ids.has(x))).map((v) => `- ${v.message}`),
  );
  if (out.length === 1) out.push('', 'Всичко от чертежа е в кода и съвпада.');
  return out.join('\n');
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
