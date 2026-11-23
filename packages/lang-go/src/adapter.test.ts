import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import type { GraphModel, Member, Node } from '@archgraph/model';
import { goAdapter, packagePath } from './adapter.ts';

const fixture = join(import.meta.dirname, '../../../fixtures/go-stdlib');
const files = readdirSync(fixture, { recursive: true, encoding: 'utf8' })
  .filter((f) => f.endsWith('.go'))
  .sort()
  .map((path) => ({ path, text: readFileSync(join(fixture, path), 'utf8') }));

const expected = (JSON.parse(readFileSync(join(fixture, 'expected.json'), 'utf8')) as GraphModel).nodes
  .filter((n) => n.kind !== 'route')
  .map(({ role, framework, layer, context, ...n }): Node => n);

// По файл, както ги чете engine-ът: методите от друг файл на пакета идват отделно.
async function readEach() {
  const parts = await Promise.all(files.map((f) => goAdapter.read([f], undefined, fixture)));
  // пакетът идва от всеки свой файл; engine-ът пази първия
  const nodes = parts.flatMap((p) => p.nodes).filter((n, i, all) => all.findIndex((x) => x.id === n.id) === i);
  for (const { node, member } of parts.flatMap((p) => p.methods ?? []))
    nodes.find((n) => n.id === node)?.members.push(member);
  return nodes;
}

describe('go-stdlib', async () => {
  const nodes = await readEach();

  test('същите нодове, без тестовите файлове', () => {
    expect(nodes.map((n) => n.id).sort()).toEqual(expected.map((n) => n.id).sort());
  });

  test.each(expected.map((n) => [n.id, n] as const))('%s', (id, node) => {
    expect(nodes.find((n) => n.id === id)).toEqual(node);
  });
});

test('пакетът е модулът от go.mod плюс папката; без go.mod е папката', () => {
  expect(packagePath('internal/order/service.go', fixture)).toBe('shop/internal/order');
  expect(packagePath('main.go', fixture)).toBe('shop');
  expect(packagePath('internal/order/service.go', undefined)).toBe('internal/order');
  expect(packagePath('main.go', undefined)).toBe('.');
});

describe('конструкции извън fixture-а', async () => {
  const { nodes, edges, methods } = await goAdapter.read([
    {
      path: 'store/store.go',
      text: `package store

import (
	ctx "context"
	"example.com/lib/cache"
)

type Reader interface {
	Get(key string) ([]byte, error)
}

type ReadWriter interface {
	Reader
	Put(c ctx.Context, key string, value []byte) error
}

type Cache[T any] struct {
	items map[string]T
	ttl   int
	remote *cache.Client
}

type Status string

type Alias = Status

func Join(sep string, parts ...string) (out string, n int) { return "", 0 }

func Pair(int, string) {}

func (c *Cache[T]) Load(key string) (T, bool) {
	var zero T
	return zero, false
}

func (s Status) Valid() bool { return s != "" }
`,
    },
  ]);
  const byName = (name: string) => nodes.find((n) => n.name === name);
  const p = (name: string) => ({ kind: 'primitive', name });

  test('interface с вграден interface: extends и таг structural', () => {
    expect(byName('ReadWriter')).toMatchObject({ kind: 'interface', tags: ['structural'] });
    expect(edges.map((e) => e.id)).toContain('extends:go:store.ReadWriter->go:store.Reader');
    expect(byName('ReadWriter')?.members[0]?.inputs[0]?.type).toEqual({ kind: 'named', id: 'go:context.Context' });
  });

  test('generic struct, именуван тип с методи; alias не е нод', () => {
    expect(nodes.map((n) => n.id)).toEqual([
      'go:store',
      'go:store.Reader',
      'go:store.ReadWriter',
      'go:store.Cache',
      'go:store.Status',
      'go:store.Join',
      'go:store.Pair',
    ]);
    expect(byName('Status')?.members.map((m) => m.name)).toEqual(['Valid']);
    expect(methods).toEqual([]);
  });

  test('variadic, именувани резултати, безименни параметри', () => {
    const join = byName('Join')?.members[0] as Member;
    expect(join.inputs[1]).toEqual({ name: 'parts', type: p('string'), variadic: true });
    expect(join.output?.type).toEqual({
      kind: 'shape',
      fields: [
        { name: 'out', type: p('string') },
        { name: 'n', type: p('int') },
      ],
    });
    expect(byName('Pair')?.members[0]?.inputs.map((i) => i.name)).toEqual(['_0', '_1']);
  });

  test('параметърът на типа е примитив в методите; (T, bool) е два резултата', () => {
    const load = byName('Cache')?.members[0] as Member;
    expect(load.output?.type).toEqual({
      kind: 'shape',
      fields: [
        { name: '0', type: p('T') },
        { name: '1', type: p('bool') },
      ],
    });
  });

  test('метод в друг файл на пакета идва отделно', async () => {
    const other = await goAdapter.read([
      { path: 'store/more.go', text: 'package store\n\nfunc (c *Cache[T]) Drop() {}\n' },
    ]);
    expect(other.nodes.map((n) => [n.kind, n.id, n.name])).toEqual([['module', 'go:store', 'store']]);
    expect(other.methods?.map((m) => `${m.node}#${m.member.name}`)).toEqual(['go:store.Cache#Drop']);
  });
});
