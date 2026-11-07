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
  expect(log.mock.calls[0]?.[0]).toMatch(/^archgraph: 10 файла \(python 10\) → 19 нода/);
  log.mockRestore();
});

test('непозната команда показва помощ', async () => {
  const log = vi.spyOn(console, 'error').mockImplementation(() => {});
  expect(await main(['frobnicate'])).toBe(1);
  expect(log.mock.calls[0]?.[0]).toMatch(/^archgraph scan/);
  log.mockRestore();
});

test('plan: Markdown план и грешка при непознат нод', async () => {
  const out = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  const log = vi.spyOn(console, 'error').mockImplementation(() => {});
  const dir = join(import.meta.dirname, '../../../fixtures/python-fastapi');
  expect(await main(['plan', dir, '--no-scip', '-t', 'Отстъпки', '-n', 'OrderService#place'])).toBe(0);
  expect(await main(['plan', dir, '--no-scip', '-t', 'Отстъпки', '-n', 'Nope'])).toBe(1);
  expect(out.mock.calls.join('')).toContain('### OrderService#place  `app/orders/service.py:13`');
  expect(log).toHaveBeenCalledWith('Nope: няма такъв нод');
  out.mockRestore();
  log.mockRestore();
});
