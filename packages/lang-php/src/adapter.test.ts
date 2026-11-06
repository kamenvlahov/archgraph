import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import type { GraphModel, Node } from '@archgraph/model';
import { phpAdapter } from './adapter.ts';

const fixture = join(import.meta.dirname, '../../../fixtures/php-mezzio');
const files = readdirSync(fixture, { recursive: true, encoding: 'utf8' })
  .filter((f) => f.endsWith('.php'))
  .sort()
  .map((path) => ({ path, text: readFileSync(join(fixture, path), 'utf8') }));

// Етап 1: само нодове, членове и портове. Роли, framework и route-ове идват от правилата (етап 6).
const expected = (JSON.parse(readFileSync(join(fixture, 'expected.json'), 'utf8')) as GraphModel).nodes
  .filter((n) => n.kind !== 'route')
  .map(({ role: _role, framework: _framework, layer: _layer, context: _context, ...n }): Node => n);

describe('php-mezzio', async () => {
  const { nodes } = await phpAdapter.read(files);

  test('същите нодове', () => {
    expect(nodes.map((n) => n.id).sort()).toEqual(expected.map((n) => n.id).sort());
  });

  test.each(expected.map((n) => [n.id, n] as const))('%s', (id, node) => {
    expect(nodes.find((n) => n.id === id)).toEqual(node);
  });
});

test('счупено заглавие от PHP 5: името от текста + таг', async () => {
  const text = '<?php\nnamespace Zend\\Log;\n\nclass Null extends Noop\n{\n    public function write($e) {}\n}\n';
  const { nodes } = await phpAdapter.read([{ path: 'Null.php', text }]);
  expect(nodes.map((n) => [n.id, n.tags])).toEqual([['php:Zend\\Log\\Null', ['syntax-error']]]);
  expect(nodes[0]?.members.map((m) => m.name)).toEqual(['write']);
});

describe('конструкции извън fixture-а', async () => {
  const text = `<?php
namespace Shop\\Billing {
    use Shop\\Core\\{Money, Currency as Cur};

    enum Status: string
    {
        case Paid = 'paid';

        public function label(): string { return $this->value; }
    }

    trait Loggable
    {
        protected function log(string ...$lines): void {}
    }

    function total(Money|int $a, Cur&\\Countable $b, $c = [1, 2]): static {}
}
`;
  const { nodes } = await phpAdapter.read([{ path: 'a.php', text }]);
  const byId = (id: string) => nodes.find((n) => n.id === id);

  test('enum, trait и функция', () => {
    expect(nodes.map((n) => [n.id, n.kind])).toEqual([
      ['php:Shop\\Billing\\Status', 'enum'],
      ['php:Shop\\Billing\\Loggable', 'trait'],
      ['php:Shop\\Billing\\total', 'function'],
    ]);
    expect(byId('php:Shop\\Billing\\Status')?.members.map((m) => m.name)).toEqual(['label']);
  });

  test('variadic и protected', () => {
    expect(byId('php:Shop\\Billing\\Loggable')?.members[0]).toMatchObject({
      visibility: 'protected',
      inputs: [{ name: 'lines', type: { kind: 'primitive', name: 'string' }, variadic: true }],
    });
  });

  test('групов use, alias, union, intersection, default', () => {
    const fn = byId('php:Shop\\Billing\\total')?.members[0];
    expect(fn?.inputs).toEqual([
      {
        name: 'a',
        type: {
          kind: 'union',
          of: [
            { kind: 'named', id: 'php:Shop\\Core\\Money' },
            { kind: 'primitive', name: 'int' },
          ],
        },
      },
      { name: 'b', type: { kind: 'unknown', hint: 'Cur&\\Countable' } },
      { name: 'c', type: { kind: 'unknown' }, optional: true, default: '[1, 2]' },
    ]);
  });
});
