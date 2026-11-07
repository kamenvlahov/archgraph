import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { Server } from './server.ts';

const fixtures = join(import.meta.dirname, '../../../fixtures');

async function call(server: Server, name: string, args: Record<string, unknown>) {
  const reply = (await server.handle({
    jsonrpc: '2.0',
    id: 1,
    method: 'tools/call',
    params: { name, arguments: args },
  })) as {
    result: { content: { text: string }[]; isError?: boolean };
  };
  return { text: reply.result.content[0]?.text ?? '', isError: reply.result.isError ?? false };
}

describe('инструменти върху php-mezzio', () => {
  const server = new Server({ cwd: join(fixtures, 'php-mezzio'), scip: false });

  test('trace надолу от handler-а стига до repository през интерфейса', async () => {
    const { text } = await call(server, 'trace', { target: 'PlaceOrderHandler::handle' });
    expect(text.split('\n')).toEqual([
      'PlaceOrderHandler#handle  src/Order/Handler/PlaceOrderHandler.php:20',
      '  →? OrderServiceInterface#place  src/Order/Service/OrderServiceInterface.php:12',
      '    ⇒ OrderService#place  src/Order/Service/OrderService.php:20',
      '      new Order  src/Order/Entity/Order.php:9',
      '      →? Order#addItem  src/Order/Entity/Order.php:24',
      '      new OrderItem  src/Order/Entity/OrderItem.php:9',
      '      →? PriceCalculator#applyDiscount  src/Order/Service/PriceCalculator.php:12',
      '      →? OrderRepositoryInterface#save  src/Order/Repository/OrderRepositoryInterface.php:13',
      '        ⇒ DoctrineOrderRepository#save  src/Order/Repository/DoctrineOrderRepository.php:21',
      '  →? PlaceOrderDto#fromArray  src/Order/Dto/PlaceOrderDto.php:20',
      '    new PlaceOrderDto  src/Order/Dto/PlaceOrderDto.php:7',
      '  →? AbstractEntity#getId  src/Order/Entity/AbstractEntity.php:11',
      '  →? Order#total  src/Order/Entity/Order.php:35',
      '    →? OrderItem#subtotal  src/Order/Entity/OrderItem.php:22',
    ]);
  });

  test('trace нагоре от имплементацията минава през извикванията на интерфейса', async () => {
    const { text } = await call(server, 'trace', { target: 'DoctrineOrderRepository#find', direction: 'up', depth: 2 });
    expect(text.split('\n')).toEqual([
      'DoctrineOrderRepository#find  src/Order/Repository/DoctrineOrderRepository.php:16',
      '  ← OrderService#get  src/Order/Service/OrderService.php:31',
      '    ← GetOrderHandler#handle  src/Order/Handler/GetOrderHandler.php:20',
    ]);
  });

  test('describe_node и find_by_role', async () => {
    const { text } = await call(server, 'describe_node', { target: 'PlaceOrderDto' });
    expect(text).toContain('PlaceOrderDto  (class, final, readonly)  src/Order/Dto/PlaceOrderDto.php:7');
    expect(text).toContain('  items: {sku: string, quantity: int, price: float}[]');
    expect((await call(server, 'find_by_role', { role: 'interface' })).text.split('\n')).toHaveLength(2);
  });

  test('нееднозначно или липсващо име връща грешка с кандидати', async () => {
    const missing = await call(server, 'describe_node', { target: 'OrderServis' });
    expect(missing.isError).toBe(true);
    expect(missing.text).toContain('Подобни:');
    const many = await call(server, 'trace', { target: 'handle' });
    expect(many).toEqual({ isError: true, text: expect.stringContaining('няма "handle"') });
    const both = await call(server, 'describe_node', { target: '__invoke' });
    expect(both.isError).toBe(true);
  });
});

test('протокол: initialize, tools/list, известия и непознат метод', async () => {
  const server = new Server({ cwd: fixtures, scip: false });
  const init = (await server.handle({
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: { protocolVersion: '2099-01-01' },
  })) as { result: { protocolVersion: string } };
  expect(init.result.protocolVersion).toBe('2025-11-25');
  expect(await server.handle({ jsonrpc: '2.0', method: 'notifications/initialized' })).toBeUndefined();
  const list = (await server.handle({ jsonrpc: '2.0', id: 2, method: 'tools/list' })) as {
    result: { tools: { name: string }[] };
  };
  expect(list.result.tools.map((t) => t.name)).toEqual([
    'trace',
    'dependents',
    'describe_node',
    'find_by_role',
    'rescan',
  ]);
  expect(await server.handle({ jsonrpc: '2.0', id: 3, method: 'resources/list' })).toEqual({
    jsonrpc: '2.0',
    id: 3,
    error: { code: -32601, message: 'непознат метод resources/list' },
  });
});

test('stdio: по едно JSON съобщение на ред', async () => {
  const child = spawn(process.execPath, [join(import.meta.dirname, 'main.ts')], {
    cwd: join(fixtures, 'python-fastapi'),
  });
  const lines = createInterface({ input: child.stdout })[Symbol.asyncIterator]();
  const send = (m: object) => child.stdin.write(`${JSON.stringify(m)}\n`);
  send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } });
  send({ jsonrpc: '2.0', method: 'notifications/initialized' });
  send({
    jsonrpc: '2.0',
    id: 2,
    method: 'tools/call',
    params: { name: 'trace', arguments: { target: 'get_order', depth: 1 } },
  });
  const replies = [JSON.parse((await lines.next()).value as string), JSON.parse((await lines.next()).value as string)];
  child.kill();
  expect(replies[0].result.serverInfo.name).toBe('archgraph');
  expect(replies[1].result.content[0].text.split('\n')).toEqual([
    'get_order  app/orders/router.py:16',
    '  →? to_out  app/orders/router.py:21',
    '  →? OrderService#get  app/orders/service.py:20',
  ]);
});
