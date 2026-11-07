import { describe, expect, test } from 'vitest';
import schema from '../schema.json' with { type: 'json' };
import { CORE_REGISTRY, extendRegistry, KIND_NAME } from './registry.ts';
import { CONFIDENCES, TYPE_REF_KINDS, VISIBILITIES, type GraphModel } from './types.ts';
import { validate } from './validate.ts';

const loc = (line: number) => ({ file: 'src/Order/OrderService.php', line, endLine: line + 5 });

function sample(): GraphModel {
  return {
    version: 1,
    root: '/project',
    nodes: [
      {
        id: 'php:App\\Order\\OrderRepositoryInterface',
        kind: 'interface',
        name: 'OrderRepositoryInterface',
        language: 'php',
        role: 'repository',
        location: loc(1),
        members: [
          {
            name: 'save',
            visibility: 'public',
            inputs: [{ name: 'order', type: { kind: 'named', id: 'App\\Order\\Order' } }],
            output: { name: 'return', type: { kind: 'primitive', name: 'void' } },
            location: loc(3),
          },
        ],
      },
      {
        id: 'php:App\\Order\\OrderService',
        kind: 'class',
        name: 'OrderService',
        language: 'php',
        role: 'service',
        framework: 'mezzio',
        layer: 'application',
        context: 'Order',
        location: loc(10),
        tags: ['final'],
        members: [
          {
            name: 'place',
            visibility: 'public',
            inputs: [
              { name: 'dto', type: { kind: 'named', id: 'App\\Order\\PlaceOrderDto' } },
              {
                name: 'tags',
                type: { kind: 'array', of: { kind: 'primitive', name: 'string' } },
                optional: true,
                default: '[]',
              },
            ],
            output: { name: 'return', type: { kind: 'named', id: 'App\\Order\\Order' } },
            throws: [{ kind: 'named', id: 'DomainException' }],
            location: loc(12),
          },
          {
            name: 'meta',
            visibility: 'private',
            inputs: [{ name: 'raw', type: { kind: 'unknown', hint: 'mixed' } }],
            output: {
              name: 'return',
              type: {
                kind: 'map',
                key: { kind: 'primitive', name: 'string' },
                value: {
                  kind: 'union',
                  of: [
                    { kind: 'primitive', name: 'int' },
                    { kind: 'primitive', name: 'null' },
                  ],
                },
              },
            },
            location: loc(20),
          },
        ],
      },
    ],
    edges: [
      {
        id: 'e1',
        kind: 'injects',
        from: { node: 'php:App\\Order\\OrderRepositoryInterface' },
        to: { node: 'php:App\\Order\\OrderService', member: 'place', port: 'dto' },
        confidence: 'exact',
      },
    ],
    types: {
      'App\\Order\\PlaceOrderDto': {
        id: 'App\\Order\\PlaceOrderDto',
        name: 'PlaceOrderDto',
        fields: [
          { name: 'customerId', type: { kind: 'primitive', name: 'int' }, readonly: true },
          {
            name: 'address',
            type: { kind: 'shape', fields: [{ name: 'city', type: { kind: 'primitive', name: 'string' } }] },
          },
        ],
      },
      'App\\Order\\OrderService': {
        id: 'App\\Order\\OrderService',
        name: 'OrderService',
        nodeId: 'php:App\\Order\\OrderService',
        fields: [],
      },
    },
  };
}

function errorsOf(input: unknown) {
  const r = validate(input);
  if (r.ok) throw new Error('очакваше се невалиден модел');
  return r.errors;
}

test('валиден модел минава', () => {
  const r = validate(sample());
  expect(r.ok ? [] : r.errors).toEqual([]);
});

describe('структура', () => {
  test('не е обект', () => {
    expect(errorsOf(null)).toEqual([{ path: '$', message: 'трябва да е обект' }]);
  });

  test('грешна версия, непознат kind и липсваща локация', () => {
    const m = sample() as unknown as { version: number; nodes: Record<string, unknown>[] };
    m.version = 2;
    m.nodes[0]!.kind = 'struct';
    delete m.nodes[1]!.location;
    expect(errorsOf(m).map((e) => e.path)).toEqual(['$.version', '$.nodes[0].kind', '$.nodes[1].location']);
  });

  test('рекурсивен TypeRef', () => {
    const m = sample();
    m.nodes[1]!.members[1]!.output!.type = {
      kind: 'array',
      of: { kind: 'map', key: { kind: 'primitive', name: '' } },
    } as never;
    expect(errorsOf(m).map((e) => e.path)).toEqual([
      '$.nodes[1].members[1].output.type.of.key.name',
      '$.nodes[1].members[1].output.type.of.value',
    ]);
  });

  test('непознато поле се хваща', () => {
    const m = sample() as unknown as { nodes: { members: Record<string, unknown>[] }[] };
    m.nodes[0]!.members[0]!.ouput = {};
    expect(errorsOf(m)).toEqual([{ path: '$.nodes[0].members[0].ouput', message: 'непознато поле' }]);
  });

  test('endLine преди line', () => {
    const m = sample();
    m.nodes[0]!.location = { file: 'a.php', line: 10, endLine: 2 };
    expect(errorsOf(m).map((e) => e.path)).toEqual(['$.nodes[0].location.endLine']);
  });

  test('ключът в types съвпада с id', () => {
    const m = sample();
    m.types['App\\Order\\PlaceOrderDto']!.id = 'Other';
    expect(errorsOf(m).map((e) => e.path)).toEqual(['$.types["App\\\\Order\\\\PlaceOrderDto"].id']);
  });
});

describe('регистър', () => {
  const views = { name: 'views', nodeKinds: ['template'], edgeKinds: ['renders'] };

  function withTemplate() {
    const m = sample();
    m.nodes.push({
      id: 'php:template:order/show.twig',
      kind: 'template',
      name: 'order/show.twig',
      language: 'php',
      location: { file: 'templates/order/show.twig', line: 1, endLine: 9 },
      members: [],
    });
    m.edges.push({
      id: 'e2',
      kind: 'renders',
      from: { node: 'php:App\\Order\\OrderService', member: 'place' },
      to: { node: 'php:template:order/show.twig' },
      confidence: 'inferred',
    });
    return m;
  }

  test('ядрото не познава видове от разширения', () => {
    expect(errorsOf(withTemplate()).map((e) => e.path)).toEqual(['$.nodes[2].kind', '$.edges[1].kind']);
  });

  test('разширението добавя вид нод и ребро', () => {
    const r = validate(withTemplate(), extendRegistry(CORE_REGISTRY, views));
    expect(r.ok ? [] : r.errors).toEqual([]);
  });

  test('нов език е само регистрация', () => {
    const m = sample();
    m.nodes[0]!.language = 'go';
    expect(errorsOf(m).map((e) => e.path)).toEqual(['$.nodes[0].language']);
    expect(validate(m, extendRegistry(CORE_REGISTRY, { name: 'lang-go', languages: ['go'] })).ok).toBe(true);
  });

  test('конфликт и невалидно име са грешка', () => {
    const r = extendRegistry(CORE_REGISTRY, views);
    expect(() => extendRegistry(r, { name: 'other', nodeKinds: ['template'] })).toThrow(
      'other: вид нод "template" вече е регистриран',
    );
    expect(() => extendRegistry(CORE_REGISTRY, { name: 'x', edgeKinds: ['Renders'] })).toThrow('невалидно име');
  });

  test('ядрото не се променя', () => {
    extendRegistry(CORE_REGISTRY, views);
    expect(CORE_REGISTRY.nodeKinds.has('template')).toBe(false);
  });
});

describe('връзки', () => {
  test('ребро към несъществуващ нод, member и порт', () => {
    const m = sample();
    m.edges.push(
      {
        id: 'e2',
        kind: 'calls',
        from: { node: 'php:Missing' },
        to: { node: 'php:App\\Order\\OrderService', member: 'nope' },
        confidence: 'inferred',
      },
      {
        id: 'e3',
        kind: 'uses-type',
        from: { node: 'php:App\\Order\\OrderService', member: 'place', port: 'x' },
        to: { node: 'php:App\\Order\\OrderService', member: 'place', port: 'return' },
        confidence: 'exact',
      },
    );
    expect(errorsOf(m).map((e) => e.path)).toEqual([
      '$.edges[1].from.node',
      '$.edges[1].to.member',
      '$.edges[2].from.port',
    ]);
  });

  test('неразрешено извикване от несъществуващ нод или member', () => {
    const m = sample();
    m.unresolved = [
      { from: { node: 'php:App\\Order\\OrderService', member: 'place' }, name: 'save', line: 3 },
      { from: { node: 'php:Missing', member: 'x' }, name: 'save', line: 3 },
      { from: { node: 'php:App\\Order\\OrderService', member: 'nope' }, name: 'save', line: 3 },
    ];
    expect(errorsOf(m).map((e) => e.path)).toEqual(['$.unresolved[1].from.node', '$.unresolved[2].from.member']);
    m.unresolved = [{ from: { node: 'php:App\\Order\\OrderService', member: 'place' }, name: '', line: 0 }];
    expect(errorsOf(m).map((e) => e.path)).toEqual(['$.unresolved[0].name', '$.unresolved[0].line']);
  });

  test('порт без member', () => {
    const m = sample();
    m.edges[0]!.to = { node: 'php:App\\Order\\OrderService', port: 'dto' };
    expect(errorsOf(m).map((e) => e.path)).toEqual(['$.edges[0].to.port']);
  });

  test('повторени id-та и nodeId към липсващ нод', () => {
    const m = sample();
    m.nodes.push({ ...m.nodes[0]! });
    m.edges.push({ ...m.edges[0]! });
    m.types['App\\Order\\PlaceOrderDto']!.nodeId = 'php:Ghost';
    expect(errorsOf(m).map((e) => e.path)).toEqual([
      '$.nodes[2].id',
      '$.edges[1].id',
      '$.types["App\\\\Order\\\\PlaceOrderDto"].nodeId',
    ]);
  });
});

test('schema.json има същите списъци като types.ts', () => {
  const d = schema.$defs;
  expect(d.kindName.pattern).toBe(KIND_NAME.source);
  for (const ref of [d.node.properties.kind, d.node.properties.language, d.edge.properties.kind])
    expect(ref.$ref).toBe('#/$defs/kindName');
  expect(d.member.properties.visibility.enum).toEqual([...VISIBILITIES]);
  expect(d.edge.properties.confidence.enum).toEqual([...CONFIDENCES]);
  expect(d.typeRef.properties.kind.enum).toEqual([...TYPE_REF_KINDS]);
  expect(d.typeRef.oneOf.map((b) => b.properties.kind.const)).toEqual([...TYPE_REF_KINDS]);
});
