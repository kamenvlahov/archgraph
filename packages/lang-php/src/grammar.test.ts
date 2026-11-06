import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { parse, syntaxErrors } from '@archgraph/syntax';
import { phpParser } from './grammar.ts';

const fixture = join(import.meta.dirname, '../../../fixtures/php-mezzio');
const files = readdirSync(fixture, { recursive: true, encoding: 'utf8' }).filter((f) => /(\.php)$/.test(f));

test('граматиката се зарежда от .wasm', async () => {
  expect(parse(await phpParser(), '').rootNode.type).toBe('program');
});

test.each(files)('%s се парсва без грешки', async (file) => {
  const tree = parse(await phpParser(), readFileSync(join(fixture, file), 'utf8'));
  expect(syntaxErrors(tree)).toEqual([]);
});

test('счупеният код се хваща', async () => {
  const tree = parse(await phpParser(), '<?php\nclass {\n  public function (): void {}\n');
  expect(syntaxErrors(tree).length).toBeGreaterThan(0);
});
