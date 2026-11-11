import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import type { GraphModel, Node } from '@archgraph/model';
import { nodeAdapter } from './adapter.ts';

const fixture = join(import.meta.dirname, '../../../fixtures/node-nestjs');
const files = readdirSync(fixture, { recursive: true, encoding: 'utf8' })
  .filter((f) => /\.[jt]s$/.test(f))
  .sort()
  .map((path) => ({ path, text: readFileSync(join(fixture, path), 'utf8') }));

// Етап 1: само нодове, членове и портове. Роли, framework и route-ове идват от правилата (етап 6).
const expected = (JSON.parse(readFileSync(join(fixture, 'expected.json'), 'utf8')) as GraphModel).nodes
  .filter((n) => n.kind !== 'route')
  .map(({ role, framework, layer, context, ...n }): Node => n);

describe('node-nestjs', async () => {
  const { nodes } = await nodeAdapter.read(files);

  test('същите нодове', () => {
    expect(nodes.map((n) => n.id).sort()).toEqual(expected.map((n) => n.id).sort());
  });

  test.each(expected.map((n) => [n.id, n] as const))('%s', (id, node) => {
    expect(nodes.find((n) => n.id === id)).toEqual(node);
  });
});

describe('конструкции извън fixture-а', async () => {
  const files = [
    { path: 'src/models/index.ts', text: 'export interface User { id: number }\n' },
    {
      path: 'src/users.ts',
      text: `import type { Request, Response } from 'express';
import { User as Account } from './models';
import * as db from './db.js';

export enum Role { Admin, Guest }

export const getUser = async (req: Request, res: Response): Promise<void> => {};

export abstract class Base {
  static create(...names: string[]): Base[] { return []; }
  abstract load(id?: number, opts: { force?: boolean } = {}): Account | null;
  #secret(): Record<string, Array<db.Row>> { return {}; }
}
`,
    },
    { path: 'src/db.ts', text: 'export interface Row { id: number }\n' },
    {
      path: 'src/legacy.js',
      text: `/**
 * @param {?string} name
 * @param {number=} limit
 * @param {*} extra
 * @returns {Promise<string[]>}
 */
export function find(name, limit, extra) {}

/**
 * @param {import('./db').Row[]} rows
 * @returns {Promise<{ ok: boolean, ids: readonly number[] }>}
 */
export function save(rows) {}
`,
    },
  ];
  const { nodes } = await nodeAdapter.read(files);
  const byId = (id: string) => nodes.find((n) => n.id === id);

  test('enum, стрелкова функция, абстрактен клас, index.ts', () => {
    expect(nodes.map((n) => [n.id, n.kind])).toEqual([
      ['node:src/models/index.ts#User', 'interface'],
      ['node:src/users.ts#Role', 'enum'],
      ['node:src/users.ts#getUser', 'function'],
      ['node:src/users.ts#Base', 'class'],
      ['node:src/db.ts#Row', 'interface'],
      ['node:src/legacy.js#find', 'function'],
      ['node:src/legacy.js#save', 'function'],
    ]);
    expect(byId('node:src/users.ts#getUser')?.members[0]).toMatchObject({
      async: true,
      inputs: [
        { name: 'req', type: { kind: 'named', id: 'node:express#Request' } },
        { name: 'res', type: { kind: 'named', id: 'node:express#Response' } },
      ],
    });
  });

  test('static + rest, абстрактен метод, alias импорт, shape, #private, namespace импорт', () => {
    const [create, load, secret] = byId('node:src/users.ts#Base')?.members ?? [];
    expect(create).toMatchObject({
      static: true,
      inputs: [{ name: 'names', type: { kind: 'array', of: { kind: 'primitive', name: 'string' } }, variadic: true }],
      output: { type: { kind: 'array', of: { kind: 'named', id: 'node:src/users.ts#Base' } } },
    });
    expect(load?.inputs).toEqual([
      { name: 'id', type: { kind: 'primitive', name: 'number' }, optional: true },
      {
        name: 'opts',
        type: {
          kind: 'shape',
          fields: [{ name: 'force', type: { kind: 'primitive', name: 'boolean' }, optional: true }],
        },
        optional: true,
        default: '{}',
      },
    ]);
    expect(load?.output?.type).toEqual({
      kind: 'union',
      of: [
        { kind: 'named', id: 'node:src/models/index.ts#User' },
        { kind: 'primitive', name: 'null' },
      ],
    });
    expect(secret).toMatchObject({
      visibility: 'private',
      output: {
        type: {
          kind: 'map',
          key: { kind: 'primitive', name: 'string' },
          value: { kind: 'array', of: { kind: 'named', id: 'node:src/db.ts#Row' } },
        },
      },
    });
  });

  test('JSDoc: nullable, незадължителен, *, Promise', () => {
    expect(byId('node:src/legacy.js#find')?.members[0]).toMatchObject({
      async: true,
      inputs: [
        {
          name: 'name',
          type: {
            kind: 'union',
            of: [
              { kind: 'primitive', name: 'string' },
              { kind: 'primitive', name: 'null' },
            ],
          },
        },
        { name: 'limit', type: { kind: 'primitive', name: 'number' }, optional: true },
        { name: 'extra', type: { kind: 'primitive', name: 'any' } },
      ],
      output: { type: { kind: 'array', of: { kind: 'primitive', name: 'string' } } },
    });
  });

  test('JSDoc с вложени скоби и readonly', () => {
    expect(byId('node:src/legacy.js#save')?.members[0]?.inputs[0]?.type).toEqual({
      kind: 'array',
      of: { kind: 'named', id: 'node:src/db.ts#Row' },
    });
    expect(byId('node:src/legacy.js#save')?.members[0]?.output?.type).toEqual({
      kind: 'shape',
      fields: [
        { name: 'ok', type: { kind: 'primitive', name: 'boolean' } },
        { name: 'ids', type: { kind: 'array', of: { kind: 'primitive', name: 'number' } } },
      ],
    });
  });
});

test('ребра extends и implements през импорти', async () => {
  const { edges } = await nodeAdapter.read([
    { path: 'src/base.ts', text: 'export class Base<T> {}\nexport interface I {}' },
    {
      path: 'src/a.ts',
      text: `import { Base as B, I } from './base.js';
import * as ns from './base.js';
class A extends B<string> implements I, ns.I {}
class M extends mixin(B) {}
interface K extends I, ns.I {}`,
    },
  ]);
  expect(edges.map((e) => `${e.kind} ${e.from.node} -> ${e.to.node}`)).toEqual([
    'extends node:src/a.ts#A -> node:src/base.ts#Base',
    'implements node:src/a.ts#A -> node:src/base.ts#I',
    'implements node:src/a.ts#A -> node:src/base.ts#I',
    'extends node:src/a.ts#K -> node:src/base.ts#I',
    'extends node:src/a.ts#K -> node:src/base.ts#I',
  ]);
});

test('извиквания с низ като път: `${x}` в шаблонен низ е {}', async () => {
  const { paths } = await nodeAdapter.read([
    {
      path: 'src/api.ts',
      text: `export class Api {
  constructor(private http: HttpClient) {}
  album(id: number) {
    return this.http.get<Album>(\`/api/albums/\${id}\`);
  }
  title() {
    return this.router.navigate(['/albums']);
  }
}
`,
    },
  ]);
  expect(paths).toEqual([
    { from: { node: 'node:src/api.ts#Api', member: 'album' }, line: 4, name: 'get', strings: ['/api/albums/{}'] },
  ]);
});
