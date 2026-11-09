import { cpSync, mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { pattern, renamer } from './pattern.ts';
import { GraphQuery } from './query.ts';
import { scan } from './scan.ts';

const fixtures = join(import.meta.dirname, '../../../fixtures');

test('renamer: всички форми, множествено число и съставни думи', () => {
  const r = renamer('Order', 'Invoice');
  expect(r('OrderService')).toBe('InvoiceService');
  expect(r('src/Order/Service/OrderService.php')).toBe('src/Invoice/Service/InvoiceService.php');
  expect(r('POST /orders')).toBe('POST /invoices');
  expect(r('getOrder order_id ORDER_STATUS')).toBe('getInvoice invoice_id INVOICE_STATUS');
  expect(renamer('payment', 'line_item')('list_payments PaymentForm')).toBe('list_line_items LineItemForm');
  expect(renamer('category', 'box')('categories Category')).toBe('boxes Box');
});

test('като OrderService за Invoice: съседите по име, не по път; регистрациите с новия ред', async () => {
  const { graph } = await scan(join(fixtures, 'php-mezzio'), { scip: false });
  const [example] = new GraphQuery(graph).find('OrderService');
  const p = pattern(graph, example!, 'Invoice');
  expect(p.from).toBe('Order');
  const names = p.ghosts.map((g) => g.name);
  expect(names).toContain('InvoiceService');
  expect(names).toContain('InvoiceServiceFactory');
  expect(names).toContain('DoctrineInvoiceRepository');
  expect(names).toContain('POST /invoices');
  // в папка Order, но без Order в името: не е част от образеца
  expect(names).not.toContain('PriceCalculator');
  expect(p.ghosts.find((g) => g.name === 'InvoiceService')).toMatchObject({
    file: 'src/Invoice/Service/InvoiceService.php',
    exampleFile: 'src/Order/Service/OrderService.php',
    members: [
      '__construct(invoices: InvoiceRepositoryInterface, prices: PriceCalculator)',
      'place(dto: PlaceInvoiceDto): Invoice',
      'get(id: int): Invoice | null',
    ],
  });
  expect(p.registrations.find((r) => r.line === 27)).toEqual({
    file: 'src/ConfigProvider.php',
    line: 27,
    text: 'Service\\OrderServiceInterface::class => Service\\OrderService::class,',
    suggested: 'Service\\InvoiceServiceInterface::class => Service\\InvoiceService::class,',
  });
  expect(p.view.nodes.filter((n) => n.tags.includes('ghost')).length).toBe(p.ghosts.length);
});

test('когато файлът се появи, нодът вече не е ghost', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'archgraph-'));
  cpSync(join(fixtures, 'php-mezzio'), dir, { recursive: true });
  mkdirSync(join(dir, 'src/Invoice/Service'), { recursive: true });
  writeFileSync(
    join(dir, 'src/Invoice/Service/InvoiceServiceInterface.php'),
    '<?php\nnamespace App\\Invoice\\Service;\ninterface InvoiceServiceInterface {}',
  );
  const { graph } = await scan(dir, { scip: false });
  const [example] = new GraphQuery(graph).find('OrderService');
  const p = pattern(graph, example!, 'Invoice');
  expect(p.ghosts.map((g) => g.name)).not.toContain('InvoiceServiceInterface');
  expect(p.view.nodes.find((n) => n.name === 'InvoiceServiceInterface')?.tags).not.toContain('ghost');
});
