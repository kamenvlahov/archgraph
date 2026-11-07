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
    expect(graph.nodes.map((n) => n.id).sort()).toEqual(expected.nodes.map((n) => n.id).sort());
  });

  test('route нодовете като expected.json', async () => {
    const expected = JSON.parse(readFileSync(join(fixtures, name, 'expected.json'), 'utf8')) as GraphModel;
    const { graph, report } = await scan(join(fixtures, name), { scip: false });
    expect(graph.nodes.filter((n) => n.kind === 'route')).toEqual(expected.nodes.filter((n) => n.kind === 'route'));
    expect(report.frameworks).toEqual([expected.nodes[0]?.framework]);
  });
});

test('смесен проект с трите езика', async () => {
  const { graph, report } = await scan(fixtures);
  expect(report.files).toEqual({ php: 18, node: 13, python: 10 });
  expect(graph.nodes.length).toBe(17 + 15 + 17);
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

describe.each(['php-mezzio', 'node-nestjs', 'python-fastapi'])('types: %s', (name) => {
  test('полетата като expected.json', async () => {
    const expected = JSON.parse(readFileSync(join(fixtures, name, 'expected.json'), 'utf8')) as GraphModel;
    const { graph } = await scan(join(fixtures, name), { scip: false });
    expect(graph.types).toEqual(expected.types);
  });
});

describe.each(['php-mezzio', 'node-nestjs', 'python-fastapi'])('неразрешени: %s', (name) => {
  test('извикванията без получател като expected.json', async () => {
    const expected = JSON.parse(readFileSync(join(fixtures, name, 'expected.json'), 'utf8')) as GraphModel;
    const { graph } = await scan(join(fixtures, name), { scip: false });
    expect(graph.unresolved).toEqual(expected.unresolved);
  });
});

test('неразрешени: без тип и непозната функция от проекта; външните не са пропуск', async () => {
  const dir = project({
    'app/__init__.py': '',
    'app/repo.py': 'class Repo:\n    def get(self, k: str) -> int: ...\n    def save(self) -> None: ...\n',
    'app/jobs.py': `import os
from typing import TYPE_CHECKING
from alembic import context
from app import missing
from app.repo import Repo

if TYPE_CHECKING:
    from app.repo import Repo as R


def save() -> None: ...


def run(repo: Repo, data: dict[str, int], untyped, r: "R") -> None:
    data.get("a")
    os.environ.get("X")
    context.save()
    repo.get("a")
    r.save()
    untyped.save()
    missing.get()
    untyped.save()
`,
  });
  const { graph } = await scan(dir, { scip: false });
  expect(graph.unresolved).toEqual([{ from: { node: 'python:app.jobs.run', member: 'run' }, name: 'save', line: 20 }]);
  expect(graph.edges.map((e) => e.id)).toContain('calls:python:app.jobs.run#run->python:app.repo.Repo#save');
});

test('routes: префикс от include_router и от присвояване с prefix=, без framework няма route-ове', async () => {
  const files = {
    'app/__init__.py': '',
    'app/a.py':
      'from fastapi import APIRouter\nrouter = APIRouter(prefix="/a")\n\n@router.get("/{x}")\ndef get_a(x: int): ...\n',
    'app/b.py': 'from fastapi import APIRouter\nrouter = APIRouter()\n\n@router.post("")\ndef post_b(): ...\n',
    'app/main.py': `from fastapi import FastAPI
from app.a import router as a_router
from app import b

def create_app() -> FastAPI:
    app = FastAPI()
    app.include_router(a_router, prefix="/api")
    return app

feature = Feature(router=b.router, prefix="/b")
`,
  };
  const { graph } = await scan(project({ ...files, 'pyproject.toml': 'dependencies = ["fastapi"]' }), { scip: false });
  expect(graph.edges.filter((e) => e.kind === 'routes-to').map((e) => e.id)).toEqual([
    'routes-to:python:route:GET /api/a/{x}->python:app.a.get_a#get_a',
    'routes-to:python:route:POST /b->python:app.b.post_b#post_b',
  ]);
  const plain = await scan(project(files), { scip: false });
  expect(plain.graph.nodes.filter((n) => n.kind === 'route')).toEqual([]);
});

describe.each(['php-mezzio', 'node-nestjs', 'python-fastapi'])('ребра: %s', (name) => {
  test('extends, implements, injects, calls, creates и routes-to като expected.json', async () => {
    const kinds = ['extends', 'implements', 'injects', 'calls', 'creates', 'routes-to'];
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
import shop.pricing


class Item:
    def sub(self) -> float:
        shop.pricing.apply(2)
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

test('calls през поле на друг клас', async () => {
  const dir = project({
    'Svc.php':
      '<?php\nclass Repo { public function find(): void {} }\nclass Svc { public function __construct(public Repo $repo) {} }',
    'Job.php': '<?php\nclass Job { public function run(Svc $svc): void { $svc->repo->find(); } }',
  });
  const { graph } = await scan(dir, { scip: false });
  expect(graph.edges.map((e) => e.id)).toContain('calls:php:Job#run->php:Repo#find');
});

test('полета в Python: Field без default, ClassVar, self.x в __init__', async () => {
  const dir = project({
    'm.py': `from typing import ClassVar
from pydantic import BaseModel, Field


class Repo:
    pass


class In(BaseModel):
    a: int = Field(gt=0)
    b: int = Field(1)
    c: list[int] = Field(default_factory=list)
    d: int = Field(..., ge=1)
    count: ClassVar[int] = 0


class Svc:
    def __init__(self, repo: Repo, n):
        self.repo = repo
        self.cache: dict[str, int] = {}
        self.other = n.x
`,
  });
  const { graph } = await scan(dir, { scip: false });
  expect(graph.types['python:m.In']?.fields.map((f) => [f.name, f.optional ?? false])).toEqual([
    ['a', false],
    ['b', true],
    ['c', true],
    ['d', false],
  ]);
  expect(graph.types['python:m.Svc']?.fields.map((f) => [f.name, f.type.kind])).toEqual([
    ['repo', 'named'],
    ['cache', 'map'],
    ['other', 'unknown'],
  ]);
});

test('aiohttp: route от вложена функция с декоратор, която е собствен нод (D-013)', async () => {
  const dir = project({
    'requirements.txt': 'aiohttp>=3\n',
    'server.py': `from aiohttp import web


class PromptServer:
    def __init__(self):
        routes = web.RouteTableDef()

        @routes.post("/prompt")
        async def post_prompt(request):
            return self.queue_info()

        def helper():
            return self.queue_info()

    def queue_info(self) -> dict:
        return {}
`,
  });
  const { graph } = await scan(dir, { scip: false });
  const ids = graph.edges.map((e) => e.id);
  expect(graph.nodes.map((n) => n.id)).toContain('python:server.PromptServer.__init__.post_prompt');
  // closure без декоратор не е нод: извикванията му остават в __init__
  expect(graph.nodes.map((n) => n.id)).not.toContain('python:server.PromptServer.__init__.helper');
  expect(ids).toContain(
    'routes-to:python:route:POST /prompt->python:server.PromptServer.__init__.post_prompt#post_prompt',
  );
  expect(ids).toContain(
    'calls:python:server.PromptServer.__init__.post_prompt#post_prompt->python:server.PromptServer#queue_info',
  );
  expect(ids).toContain('calls:python:server.PromptServer#__init__->python:server.PromptServer#queue_info');
});

test('Flask: Blueprint с url_prefix, разпознат и при Flask с главна буква', async () => {
  const dir = project({
    'requirements.txt': 'Flask==3.0\n',
    'app/orders.py': `from flask import Blueprint

bp = Blueprint("orders", __name__, url_prefix="/orders")


@bp.post("/<int:id>/pay")
def pay(id):
    return ""
`,
  });
  const { graph } = await scan(dir, { scip: false });
  expect(graph.nodes.filter((n) => n.kind === 'route').map((n) => n.name)).toEqual(['POST /orders/<int:id>/pay']);
});

test('Angular: Routes с вложени children, component и loadComponent', async () => {
  const dir = project({
    'package.json': '{"dependencies": {"@angular/router": "^20"}}',
    'src/shell.ts': 'export class Shell {}',
    'src/plans.ts': 'export class Plans { open(): void {} }',
    'src/login.ts': 'export class Login {}',
    'src/app.routes.ts': `import { Routes } from '@angular/router';
import { Shell } from './shell';

export const routes: Routes = [
  { path: 'login', loadComponent: () => import('./login').then((m) => m.Login) },
  { path: 'legacy', redirectTo: 'login' },
  {
    path: 'operator',
    component: Shell,
    children: [{ path: 'plans/:id', loadComponent: () => import('./plans').then((m) => m.Plans) }],
  },
];
`,
  });
  const { graph } = await scan(dir, { scip: false });
  expect(
    graph.edges
      .filter((e) => e.kind === 'routes-to')
      .map((e) => `${e.from.node} -> ${e.to.node}`)
      .sort(),
  ).toEqual([
    'node:route:PAGE /login -> node:src/login.ts#Login',
    'node:route:PAGE /operator -> node:src/shell.ts#Shell',
    'node:route:PAGE /operator/plans/:id -> node:src/plans.ts#Plans',
  ]);
});
