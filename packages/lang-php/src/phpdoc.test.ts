import { expect, test } from 'vitest';
import type { TypeRef } from '@archgraph/model';
import { parseDocComment, parseDocType } from './phpdoc.ts';

const named = (name: string, args?: TypeRef[]): TypeRef =>
  args ? { kind: 'named', id: name, args } : { kind: 'named', id: name };
const t = (text: string) => parseDocType(text, named);
const p = (name: string): TypeRef => ({ kind: 'primitive', name });

test('масиви и map', () => {
  expect(t('list<Order>')).toEqual({ kind: 'array', of: named('Order') });
  expect(t('Order[]')).toEqual({ kind: 'array', of: named('Order') });
  expect(t('array<string, int>')).toEqual({ kind: 'map', key: p('string'), value: p('int') });
  expect(t('array<int, list<string>>')).toEqual({
    kind: 'map',
    key: p('int'),
    value: { kind: 'array', of: p('string') },
  });
});

test('shape, nullable, union, генерици', () => {
  expect(t("array{id: int, 'name'?: string}")).toEqual({
    kind: 'shape',
    fields: [
      { name: 'id', type: p('int') },
      { name: 'name', type: p('string'), optional: true },
    ],
  });
  expect(t('?Order')).toEqual({ kind: 'union', of: [named('Order'), p('null')] });
  expect(t('int|string|null')).toEqual({ kind: 'union', of: [p('int'), p('string'), p('null')] });
  expect(t('Collection<int, Order>')).toEqual(named('Collection', [p('int'), named('Order')]));
  expect(t('non-empty-string')).toEqual(p('non-empty-string'));
});

test('стар код: ; накрая, &$x, $this', () => {
  const doc = parseDocComment('/** @param string &$x\n * @return string; */');
  expect([...doc.params]).toEqual([['x', 'string']]);
  expect(doc.return).toBe('string');
  expect(t('$this')).toEqual(named('$this'));
});

test('счупен тип става unknown с подсказка', () => {
  expect(t('array<int')).toEqual({ kind: 'unknown', hint: 'array<int' });
});

test('@param и @return, вкл. многоредови и variadic', () => {
  const doc = parseDocComment(`/**
     * Some text.
     * @param list<array{sku: string,
     *     quantity: int}> $items  the items
     * @param string ...$tags
     * @return array<string, mixed>
     */`);
  expect([...doc.params]).toEqual([
    ['items', 'list<array{sku: string, quantity: int}>'],
    ['tags', 'string'],
  ]);
  expect(doc.return).toBe('array<string, mixed>');
});
