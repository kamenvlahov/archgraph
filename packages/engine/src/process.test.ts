import { join } from 'node:path';
import { expect, test } from 'vitest';
import { processView } from './process.ts';
import { GraphQuery } from './query.ts';
import { scan } from './scan.ts';

const fixtures = join(import.meta.dirname, '../../../fixtures');

async function view(fixture: string, route: string) {
  const query = new GraphQuery((await scan(join(fixtures, fixture), { scip: false })).graph);
  const [node] = query.routes(route);
  if (!node) throw new Error(`няма route ${route}`);
  return processView(query, { node }, 6);
}

test('процесът от POST /orders в Mezzio: колони, роли, участващи методи', async () => {
  const v = await view('php-mezzio', 'POST /orders');
  const row = (name: string) => {
    const n = v.nodes.find((x) => x.name === name);
    return n && [n.column, n.role, n.members.map((m) => m.name).join(',')];
  };
  expect(row('POST /orders')).toEqual([0, 'route', '']);
  expect(row('PlaceOrderHandler')).toEqual([1, 'controller', 'handle']);
  expect(row('OrderServiceInterface')).toEqual([2, 'interface', 'place']);
  // имплементацията е в колоната на договора
  expect(row('OrderService')).toEqual([2, 'service', 'place']);
  expect(row('DoctrineOrderRepository')).toEqual([3, 'repository', 'save']);
  expect(v.nodes.find((n) => n.name === 'OrderService')?.deps.map((d) => `${d.type} ${d.name}`)).toEqual([
    'OrderRepositoryInterface orders',
    'PriceCalculator prices',
  ]);
  expect(v.edges.filter((e) => e.kind === 'implements').map((e) => `${e.from.member} ${e.to.node}`)).toEqual([
    'place php:App\\Order\\Service\\OrderService',
    'save php:App\\Order\\Repository\\DoctrineOrderRepository',
  ]);
});

test('портовете носят цвета на типа и DTO полетата за разгъване', async () => {
  const v = await view('php-mezzio', 'POST /orders');
  const place = v.nodes.find((n) => n.name === 'OrderService')?.members[0];
  expect(place?.inputs[0]).toMatchObject({ name: 'dto', type: 'PlaceOrderDto', kind: 'dto' });
  expect(place?.inputs[0]?.fields?.map((f) => `${f.name}:${f.kind}`)).toEqual([
    'customerId:primitive',
    'items:collection',
    'note:primitive',
  ]);
  expect(place?.output).toMatchObject({ type: 'Order', kind: 'entity' });
});

test('FastAPI: функцията на route-а е controller, models.py дава entity', async () => {
  const v = await view('python-fastapi', 'POST /orders');
  expect(v.nodes.find((n) => n.name === 'place_order')?.role).toBe('controller');
  expect(v.nodes.find((n) => n.name === 'Order')?.role).toBe('entity');
});

test('детайли на нода: наследяване, тагове, останалите методи, полета и кой го ползва', async () => {
  const v = await view('php-mezzio', 'POST /orders');
  const node = (name: string) => v.nodes.find((n) => n.name === name);
  expect(node('OrderService')?.bases).toEqual([{ kind: 'implements', name: 'OrderServiceInterface' }]);
  expect(node('OrderService')?.tags).toEqual(['final']);
  expect(node('OrderService')?.others.map((m) => m.name)).toEqual(['__construct', 'get']);
  expect(node('Order')?.fields.map((f) => f.name)).toEqual(['items', 'customerId', 'status']);
  // injects е от инжектирания тип към потребителя: OrderService не се „ползва“ от зависимостите си
  expect(node('OrderService')?.usedBy.map((u) => `${u.kind} ${u.label}`)).toEqual([
    'creates OrderServiceFactory#__invoke',
  ]);
  expect(
    node('PriceCalculator')
      ?.usedBy.map((u) => `${u.kind} ${u.label}`)
      .sort(),
  ).toEqual(['calls OrderService#place', 'creates OrderServiceFactory#__invoke', 'injects OrderService#__construct']);
});

test('процес от клас: тръгва от всеки негов метод', async () => {
  const query = new GraphQuery((await scan(join(fixtures, 'php-mezzio'), { scip: false })).graph);
  const [start] = query.find('OrderService');
  if (!start) throw new Error('няма OrderService');
  const v = processView(query, start, 3);
  expect(v.nodes[0]?.members.map((m) => m.name)).toEqual(['__construct', 'place', 'get']);
  expect(v.nodes.map((n) => n.name)).toContain('OrderRepositoryInterface');
});
