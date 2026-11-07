import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import type { GraphModel, Node } from '@archgraph/model';
import { pythonAdapter } from './adapter.ts';

const fixture = join(import.meta.dirname, '../../../fixtures/python-fastapi');
const files = readdirSync(fixture, { recursive: true, encoding: 'utf8' })
  .filter((f) => f.endsWith('.py'))
  .sort()
  .map((path) => ({ path, text: readFileSync(join(fixture, path), 'utf8') }));

// Етап 1: само нодове, членове и портове. Роли, framework и route-ове идват от правилата (етап 6).
const expected = (JSON.parse(readFileSync(join(fixture, 'expected.json'), 'utf8')) as GraphModel).nodes
  .filter((n) => n.kind !== 'route')
  .map(({ role, framework, layer, context, ...n }): Node => n);

describe('python-fastapi', async () => {
  const { nodes } = await pythonAdapter.read(files);

  test('същите нодове', () => {
    expect(nodes.map((n) => n.id).sort()).toEqual(expected.map((n) => n.id).sort());
  });

  test.each(expected.map((n) => [n.id, n] as const))('%s', (id, node) => {
    expect(nodes.find((n) => n.id === id)).toEqual(node);
  });
});

describe('конструкции извън fixture-а', async () => {
  const files = [
    { path: 'src/shop/__init__.py', text: '' },
    { path: 'src/shop/core.py', text: 'class Base:\n    pass\n' },
    {
      path: 'src/shop/billing/invoice.py',
      text: `from abc import ABC, abstractmethod
from typing import Any, Optional, Union, Annotated, Literal
from ..core import Base
import shop.core as core


class Invoice(Base, ABC):
    @staticmethod
    def build(*lines: "Line", **opts: Any) -> "Invoice": ...

    @classmethod
    def empty(cls) -> Optional[core.Base]: ...

    @abstractmethod
    async def _send(self, to: list[str], meta: dict[str, int | None] = {}, /, *, mode: Literal["a", "b"] = "a") -> None: ...

    def __hash(self, items: tuple[int, ...], pair: tuple[int, str], x: Union[int, str], y: Annotated[int, "id"], z: list[str] | int | None): ...


class Line:
    pass
`,
    },
  ];
  const { nodes } = await pythonAdapter.read(files);
  const invoice = nodes.find((n) => n.id === 'python:shop.billing.invoice.Invoice');
  const [build, empty, send, hash] = invoice?.members ?? [];
  const p = (name: string) => ({ kind: 'primitive', name });

  test('src/ layout, ABC, относителен импорт', () => {
    expect(nodes.map((n) => n.id)).toEqual([
      'python:shop.core.Base',
      'python:shop.billing.invoice.Invoice',
      'python:shop.billing.invoice.Line',
    ]);
    expect(invoice?.tags).toEqual(['abstract']);
  });

  test('staticmethod със *args/**kwargs и forward ref', () => {
    expect(build).toMatchObject({
      static: true,
      inputs: [
        { name: 'lines', type: { kind: 'named', id: 'python:shop.billing.invoice.Line' }, variadic: true },
        { name: 'opts', type: p('any'), variadic: true },
      ],
      output: { type: { kind: 'named', id: 'python:shop.billing.invoice.Invoice' } },
    });
  });

  test('classmethod без cls, Optional, import as', () => {
    expect(empty).toMatchObject({
      static: true,
      inputs: [],
      output: { type: { kind: 'union', of: [{ kind: 'named', id: 'python:shop.core.Base' }, p('None')] } },
    });
  });

  test('async, protected, list/dict, X | None, разделители / и *, Literal', () => {
    expect(send).toMatchObject({ async: true, visibility: 'protected' });
    expect(send?.output).toBeUndefined();
    expect(send?.inputs).toEqual([
      { name: 'to', type: { kind: 'array', of: p('str') } },
      {
        name: 'meta',
        type: { kind: 'map', key: p('str'), value: { kind: 'union', of: [p('int'), p('None')] } },
        optional: true,
        default: '{}',
      },
      { name: 'mode', type: p('Literal["a", "b"]'), optional: true, default: '"a"' },
    ]);
  });

  test('private, tuple, Union, Annotated, без return тип', () => {
    expect(hash?.visibility).toBe('private');
    expect(hash?.inputs.map((i) => i.type)).toEqual([
      { kind: 'array', of: p('int') },
      { kind: 'named', id: 'python:tuple', args: [p('int'), p('str')] },
      { kind: 'union', of: [p('int'), p('str')] },
      p('int'),
      { kind: 'union', of: [{ kind: 'array', of: p('str') }, p('int'), p('None')] },
    ]);
    expect(hash?.output?.type).toEqual({ kind: 'unknown' });
  });
});

test('бази и FastAPI Depends', async () => {
  const { edges } = await pythonAdapter.read([
    {
      path: 'app/deps.py',
      text: `from typing import Annotated
import fastapi
from fastapi import Depends
from .core import Base, Service, get_service


class A(Base, Generic[T], metaclass=Meta):
    pass


def handler(a: Service = Depends(get_service), b: Annotated[Service, Depends(get_service)] = None, c: Service = fastapi.Depends(), d: int = 1):
    pass
`,
    },
  ]);
  expect(edges.map((e) => e.id)).toEqual([
    'extends:python:app.deps.A->python:app.core.Base',
    'extends:python:app.deps.A->python:Generic',
    'injects:python:app.core.get_service->python:app.deps.handler#handler.a',
    'injects:python:app.core.get_service->python:app.deps.handler#handler.b',
    'injects:python:app.core.Service->python:app.deps.handler#handler.c',
  ]);
});

test('src като пакет: импортите `from src.x` намират нода', async () => {
  const { nodes, edges } = await pythonAdapter.read([
    { path: 'src/__init__.py', text: '' },
    { path: 'src/core.py', text: 'class Base:\n    pass\n' },
    { path: 'src/app.py', text: 'from src.core import Base\n\n\nclass A(Base):\n    pass\n' },
  ]);
  expect(nodes.map((n) => n.id)).toEqual(['python:src.core.Base', 'python:src.app.A']);
  expect(edges.map((e) => e.id)).toEqual(['extends:python:src.app.A->python:src.core.Base']);
});
