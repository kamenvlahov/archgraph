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

test('serve: ендпойнти, процес и план по HTTP', async () => {
  const { serve } = await import('./serve.ts');
  const server = await serve(join(import.meta.dirname, '../../../fixtures/php-mezzio'), 0, { scip: false });
  const address = server.address();
  const base = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`;
  try {
    const project = (await (await fetch(`${base}/api/project`)).json()) as { entries: { label: string }[] };
    expect(project.entries.map((e) => e.label)).toEqual(['GET /orders/{id:\\d+}', 'POST /orders']);
    const view = (await (
      await fetch(`${base}/api/process?target=${encodeURIComponent('php:route:POST /orders')}`)
    ).json()) as {
      nodes: unknown[];
    };
    expect(view.nodes.length).toBe(11);
    const plan = await (
      await fetch(`${base}/api/plan?task=x&target=${encodeURIComponent('OrderService#place')}`)
    ).text();
    expect(plan).toContain('### OrderService#place');
    expect((await fetch(`${base}/../../package.json`)).status).toBe(404);
  } finally {
    server.close();
  }
});
