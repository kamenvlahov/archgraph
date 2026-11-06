import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { parse, syntaxErrors } from '@archgraph/syntax';
import { pythonParser } from './grammar.ts';

const fixture = join(import.meta.dirname, '../../../fixtures/python-fastapi');
const files = readdirSync(fixture, { recursive: true, encoding: 'utf8' }).filter((f) => /(\.py)$/.test(f));

test('граматиката се зарежда от .wasm', async () => {
  expect(parse(await pythonParser(), '').rootNode.type).toBe('module');
});

test.each(files)('%s се парсва без грешки', async (file) => {
  const tree = parse(await pythonParser(), readFileSync(join(fixture, file), 'utf8'));
  expect(syntaxErrors(tree)).toEqual([]);
});
