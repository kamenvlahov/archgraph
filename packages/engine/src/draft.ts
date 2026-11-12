import type { GraphModel } from '@archgraph/model';
import { DESIGN_STACKS, DESIGN_STYLES, type Design } from '@archgraph/rules';
import { blueprint } from './design.ts';
import { statusReport } from './status.ts';

// Чертеж от вече написан код (проект отпреди archgraph): стекът е по framework-а, ендпойнтите са
// route-овете, а стилът е този, до който кодът е най-близо: най-много готово, после най-малко файлове.
const STACK_OF: Record<string, string> = { mezzio: 'php-mezzio', fastapi: 'python-fastapi', nestjs: 'ts-nestjs' };

export interface Draft {
  design: Design;
  styles: { style: string; done: number; total: number; files: number }[]; // от най-близкия
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

  const styles = DESIGN_STYLES.map(({ style }) => {
    const r = statusReport(
      graph,
      { stack: stack.stack, style, endpoints },
      blueprint({ stack: stack.stack, style, endpoints }),
    );
    return { style, done: r.done, total: r.total, files: r.effort?.files ?? 0 };
  }).sort((a, b) => b.done / (b.total || 1) - a.done / (a.total || 1) || a.files - b.files);
  return { design: { stack: stack.stack, style: styles[0]?.style ?? 'layered', endpoints }, styles };
}
