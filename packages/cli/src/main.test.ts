import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import type { Server } from 'node:http';
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

test('serve: REST ресурсите', async () => {
  const { serve } = await import('./serve.ts');
  const root = join(import.meta.dirname, '../../../fixtures/php-mezzio');
  const server = await serve(root, 0, { scip: false });
  const base = url(server);
  try {
    const project = (await (await fetch(`${base}/api/project`)).json()) as { name: string; frameworks: string[] };
    expect(project).toMatchObject({ name: 'php-mezzio', frameworks: ['mezzio'] });
    const endpoints = (await (await fetch(`${base}/api/endpoints`)).json()) as { label: string }[];
    expect(endpoints.map((e) => e.label)).toEqual(['GET /orders/{id:\\d+}', 'POST /orders']);
    const view = (await (
      await fetch(`${base}/api/processes/${encodeURIComponent('php:route:POST /orders')}`)
    ).json()) as { nodes: unknown[] };
    expect(view.nodes.length).toBe(11);
    expect((await fetch(`${base}/api/processes/${encodeURIComponent('Nope')}`)).status).toBe(404);
    const plan = await fetch(`${base}/api/plans`, {
      method: 'POST',
      body: JSON.stringify({ task: 'x', targets: ['OrderService#place'] }),
    });
    expect(plan.status).toBe(201);
    expect(await plan.text()).toContain('### OrderService#place');
    const found = (await (await fetch(`${base}/api/search?q=orderserv`)).json()) as { label: string }[];
    expect(found.slice(0, 3).map((e) => e.label)).toEqual([
      'OrderService',
      'OrderServiceFactory',
      'OrderServiceInterface',
    ]);
    const at = await fetch(
      `${base}/api/nodes?file=${encodeURIComponent(join(root, 'src/Order/Service/OrderService.php'))}&line=22`,
    );
    expect(await at.json()).toEqual({ node: 'php:App\\Order\\Service\\OrderService', member: 'place' });
    expect((await fetch(`${base}/api/nope`)).status).toBe(404);
    expect((await fetch(`${base}/../../package.json`)).status).toBe(404);
  } finally {
    server.close();
  }
});

test('serve: промяна на сигнатура се вижда за под секунда', async () => {
  const { serve } = await import('./serve.ts');
  const dir = mkdtempSync(join(tmpdir(), 'archgraph-'));
  writeFileSync(join(dir, 'Svc.php'), '<?php\nclass Svc {\n    public function place(int $id): void {}\n}\n');
  const server = await serve(dir, 0, { scip: false });
  const base = url(server);
  const controller = new AbortController();
  try {
    const events = await fetch(`${base}/api/events`, { signal: controller.signal });
    const reader = events.body?.getReader();
    await reader?.read(); // коментарът при свързване
    const started = performance.now();
    writeFileSync(
      join(dir, 'Svc.php'),
      '<?php\nclass Svc {\n    public function place(int $id, string $code): void {}\n}\n',
    );
    const chunk = new TextDecoder().decode((await reader?.read())?.value);
    expect(chunk).toContain('event: changed');
    expect(performance.now() - started).toBeLessThan(1000);
    const view = (await (await fetch(`${base}/api/processes/Svc`)).json()) as {
      nodes: { members: { name: string; inputs: { name: string }[] }[] }[];
    };
    expect(view.nodes[0]?.members[0]?.inputs.map((p) => p.name)).toEqual(['id', 'code']);
  } finally {
    controller.abort();
    server.close();
  }
});

test('serve: чертежът от празна папка, и от панела във VS Code (CORS за PUT)', async () => {
  const { serve } = await import('./serve.ts');
  const dir = mkdtempSync(join(tmpdir(), 'archgraph-'));
  const server = await serve(dir, 0, { scip: false });
  const base = url(server);
  const origin = 'vscode-webview://panel';
  try {
    const preflight = await fetch(`${base}/api/design`, {
      method: 'OPTIONS',
      headers: { origin, 'access-control-request-method': 'PUT', 'access-control-request-headers': 'content-type' },
    });
    expect(preflight.headers.get('access-control-allow-origin')).toBe(origin);
    expect(preflight.headers.get('access-control-allow-methods')).toContain('PUT');

    const empty = (await (await fetch(`${base}/api/design`)).json()) as { design: unknown; styles: unknown[] };
    expect(empty.design).toBeNull();
    expect(empty.styles.length).toBeGreaterThan(0);
    const put = await fetch(`${base}/api/design`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', origin },
      body: JSON.stringify({
        stack: 'php-mezzio',
        style: 'layered',
        endpoints: [{ method: 'POST', path: '/invoices' }],
      }),
    });
    expect(put.status).toBe(200);
    expect(readFileSync(join(dir, '.archgraph/design.yaml'), 'utf8')).toContain('POST /invoices');
    const entries = (await (await fetch(`${base}/api/endpoints`)).json()) as { label: string; ghost?: boolean }[];
    expect(entries).toEqual([expect.objectContaining({ label: 'POST /invoices', ghost: true })]);
    expect(await (await fetch(`${base}/api/design/plan`)).text()).toContain('CreateInvoiceHandler');

    // пробата не записва: друг стил, а чертежът остава layered
    const trial = (await (await fetch(`${base}/api/design/status?style=ddd`)).json()) as {
      classes: { name: string; state: string; layer: string }[];
    };
    expect(trial.classes).toContainEqual(
      expect.objectContaining({ name: 'CreateInvoiceCommand', state: 'missing', layer: 'application' }),
    );
    expect(readFileSync(join(dir, '.archgraph/design.yaml'), 'utf8')).toContain('style: layered');
    expect((await fetch(`${base}/api/design/status?levels=Invoice:4`)).status).toBe(400);
    const efforts = (await (await fetch(`${base}/api/design/efforts`)).json()) as {
      styles: Record<string, { total: number }>;
    };
    expect(Object.keys(efforts.styles)).toContain('onion');
    // пробата и в графа: броячите на ендпойнтите и процесът по проверявания чертеж
    const counted = (await (await fetch(`${base}/api/endpoints?style=ddd`)).json()) as {
      trial: Record<string, number>;
    }[];
    expect(counted[0]?.trial.missing).toBeGreaterThan(0);
    const process = (await (
      await fetch(`${base}/api/processes/${encodeURIComponent('POST /invoices')}?style=ddd`)
    ).json()) as { nodes: { name: string; state?: string }[] };
    expect(process.nodes).toContainEqual(expect.objectContaining({ name: 'CreateInvoiceCommand', state: 'missing' }));
  } finally {
    server.close();
  }
});

function url(server: Server): string {
  const address = server.address();
  return `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`;
}
