import { appendFileSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import { saveDesign, type Design } from '@archgraph/rules';
import { blueprint, readEndpoint } from './design.ts';
import { skeleton } from './skeleton.ts';
import { GraphQuery } from './query.ts';
import { processView } from './process.ts';
import { Project } from './scan.ts';

const ep = (s: string) => ({ method: s.split(' ')[0] as string, path: s.split(' ')[1] as string });

describe('readEndpoint', () => {
  test.each([
    ['POST /invoices', 'Invoice', 'create'],
    ['GET /invoices', 'Invoice', 'list'],
    ['GET /invoices/{id}', 'Invoice', 'get'],
    ['PUT /invoices/:id', 'Invoice', 'update'],
    ['DELETE /invoices/{id:\\d+}', 'Invoice', 'delete'],
    ['POST /invoices/{id}/cancel', 'Invoice', 'cancel'],
    ['GET /admin/profile/edit', 'Profile', 'edit'],
    ['GET /admin/profile', 'Profile', 'get'],
    ['GET /admin/categories/index', 'Category', 'list'],
    ['POST /line-items', 'LineItem', 'create'],
    ['PUT /gallery/edit/{id}', 'Gallery', 'update'],
    ['GET /gallery/edit/{id}', 'Gallery', 'edit'],
    ['DELETE /gallery/delete/{id}', 'Gallery', 'delete'],
    ['GET /gallery/view/{id}', 'Gallery', 'get'],
    ['POST /gallery/add', 'Gallery', 'create'],
  ])('%s → %s %s', (e, entity, action) => {
    expect(readEndpoint(ep(e))).toMatchObject({ entity, action });
  });
});

// Минимален код за всеки нод от чертежа: само декларацията, както би я написал агентът по плана.
function write(root: string, design: Design) {
  for (const n of blueprint(design).nodes) {
    if (n.kind === 'route' || n.kind === 'template') continue;
    const path = join(root, n.location.file);
    mkdirSync(dirname(path), { recursive: true });
    if (n.language === 'php') {
      const ns = n.id.replace(/^php:/, '').split('\\').slice(0, -1).join('\\');
      appendFileSync(path, `<?php\nnamespace ${ns};\n\n${n.kind} ${n.name}\n{\n}\n`);
    } else if (n.language === 'node') appendFileSync(path, `export ${n.kind} ${n.name} {}\n`);
    else
      appendFileSync(path, n.kind === 'function' ? `def ${n.name}():\n    pass\n\n` : `class ${n.name}:\n    pass\n\n`);
  }
}

describe('чертеж', () => {
  let root = '';
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  test.each([
    ['php-mezzio', 'layered'],
    ['php-mezzio', 'ddd'],
    ['ts-nestjs', 'hexagonal'],
    ['ts-nestjs', 'clean'],
    ['python-fastapi', 'onion'],
    ['python-fastapi', 'mvc'],
  ])('%s + %s: написаният по плана код заменя ghost нодовете', async (stack, style) => {
    root = mkdtempSync(join(tmpdir(), 'archgraph-design-'));
    const design: Design = { stack, style, endpoints: [ep('POST /invoices'), ep('GET /invoices/{id}')] };
    saveDesign(root, design);

    const empty = await Project.open(root, { scip: false });
    const total = empty.report.design?.total ?? 0;
    expect(empty.report.design?.done).toBe(0);
    expect(empty.graph.nodes.every((n) => n.tags?.includes('ghost'))).toBe(true);

    write(root, design);
    const written = await Project.open(root, { scip: false });
    const left = written.graph.nodes.filter((n) => n.tags?.includes('ghost'));
    // остават само route-овете (без framework в манифеста) и шаблоните, които не са писани
    expect(left.filter((n) => n.kind !== 'route' && n.kind !== 'template').map((n) => n.id)).toEqual([]);
    expect(written.report.design?.total).toBe(total);
  });

  test.each([
    ['php-mezzio', 'layered'],
    ['php-mezzio', 'hexagonal'],
    ['ts-nestjs', 'ddd'],
    ['ts-nestjs', 'onion'],
    ['python-fastapi', 'clean'],
    ['python-fastapi', 'ddd'],
  ])('%s + %s: скелетът дава класовете и методите от чертежа', async (stack, style) => {
    root = mkdtempSync(join(tmpdir(), 'archgraph-design-'));
    const design: Design = {
      stack,
      style,
      endpoints: [ep('POST /invoices'), ep('GET /invoices'), ep('POST /invoices/{id}/cancel')],
    };
    saveDesign(root, design);
    const bp = blueprint(design);
    for (const file of new Set(bp.nodes.map((n) => n.location.file))) {
      const code = skeleton(bp, file);
      if (!code || bp.nodes.some((n) => n.location.file === file && n.kind === 'template')) continue;
      mkdirSync(dirname(join(root, file)), { recursive: true });
      appendFileSync(join(root, file), code);
    }
    const p = await Project.open(root, { scip: false });
    const ghosts = p.graph.nodes.filter((n) => n.tags?.includes('ghost') && n.kind !== 'route');
    expect(ghosts.map((n) => n.id)).toEqual([]);
    // всеки метод от чертежа го има в написания клас
    const real = new Map(p.graph.nodes.map((n) => [n.id, n]));
    const missing = bp.nodes.flatMap((n) =>
      n.members
        .filter((m) => !real.get(n.id)?.members.some((x) => x.name === m.name))
        .map((m) => `${n.name}#${m.name}`),
    );
    expect(missing).toEqual([]);
  });

  test('веригата минава през слоевете на стила и слоят на истинския код идва от чертежа', async () => {
    root = mkdtempSync(join(tmpdir(), 'archgraph-design-'));
    const design: Design = { stack: 'php-mezzio', style: 'layered', endpoints: [ep('POST /invoices/{id}/cancel')] };
    saveDesign(root, design);
    const p = await Project.open(root, { scip: false });
    expect(p.report.layers).toEqual(['presentation', 'application', 'domain', 'infrastructure']);
    const q = new GraphQuery(p.graph);
    const [route] = q.find('php:route:POST /invoices/{id}/cancel');
    const view = processView(q, route as NonNullable<typeof route>, 8);
    expect(view.nodes.map((n) => `${n.name} ${n.layer ?? ''}`)).toEqual([
      'POST /invoices/{id}/cancel ',
      'CancelInvoiceHandler presentation',
      'CancelInvoiceDto application',
      'InvoiceService application',
      'InvoiceRepository infrastructure',
      'Invoice domain',
    ]);

    write(root, design);
    const real = await Project.open(root, { scip: false });
    expect(real.graph.nodes.find((n) => n.name === 'InvoiceService')?.layer).toBe('application');
    expect(real.graph.nodes.find((n) => n.name === 'InvoiceService')?.tags ?? []).not.toContain('ghost');
    expect(real.graph.nodes.find((n) => n.name === 'Invoice')?.role).toBe('entity');
  });
});

test('входът става полета на DTO (или параметри без DTO), изходът — полета на entity', () => {
  const bp = blueprint({
    stack: 'python-fastapi',
    style: 'layered',
    endpoints: [
      { method: 'POST', path: '/invoices', input: { customerId: 'int', due: 'date' }, output: { total: 'float' } },
      { method: 'GET', path: '/invoices', input: { status: 'string' }, output: { lines: 'list[string]' } },
    ],
  });
  const text = (id: string) =>
    bp.types[id]?.fields.map((f) => `${f.name}:${f.type.kind === 'primitive' ? f.type.name : f.type.kind}`);
  expect(text('python:app.invoices.schemas.CreateInvoiceDto')).toEqual(['customer_id:int', 'due:date']);
  expect(text('python:app.invoices.models.Invoice')).toEqual(['total:float', 'lines:array']);
  const ddd = blueprint({
    stack: 'php-mezzio',
    style: 'ddd',
    endpoints: [{ method: 'PUT', path: '/invoices/{id}', input: { total: 'float' } }],
  });
  // методът на домейна получава полетата, не command-а от application
  const update = ddd.nodes.find((n) => n.name === 'Invoice')?.members.find((m) => m.name === 'update');
  expect(update?.inputs.map((p) => p.name)).toEqual(['total']);
  const service = bp.nodes.find((n) => n.name === 'InvoiceService');
  expect(service?.members.find((m) => m.name === 'list')?.inputs.map((p) => p.name)).toEqual(['status']);
});
