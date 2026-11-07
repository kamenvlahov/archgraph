import type { Confidence, Edge, EdgeEnd, EdgeKind } from './types.ts';

// Id на ребро: `<kind>:<от>-><до>`, краят е `нод`, `нод#member` или `нод#member.port` (fixtures/README.md).
export function edge(kind: EdgeKind, from: EdgeEnd, to: EdgeEnd, confidence: Confidence = 'exact'): Edge {
  return { id: `${kind}:${endId(from)}->${endId(to)}`, kind, from, to, confidence };
}

function endId(end: EdgeEnd): string {
  if (end.member === undefined) return end.node;
  return `${end.node}#${end.member}${end.port === undefined ? '' : `.${end.port}`}`;
}
