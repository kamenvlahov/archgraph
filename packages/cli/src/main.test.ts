import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test, vi } from 'vitest';
import { validate } from '@archgraph/model';
import { main } from './main.ts';

test('scan записва валиден граф и печата резюме', async () => {
  const out = join(mkdtempSync(join(tmpdir(), 'archgraph-')), 'graph.json');
  const log = vi.spyOn(console, 'error').mockImplementation(() => {});
  const code = await main(['scan', join(import.meta.dirname, '../../../fixtures/python-fastapi'), '-o', out]);
  expect(code).toBe(0);
  expect(validate(JSON.parse(readFileSync(out, 'utf8'))).ok).toBe(true);
  expect(log.mock.calls[0]?.[0]).toMatch(/^archgraph: 10 файла \(python 10\) → 16 нода/);
  log.mockRestore();
});

test('непозната команда показва помощ', async () => {
  const log = vi.spyOn(console, 'error').mockImplementation(() => {});
  expect(await main(['frobnicate'])).toBe(1);
  expect(log.mock.calls[0]?.[0]).toMatch(/^archgraph scan/);
  log.mockRestore();
});
