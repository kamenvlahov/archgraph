import type { GraphModel } from '@archgraph/model';
import {
  DESIGN_STACKS,
  DESIGN_STYLES,
  type Design,
  type DesignLevel as Level,
  type DesignResource as Resource,
} from '@archgraph/rules';
import { currentArchitecture, type CurrentModule } from './current.ts';
import { designEntities } from './design.ts';

// Чертеж от вече написан код (проект отпреди archgraph). Не се сравнява с шаблоните по имена: стилът и
// нивата идват от текущата архитектура (current.ts), прочетена от папките. Има ли application и domain,
// и минават ли заявките през тях — DDD; минават ли повечето направо в базата — MVC. Модулът, чийто вход
// вика infrastructure направо, е на ниво 1, смесеният — на 2, а този по слоеве — пълен.
const STACK_OF: Record<string, string> = { mezzio: 'php-mezzio', fastapi: 'python-fastapi', nestjs: 'ts-nestjs' };
const LEVEL_OF: Partial<Record<CurrentModule['shape'], Level>> = { direct: 1, mixed: 2 };

export interface Draft {
  design: Design;
  why: string[];
}

export function draftDesign(graph: GraphModel, frameworks: string[]): Draft | string {
  const stack = DESIGN_STACKS.find((s) => frameworks.some((f) => STACK_OF[f] === s.stack));
  if (!stack)
    return `няма чертеж за ${frameworks.join(', ') || 'този проект'}; има за ${Object.keys(STACK_OF).join(', ')}`;
  const seen = new Set<string>();
  const endpoints = graph.nodes
    .filter((n) => n.kind === 'route' && n.language === stack.language && !n.id.includes('::'))
    .filter((n) => !(n.tags ?? []).includes('ghost'))
    .map((n) => n.name.split(' '))
    .filter(([method = '', path = '']) => /^[A-Z]+$/.test(method) && path.startsWith('/'))
    .filter(([method, path]) => !seen.has(`${method} ${path}`) && seen.add(`${method} ${path}`))
    .map(([method = '', path = '']) => ({ method, path }))
    .sort((a, b) => a.path.localeCompare(b.path) || a.method.localeCompare(b.method));
  if (!endpoints.length) return `не намерих route-ове на ${stack.label}`;

  const current = currentArchitecture(graph);
  const count = (shape: CurrentModule['shape']) => current.modules.filter((m) => m.shape === shape).length;
  const direct = count('direct');
  const layered = count('layered') + count('mixed');
  const has = (layer: keyof typeof current.folders) => (current.folders[layer] ?? []).length > 0;
  const style = direct > layered ? 'mvc' : has('application') && has('domain') ? 'ddd' : 'layered';
  const why = [
    `слоеве по папките: ${Object.entries(current.folders)
      .filter(([layer]) => layer !== 'other')
      .map(([layer, names]) => `${layer} (${(names ?? []).join(', ')})`)
      .join('; ')}`,
    `модули: ${count('layered')} по слоеве, ${count('mixed')} смесени, ${direct} направо в infrastructure`,
  ];

  // нивото на всеки ресурс от чертежа е според модула със същото име (PromoCode ↔ promo_code)
  const resources: Record<string, Resource> = {};
  if (DESIGN_STYLES.find((s) => s.style === style)?.levels) {
    const byName = new Map(current.modules.map((m) => [m.name.toLowerCase().replace(/[_-]/g, ''), m]));
    for (const entity of designEntities({ stack: stack.stack, style, endpoints })) {
      const level = LEVEL_OF[byName.get(entity.toLowerCase())?.shape ?? 'none'];
      if (level) resources[entity] = { level };
    }
    const levels = Object.entries(resources).map(([name, r]) => `${name} ${r.level}`);
    if (levels.length) why.push(`по-прости модули: ${levels.join(', ')}`);
  }
  return {
    design: { stack: stack.stack, style, ...(Object.keys(resources).length ? { resources } : {}), endpoints },
    why,
  };
}
