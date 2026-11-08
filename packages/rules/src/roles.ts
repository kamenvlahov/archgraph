import { matchesGlob } from 'node:path';
import type { Node } from '@archgraph/model';
import type { Condition, FrameworkRules } from './frameworks.ts';

// Фактите за нодовете, по които се проверяват условията. Engine-ът ги събира след свързването.
export interface RoleFacts {
  ancestors: Map<string, Set<string>>; // id → всички базови типове (extends и implements), транзитивно, и външни
  extending: Map<string, Set<string>>; // само extends, транзитивно
  decorators: Map<string, string[]>; // id → декоратори и атрибути на класа или функцията
  injected: Set<string>; // id-тата, които се инжектират някъде
  handlers: Set<string>; // id-тата, към които сочи route
}

// Роля и framework за всеки нод по правилата на framework-ите за неговия език. Първата роля, чието
// условие важи, печели. Нодовете не се променят на място: прочетеното се ползва при следващото свързване.
export function assignRoles(nodes: Node[], frameworks: FrameworkRules[], facts: RoleFacts): Node[] {
  return nodes.map((n) => {
    if (n.kind === 'route') return n;
    const own = frameworks.filter((f) => f.language === n.language);
    const [first] = own;
    if (!first) return n;
    for (const fw of own)
      for (const [role, condition] of Object.entries(fw.roles ?? {}))
        if (matches(n, condition, facts)) return { ...n, role, framework: fw.framework };
    return { ...n, framework: first.framework };
  });
}

function matches(n: Node, c: Condition, facts: RoleFacts): boolean {
  const list = <T>(v: T | T[] | undefined): T[] => (v === undefined ? [] : Array.isArray(v) ? v : [v]);
  const checks: boolean[] = [];
  if (c.any) checks.push(c.any.some((x) => matches(n, x, facts)));
  if (c.all) checks.push(c.all.every((x) => matches(n, x, facts)));
  if (c.not) checks.push(!matches(n, c.not, facts));
  if (c.implements)
    checks.push(list(c.implements).some((t) => [...(facts.ancestors.get(n.id) ?? [])].some((a) => sameName(a, t))));
  if (c.extends)
    checks.push(list(c.extends).some((t) => [...(facts.extending.get(n.id) ?? [])].some((a) => sameName(a, t))));
  if (c.name_suffix) checks.push(list(c.name_suffix).some((s) => n.name.endsWith(s)));
  if (c.name_prefix) checks.push(list(c.name_prefix).some((s) => n.name.startsWith(s)));
  if (c.namespace_contains) checks.push(list(c.namespace_contains).some((s) => n.id.includes(s)));
  if (c.path_glob) checks.push(list(c.path_glob).some((g) => matchesGlob(n.location.file, g)));
  const decorators = facts.decorators.get(n.id) ?? [];
  if (c.decorator) checks.push(list(c.decorator).some((d) => decorators.some((x) => sameName(x, d))));
  if (c.attribute) checks.push(list(c.attribute).some((d) => decorators.some((x) => sameName(x, d))));
  if (c.has_method) checks.push(list(c.has_method).some((m) => n.members.some((x) => x.name === m)));
  if (c.readonly_class !== undefined) checks.push((n.tags ?? []).includes('readonly') === c.readonly_class);
  if (c.kind) checks.push(list(c.kind).includes(n.kind));
  if (c.injected !== undefined) checks.push(facts.injected.has(n.id) === c.injected);
  if (c.route_handler !== undefined) checks.push(facts.handlers.has(n.id) === c.route_handler);
  return checks.length > 0 && checks.every(Boolean);
}

// `php:Psr\Http\Server\RequestHandlerInterface` е `Psr\Http\Server\RequestHandlerInterface`;
// кратко име (`Controller`, `dataclass`) съвпада с последната част (`dataclasses.dataclass`).
function sameName(id: string, wanted: string): boolean {
  const full = id.replace(/^[a-z]+:/, '').replace(/^\\/, '');
  const want = wanted.replace(/^\\/, '');
  if (full === want) return true;
  return /[\\./#]/.test(want)
    ? full.endsWith(want) && /[\\./#]/.test(full.charAt(full.length - want.length - 1))
    : full.split(/[\\./#]/).at(-1) === want;
}
