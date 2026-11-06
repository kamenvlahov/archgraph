import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import type { GraphModel, Location } from './types.ts';
import { validate } from './validate.ts';

// Проверява ръчно писаните fixtures/*/expected.json срещу самите файлове,
// за да не се разминат редовете при промяна на fixture-а.

const root = join(import.meta.dirname, '../../../fixtures');
const fixtures = readdirSync(root, { withFileTypes: true })
  .filter((d) => d.isDirectory() && existsSync(join(root, d.name, 'expected.json')))
  .map((d) => d.name);

test('има fixtures', () => {
  expect(fixtures.length).toBeGreaterThan(0);
});

describe.each(fixtures)('%s', (name) => {
  const dir = join(root, name);
  const result = validate(JSON.parse(readFileSync(join(dir, 'expected.json'), 'utf8')));

  test('expected.json е валиден модел', () => {
    expect(result.ok ? [] : result.errors).toEqual([]);
  });
  if (!result.ok) return;
  const model: GraphModel = result.model;
  const files = new Map<string, string[]>();
  const lines = (file: string) => {
    if (!files.has(file)) files.set(file, readFileSync(join(dir, file), 'utf8').split('\n'));
    return files.get(file) ?? [];
  };
  const text = (loc: Location) =>
    lines(loc.file)
      .slice(loc.line - 1, loc.endLine)
      .join('\n');
  const isPython = model.nodes.some((n) => n.language === 'python');

  // Декораторите и атрибутите са част от декларацията: не трябва да остават над началото ѝ.
  const startsCleanly = (loc: Location) => {
    const prev = (lines(loc.file)[loc.line - 2] ?? '').trim();
    return !prev.startsWith('@') && !prev.startsWith('#[');
  };
  const endsCleanly = (loc: Location) => {
    if (isPython) return true;
    const last = (lines(loc.file)[loc.endLine - 1] ?? '').trim();
    return last.startsWith('}') || /[;,)}]$/.test(last);
  };

  const nodeName = new Map(model.nodes.map((n) => [n.id, n.name]));
  const located = model.edges.filter((e) => e.location !== undefined);
  test.each(located.map((e) => [e.id, e] as const))('%s', (_, edge) => {
    const loc = edge.location;
    if (!loc) return;
    // Редът на регистрацията споменава имплементацията (alias, useClass, return X()).
    expect(lines(loc.file)[loc.line - 1]).toContain(nodeName.get(edge.to.node));
  });

  test.each(model.nodes.map((n) => [n.id, n] as const))('%s', (_, node) => {
    expect(existsSync(join(dir, node.location.file))).toBe(true);
    expect(node.location.endLine).toBeLessThanOrEqual(lines(node.location.file).length);
    if (node.kind === 'route') expect(text(node.location)).toMatch(new RegExp(node.name.split(' ')[0] ?? '', 'i'));
    else expect(text(node.location)).toContain(node.name);
    expect(startsCleanly(node.location)).toBe(true);
    expect(endsCleanly(node.location)).toBe(true);
    for (const m of node.members) {
      expect(m.location.file).toBe(node.location.file);
      expect(m.location.line).toBeGreaterThanOrEqual(node.location.line);
      expect(m.location.endLine).toBeLessThanOrEqual(node.location.endLine);
      expect(lines(m.location.file)[m.location.line - 1], `${m.name} първи ред`).toMatch(
        new RegExp(`\\b${m.name}\\b|^\\s*(@|#\\[)`),
      );
      expect(startsCleanly(m.location), `${m.name} декоратор над началото`).toBe(true);
      expect(endsCleanly(m.location), `${m.name} край`).toBe(true);
    }
  });
});
