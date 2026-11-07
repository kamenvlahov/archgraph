import { describe, expect, test } from 'vitest';
import type { CallSite, Node } from '@archgraph/model';
import { exactCalls, findCommand } from './exact.ts';
import { readScip, type ScipDocument } from './scip.ts';

// Минимален protobuf запис за теста: само varint и length-delimited полета.
const varint = (n: number): number[] => (n < 0x80 ? [n] : [(n & 0x7f) | 0x80, ...varint(n >>> 7)]);
const bytes = (field: number, data: number[]) => [...varint((field << 3) | 2), ...varint(data.length), ...data];
const num = (field: number, n: number) => [...varint(field << 3), ...varint(n)];
const str = (field: number, s: string) => bytes(field, [...new TextEncoder().encode(s)]);

test('readScip чете документи, редове, символи и роли', () => {
  const occurrence = [...bytes(1, [...varint(299), 4, 12]), ...str(2, 'pkg/A#run().'), ...num(3, 1), ...num(5, 7)];
  const unpacked = [...num(1, 9), ...num(1, 2), ...num(1, 5), ...str(2, 'pkg/B#'), ...num(3, 8)];
  const doc = [...str(1, 'src/a.ts'), ...bytes(2, occurrence), ...bytes(2, unpacked), ...str(4, 'TypeScript')];
  const index = [...bytes(1, str(3, 'file:///x')), ...bytes(2, doc)];
  expect(readScip(Uint8Array.from(index))).toEqual([
    {
      path: 'src/a.ts',
      occurrences: [
        { line: 300, symbol: 'pkg/A#run().', roles: 1 },
        { line: 10, symbol: 'pkg/B#', roles: 8 },
      ],
    },
  ]);
});

describe('exactCalls', () => {
  const at = (file: string, line: number, endLine: number) => ({ file, line, endLine });
  const nodes: Node[] = [
    {
      id: 'Repo',
      kind: 'class',
      name: 'Repo',
      language: 'python',
      location: at('repo.py', 1, 9),
      members: [{ name: 'find', visibility: 'public', inputs: [], location: at('repo.py', 2, 3) }],
    },
    {
      id: 'Svc',
      kind: 'class',
      name: 'Svc',
      language: 'python',
      location: at('svc.py', 1, 20),
      members: [
        { name: 'run', visibility: 'public', inputs: [], location: at('svc.py', 2, 10) },
        { name: 'helper', visibility: 'public', inputs: [], location: at('svc.py', 11, 12) },
      ],
    },
  ];
  const documents: ScipDocument[] = [
    { path: 'repo.py', occurrences: [{ line: 2, symbol: 'm/Repo#find().', roles: 1 }] },
    {
      path: 'svc.py',
      occurrences: [
        { line: 11, symbol: 'm/Svc#helper().', roles: 1 },
        // вложена функция `find` в `run` със същия символ като на метода (scip-python)
        { line: 4, symbol: 'm/Repo#find().', roles: 1 },
        { line: 5, symbol: 'm/Repo#find().', roles: 8 }, // извикване
        { line: 6, symbol: 'm/Svc#helper().', roles: 8 }, // само споменаване: Depends(helper)
        { line: 7, symbol: 'ext/list#append().', roles: 8 }, // външен метод
      ],
    },
  ];
  const run = { node: 'Svc', member: 'run' };
  const sites: CallSite[] = [
    { from: run, line: 5, kind: 'method', on: { kind: 'type', type: { kind: 'unknown' } }, name: 'find' },
    { from: run, line: 7, kind: 'method', on: { kind: 'type', type: { kind: 'unknown' } }, name: 'append' },
    { from: run, line: 8, kind: 'method', on: { kind: 'type', type: { kind: 'unknown' } }, name: 'save' },
  ];

  test('ребро само за извикване, което SCIP е разпознал', () => {
    const { edges, resolved } = exactCalls(nodes, documents, sites);
    expect(edges.map((e) => [e.id, e.confidence])).toEqual([['calls:Svc#run->Repo#find', 'exact']]);
    // външният метод е решен (няма ребро), а `save` на ред 8 остава за евристиката
    expect([...resolved].map((s) => s.line)).toEqual([5, 7]);
  });
});

test.skipIf(!findCommand('scip-typescript') || !findCommand('scip-python'))(
  'с инсталирани индексатори calls са exact',
  async () => {
    const { scan } = await import('./scan.ts');
    for (const name of ['node-nestjs', 'python-fastapi']) {
      const { graph, report } = await scan(`${import.meta.dirname}/../../../fixtures/${name}`);
      expect(Object.values(report.scip)).toEqual(['exact']);
      expect(new Set(graph.edges.filter((e) => e.kind === 'calls').map((e) => e.confidence))).toEqual(
        new Set(['exact']),
      );
    }
  },
  60_000,
);
