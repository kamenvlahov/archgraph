import { join } from 'node:path';
import { expect, test } from 'vitest';
import { draftDesign } from './draft.ts';
import { scan } from './scan.ts';

test('чертеж от написан код: стекът по framework-а, ендпойнтите от route-овете, стилът от папките', async () => {
  const { graph, report } = await scan(join(import.meta.dirname, '../../../fixtures/php-mezzio'), { scip: false });
  const draft = draftDesign(graph, report.frameworks);
  if (typeof draft === 'string') throw new Error(draft);
  expect(draft.design.stack).toBe('php-mezzio');
  expect(draft.design.endpoints).toEqual([
    { method: 'POST', path: '/orders' },
    { method: 'GET', path: '/orders/{id:\\d+}' },
  ]);
  expect(draft.why[0]).toMatch(/^слоеве по папките/);
  expect(draftDesign(graph, ['zf2'])).toMatch(/^няма чертеж за zf2/);
});
