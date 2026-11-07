import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, expect, test } from 'vitest';
import type { GraphModel } from '@archgraph/model';
import { isExcluded } from './files.ts';
import { scan } from './scan.ts';

const fixtures = join(import.meta.dirname, '../../../fixtures');

function project(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'archgraph-'));
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), text);
  }
  return dir;
}

describe.each(['php-mezzio', 'node-nestjs', 'python-fastapi'])('%s', (name) => {
  test('същите нодове като expected.json', async () => {
    const expected = JSON.parse(readFileSync(join(fixtures, name, 'expected.json'), 'utf8')) as GraphModel;
    const { graph } = await scan(join(fixtures, name));
    expect(graph.root).toBe(join(fixtures, name));
    expect(graph.nodes.map((n) => n.id).sort()).toEqual(
      expected.nodes
        .filter((n) => n.kind !== 'route')
        .map((n) => n.id)
        .sort(),
    );
  });
});

test('смесен проект с трите езика', async () => {
  const { graph, report } = await scan(fixtures);
  expect(report.files).toEqual({ php: 17, node: 13, python: 10 });
  expect(graph.nodes.length).toBe(16 + 15 + 16);
});

test('изключени папки, бъндъли и собствени шаблони', async () => {
  const dir = project({
    'src/App.php': '<?php class App {}',
    'vendor/lib/Lib.php': '<?php class Lib {}',
    'node_modules/x/index.js': 'export function x() {}',
    'web/app.min.js': 'function a(){}',
    'web/bundle.js': `export function big() {}\n${'//'.padEnd(2000, 'x')}`,
    'legacy/Old.php': '<?php class Old {}',
  });
  const { graph, report } = await scan(dir, { exclude: ['legacy'], maxFileSize: 1000 });
  expect(graph.nodes.map((n) => n.id)).toEqual(['php:App']);
  expect(report.tooBig).toEqual(['web/bundle.js']);
});

test('еднакви пълни имена остават и двете, с таг duplicate', async () => {
  const dir = project({
    'a/Form.php': '<?php\nnamespace Admin;\nclass Form {}',
    'b/Form.php': '<?php\nnamespace Admin;\nclass Form {}',
  });
  const { graph, report } = await scan(dir);
  expect(report.duplicates).toEqual(['php:Admin\\Form']);
  expect(graph.nodes.map((n) => [n.id, n.tags])).toEqual([
    ['php:Admin\\Form', ['duplicate']],
    ['php:Admin\\Form@b/Form.php', ['duplicate']],
  ]);
});

test('шаблони за изключване', () => {
  expect(isExcluded('a/vendor/b.php', ['vendor'])).toBe(true);
  expect(isExcluded('a/vendors/b.php', ['vendor'])).toBe(false);
  expect(isExcluded('web/x.min.js', ['*.min.js'])).toBe(true);
  expect(isExcluded('src/legacy/a/b.ts', ['src/legacy/**'])).toBe(true);
  expect(isExcluded('lib/src/legacy/b.ts', ['src/legacy/**'])).toBe(false);
});

describe.each(['php-mezzio', 'node-nestjs', 'python-fastapi'])('ребра: %s', (name) => {
  test('extends, implements, injects, calls и creates като expected.json', async () => {
    const kinds = ['extends', 'implements', 'injects', 'calls', 'creates'];
    const expected = JSON.parse(readFileSync(join(fixtures, name, 'expected.json'), 'utf8')) as GraphModel;
    const { graph } = await scan(join(fixtures, name));
    const key = (e: GraphModel['edges'][number]) => `${e.kind} ${JSON.stringify(e.from)} -> ${JSON.stringify(e.to)}`;
    expect(
      graph.edges
        .filter((e) => kinds.includes(e.kind))
        .map(key)
        .sort(),
    ).toEqual(
      expected.edges
        .filter((e) => kinds.includes(e.kind))
        .map(key)
        .sort(),
    );
  });
});

test('injects от nullable тип, без масиви и външни типове', async () => {
  const dir = project({
    'Repo.php': '<?php\ninterface Repo {}',
    'Log.php': '<?php\nclass Log {}',
    'Item.php': '<?php\nclass Item {}',
    'Svc.php': `<?php
class Svc extends \\Vendor\\Base implements Repo {
    /** @param Item[] $items */
    public function __construct(?Repo $repo, Log|Item $log, array $items, \\Psr\\Log $ext) {}
}`,
  });
  const { graph } = await scan(dir);
  expect(graph.edges.map((e) => e.id).sort()).toEqual([
    'implements:php:Svc->php:Repo',
    'injects:php:Item->php:Svc#__construct.log',
    'injects:php:Log->php:Svc#__construct.log',
    'injects:php:Repo->php:Svc#__construct.repo',
  ]);
});

test('calls през верига, nullsafe, self:: и глобална функция', async () => {
  const dir = project({
    'helpers.php': '<?php\nfunction money() {}',
    'Repo.php': `<?php
namespace App;
class Order { public function total(): int {} }
class Repo {
    public function find(): ?Order {}
    public static function make(): self { return new self(); }
    public function run(): void {
        self::make()?->find()?->total();
        money();
    }
}`,
  });
  const { graph } = await scan(dir);
  expect(graph.edges.map((e) => e.id).sort()).toEqual([
    'calls:php:App\\Repo#run->php:App\\Order#total',
    'calls:php:App\\Repo#run->php:App\\Repo#find',
    'calls:php:App\\Repo#run->php:App\\Repo#make',
    'calls:php:App\\Repo#run->php:money#money',
    'creates:php:App\\Repo#make->php:App\\Repo',
  ]);
});

test('calls в Python: модул с alias, staticmethod, for и comprehension', async () => {
  const dir = project({
    'shop/pricing.py': 'def apply(x):\n    return x\n',
    'shop/models.py': `import shop.pricing as pricing


class Item:
    def sub(self) -> float:
        return pricing.apply(1)


class Cart:
    def __init__(self, items: list[Item]):
        self.items = items

    @staticmethod
    def empty() -> "Cart":
        return Cart([])

    def total(self):
        for item in self.items:
            item.sub()
        return [i.sub() for i in self.items]
`,
  });
  const { graph } = await scan(dir);
  expect(graph.edges.map((e) => e.id).sort()).toEqual([
    'calls:python:shop.models.Cart#total->python:shop.models.Item#sub',
    'calls:python:shop.models.Item#sub->python:shop.pricing.apply#apply',
    'creates:python:shop.models.Cart#empty->python:shop.models.Cart',
  ]);
});

test('calls в TS: поле, this.x = в конструктора, callback и наследен метод', async () => {
  const dir = project({
    'src/a.ts': `export class Base { id(): number { return 1; } }
export class Item extends Base { sub(): number { return 1; } }
export class Cart {
  items: Item[] = [];
  constructor(store) { this.store = new Item(); }
  total() {
    this.store.sub();
    return this.items.map((i) => i.id()).filter((x) => x);
  }
}`,
  });
  const { graph } = await scan(dir);
  expect(
    graph.edges
      .filter((e) => e.kind !== 'extends')
      .map((e) => e.id)
      .sort(),
  ).toEqual([
    'calls:node:src/a.ts#Cart#total->node:src/a.ts#Base#id',
    'calls:node:src/a.ts#Cart#total->node:src/a.ts#Item#sub',
    'creates:node:src/a.ts#Cart#constructor->node:src/a.ts#Item',
  ]);
});

test('поле от inject(X) или new X() има тип X', async () => {
  const dir = project({
    'src/api.ts': 'export class Api { load(): void {} }',
    'src/page.ts': `import { inject } from '@angular/core';
import { Api } from './api';
export class Page {
  private readonly api = inject(Api);
  private backup = new Api();
  open() { this.api.load(); this.backup.load(); }
}`,
  });
  const { graph } = await scan(dir);
  expect(graph.edges.map((e) => e.id).sort()).toEqual(['calls:node:src/page.ts#Page#open->node:src/api.ts#Api#load']);
});
