import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import { saveDesign, type Design } from '@archgraph/rules';
import { blueprint, designWarnings, readEndpoint } from './design.ts';
import { skeleton } from './skeleton.ts';
import { designStatus } from './status.ts';
import { GraphQuery } from './query.ts';
import { processView } from './process.ts';
import { Project } from './scan.ts';

let root = '';
afterEach(() => rmSync(root, { recursive: true, force: true }));

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

test('GET без id до ендпойнт с id е списък; предупрежденията хващат повтор и печатна грешка', () => {
  const design: Design = {
    stack: 'php-mezzio',
    style: 'ddd',
    endpoints: [
      ep('GET /gallery/'),
      ep('GET /gallery/view/{id}'),
      ep('GET /galery/view/{id}'),
      ep('GET /admin/profile'),
    ],
  };
  expect(blueprint(design).nodes.map((n) => n.name)).toContain('ListGalleriesHandler');
  expect(designWarnings(design)).toEqual(['Gallery и Galery са различни ресурси; печатна грешка ли е?']);
  expect(
    designWarnings({ ...design, endpoints: [{ ...ep('GET /gallery'), output: { '[id, name]': 'array' } }] }),
  ).toEqual(['GET /gallery: изходът е тип, [тип] или {име: тип}; имената са букви, цифри и _']);
  expect(designWarnings({ ...design, endpoints: [ep('GET /gallery/{id}'), ep('GET /gallery/view/{id}')] })).toEqual([
    'GET /gallery/{id} и GET /gallery/view/{id} са едно и също действие (get Gallery); дай им различни пътища',
  ]);
});

test('изходът с полета е клас за отговора, вложените обекти са класове до него', () => {
  const design: Design = {
    stack: 'php-mezzio',
    style: 'ddd',
    endpoints: [
      {
        method: 'GET',
        path: '/galleries/{id}',
        output: { name: 'string', tags: ['string'], photos: [{ url: 'string', size: { w: 'int', h: 'int' } }] },
      },
    ],
  };
  const bp = blueprint(design);
  const text = (id: string) =>
    bp.types[id]?.fields.map((f) => `${f.name}:${f.type.kind === 'array' ? `${f.type.of.kind}[]` : f.type.kind}`);
  expect(text('php:App\\Gallery\\Application\\GetGalleryResult')).toEqual([
    'name:primitive',
    'tags:primitive[]',
    'photos:named[]',
  ]);
  expect(text('php:App\\Gallery\\Application\\Photo')).toEqual(['url:primitive', 'size:named']);
  expect(bp.types['php:App\\Gallery\\Entity\\Gallery']).toBeUndefined(); // entity-то не се пълни от изхода
  const size = bp.nodes.find((n) => n.name === 'Size');
  expect([size?.location.file, size?.role, size?.layer]).toEqual([
    'src/Gallery/Application/Size.php',
    'dto',
    'application',
  ]);
  expect(skeleton(bp, 'src/Gallery/Application/GetGalleryResult.php')).toContain('/** @var Photo[] */');
  // методите връщат класа за отговора
  const handler = bp.nodes.find((n) => n.name === 'GetGalleryQueryHandler');
  expect(handler?.members.find((m) => m.name === 'handle')?.output?.type).toEqual({
    kind: 'named',
    id: 'php:App\\Gallery\\Application\\GetGalleryResult',
  });
  // избран тип от падащото меню
  const picked = blueprint({ ...design, endpoints: [{ method: 'GET', path: '/galleries', output: ['Gallery'] }] });
  const list = picked.nodes.find((n) => n.name === 'ListGalleriesQueryHandler')?.members[1]?.output?.type;
  expect(list).toEqual({ kind: 'array', of: { kind: 'named', id: 'php:App\\Gallery\\Entity\\Gallery' } });
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
      endpoints: [
        { ...ep('POST /invoices'), input: { lines: [{ sku: 'string', qty: 'int' }] } },
        { ...ep('GET /invoices'), output: { customer: { name: 'string' }, lines: [{ sku: 'string' }] } },
        ep('POST /invoices/{id}/cancel'),
      ],
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
    // и проверката срещу чертежа не намира разминавания
    const status = designStatus(p.graph, design, bp);
    expect(status).not.toMatch(/Липсващи|Различни|Нарушения/);
  });

  test('статусът хваща липсващ метод, различен тип на изхода и липсващо поле', async () => {
    root = mkdtempSync(join(tmpdir(), 'archgraph-design-'));
    const design: Design = {
      stack: 'php-mezzio',
      style: 'layered',
      endpoints: [{ method: 'GET', path: '/galleries/{id}', output: { name: 'string', title: 'string' } }],
    };
    saveDesign(root, design);
    const bp = blueprint(design);
    for (const file of new Set(bp.nodes.map((n) => n.location.file))) {
      const code = skeleton(bp, file);
      if (!code || file.endsWith('.phtml')) continue;
      mkdirSync(dirname(join(root, file)), { recursive: true });
      appendFileSync(join(root, file), code);
    }
    const service = join(root, 'src/Gallery/Service/GalleryService.php');
    writeFileSync(service, readFileSync(service, 'utf8').replace('): GetGalleryResult', '): Gallery'));
    const result = join(root, 'src/Gallery/Dto/GetGalleryResult.php');
    writeFileSync(result, readFileSync(result, 'utf8').replace(/\n\s*public readonly string \$title,/, ''));
    const repo = join(root, 'src/Gallery/Repository/GalleryRepository.php');
    writeFileSync(repo, readFileSync(repo, 'utf8').replace(/public function findById[^;]*;/, ''));
    const p = await Project.open(root, { scip: false });
    const status = designStatus(p.graph, design, bp);
    expect(status).toContain('## Различни сигнатури (1)');
    expect(status).toContain('GalleryService#get');
    expect(status).toContain('## Липсващи полета (1)\n- GetGalleryResult: title: string');
    expect(status).toContain('## Липсващи методи (1)\n- GalleryRepository#findById(id: int): Gallery');
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

test('входът става полета на DTO (или параметри без DTO), изходът — клас, който методите връщат', () => {
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
  expect(text('python:app.invoices.schemas.CreateInvoiceResult')).toEqual(['total:float']);
  // при списък полетата са на един елемент
  expect(text('python:app.invoices.schemas.InvoiceItem')).toEqual(['lines:array']);
  const ddd = blueprint({
    stack: 'php-mezzio',
    style: 'ddd',
    endpoints: [{ method: 'PUT', path: '/invoices/{id}', input: { total: 'float' } }],
  });
  // методът на домейна получава полетата, не command-а от application
  const update = ddd.nodes.find((n) => n.name === 'Invoice')?.members.find((m) => m.name === 'update');
  expect(update?.inputs.map((p) => p.name)).toEqual(['total']);
  // съобщението носи и id-то от пътя
  const command = ddd.types['php:App\\Invoice\\Application\\UpdateInvoiceCommand'];
  expect(command?.fields.map((f) => f.name)).toEqual(['id', 'total']);
  const service = bp.nodes.find((n) => n.name === 'InvoiceService');
  const list = service?.members.find((m) => m.name === 'list');
  expect(list?.inputs.map((p) => p.name)).toEqual(['status']);
  expect(list?.output?.type).toEqual({
    kind: 'array',
    of: { kind: 'named', id: 'python:app.invoices.schemas.InvoiceItem' },
  });
});

test('статусът хваща липсващ метод, различен тип на изхода и липсващо поле', async () => {
  root = mkdtempSync(join(tmpdir(), 'archgraph-design-'));
  const design: Design = {
    stack: 'php-mezzio',
    style: 'layered',
    endpoints: [{ method: 'GET', path: '/galleries/{id}', output: { name: 'string', title: 'string' } }],
  };
  saveDesign(root, design);
  const bp = blueprint(design);
  for (const file of new Set(bp.nodes.map((n) => n.location.file))) {
    const code = skeleton(bp, file);
    if (!code || file.endsWith('.phtml')) continue;
    mkdirSync(dirname(join(root, file)), { recursive: true });
    appendFileSync(join(root, file), code);
  }
  const edit = (file: string, from: RegExp | string, to: string) =>
    writeFileSync(join(root, file), readFileSync(join(root, file), 'utf8').replace(from, to));
  edit('src/Gallery/Service/GalleryService.php', '): GetGalleryResult', '): Gallery');
  edit('src/Gallery/Dto/GetGalleryResult.php', /\n\s*public readonly string \$title,/, '');
  edit('src/Gallery/Repository/GalleryRepository.php', /public function findById[^;]*;/, '');
  const p = await Project.open(root, { scip: false });
  const status = designStatus(p.graph, design, bp);
  expect(status).toContain('## Различни сигнатури (1)\n- GalleryService#get');
  expect(status).toContain('## Липсващи полета (1)\n- GetGalleryResult: title: string');
  expect(status).toContain('## Липсващи методи (1)\n- GalleryRepository#findById(id: int): Gallery');
});

test('repository-то връща entity-та, търсенето е метод в него, вложеният обект не повтаря ресурс', () => {
  const bp = blueprint({
    stack: 'php-mezzio',
    style: 'ddd',
    endpoints: [
      { method: 'GET', path: '/albums', output: { title: 'string' } },
      { method: 'GET', path: '/albums/search', input: { q: 'string' }, output: [{ title: 'string' }] },
      { method: 'GET', path: '/albums/{id}', output: { photos: [{ url: 'string' }] } },
      { method: 'GET', path: '/photos/{id}' },
      { method: 'GET', path: '/users/me', entity: 'User', action: 'current' },
    ],
  });
  // действие без критерии (текущият потребител) е findById, не търсене
  expect(bp.nodes.find((n) => n.name === 'UserRepository')?.members.map((m) => m.name)).toEqual(['findById']);
  const repo = bp.nodes.find((n) => n.name === 'AlbumRepository');
  const sig = (name: string) => {
    const m = repo?.members.find((x) => x.name === name);
    return `${m?.inputs.map((p) => p.name).join(',')} → ${JSON.stringify(m?.output?.type)}`;
  };
  const albums = JSON.stringify({ kind: 'array', of: { kind: 'named', id: 'php:App\\Album\\Entity\\Album' } });
  expect(sig('findAll')).toBe(` → ${albums}`);
  expect(sig('search')).toBe(`q → ${albums}`);
  expect(bp.nodes.map((n) => n.name)).toContain('AlbumPhoto');
  expect(bp.nodes.filter((n) => n.name === 'Photo').map((n) => n.role)).toEqual(['entity']);
});

test('create получава параметрите от пътя; действие без id не е метод на агрегата', () => {
  const bp = blueprint({
    stack: 'php-mezzio',
    style: 'ddd',
    endpoints: [
      { method: 'POST', path: '/albums/{albumId}/photos', input: { title: 'string' } },
      { method: 'POST', path: '/users/login', input: { email: 'string' } },
      { method: 'POST', path: '/invoices/{id}/cancel' },
    ],
  });
  const members = (name: string) =>
    bp.nodes.find((n) => n.name === name)?.members.map((m) => `${m.name}(${m.inputs.map((p) => p.name).join(',')})`);
  expect(members('Photo')).toEqual(['create(albumId,title)']);
  expect(members('User')).toEqual([]);
  expect(members('Invoice')).toEqual(['cancel()']);
});

test('статусът отделя допълнителните зависимости в конструктора от разминаванията', async () => {
  root = mkdtempSync(join(tmpdir(), 'archgraph-design-'));
  const design: Design = { stack: 'php-mezzio', style: 'layered', endpoints: [ep('GET /galleries/{id}')] };
  saveDesign(root, design);
  const bp = blueprint(design);
  writeFileSync(join(root, 'composer.json'), '{"require": {"mezzio/mezzio": "^3.0"}}');
  for (const file of new Set(bp.nodes.map((n) => n.location.file))) {
    const code = skeleton(bp, file);
    if (!code || file.endsWith('.phtml')) continue;
    mkdirSync(dirname(join(root, file)), { recursive: true });
    appendFileSync(join(root, file), code);
  }
  const service = join(root, 'src/Gallery/Service/GalleryService.php');
  writeFileSync(
    service,
    readFileSync(service, 'utf8').replace(
      'private readonly GalleryRepository $galleryRepository,',
      'private readonly GalleryRepository $galleryRepository,\n        private readonly \\PDO $db,',
    ),
  );
  const status = designStatus((await Project.open(root, { scip: false })).graph, design, bp);
  expect(status).toContain('## Зависимости извън чертежа (1)\n- GalleryService: db: PDO');
  expect(status).not.toContain('Различни');
  expect(status).toContain('Всичко от чертежа е в кода и съвпада.');
});
