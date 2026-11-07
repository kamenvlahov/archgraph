import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, expect, test } from 'vitest';
import type { GraphModel } from '@archgraph/model';
import { isExcluded } from './files.ts';
import { scan } from './scan.ts';

const fixtures = join(import.meta.dirname, '../../../fixtures');

function project(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'archgraph-'));
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), text);
  }
  return dir;
}

describe.each(['php-mezzio', 'node-nestjs', 'python-fastapi'])('%s', (name) => {
  test('същите нодове като expected.json', async () => {
    const expected = JSON.parse(readFileSync(join(fixtures, name, 'expected.json'), 'utf8')) as GraphModel;
    const { graph } = await scan(join(fixtures, name));
    expect(graph.root).toBe(join(fixtures, name));
    expect(graph.nodes.map((n) => n.id).sort()).toEqual(
      expected.nodes
        .filter((n) => n.kind !== 'route')
        .map((n) => n.id)
        .sort(),
    );
  });
});

test('смесен проект с трите езика', async () => {
  const { graph, report } = await scan(fixtures);
  expect(report.files).toEqual({ php: 17, node: 13, python: 10 });
  expect(graph.nodes.length).toBe(16 + 15 + 16);
});

test('изключени папки, бъндъли и собствени шаблони', async () => {
  const dir = project({
    'src/App.php': '<?php class App {}',
    'vendor/lib/Lib.php': '<?php class Lib {}',
    'node_modules/x/index.js': 'export function x() {}',
    'web/app.min.js': 'function a(){}',
    'web/bundle.js': `export function big() {}\n${'//'.padEnd(2000, 'x')}`,
    'legacy/Old.php': '<?php class Old {}',
  });
  const { graph, report } = await scan(dir, { exclude: ['legacy'], maxFileSize: 1000 });
  expect(graph.nodes.map((n) => n.id)).toEqual(['php:App']);
  expect(report.tooBig).toEqual(['web/bundle.js']);
});

test('еднакви пълни имена остават и двете, с таг duplicate', async () => {
  const dir = project({
    'a/Form.php': '<?php\nnamespace Admin;\nclass Form {}',
    'b/Form.php': '<?php\nnamespace Admin;\nclass Form {}',
  });
  const { graph, report } = await scan(dir);
  expect(report.duplicates).toEqual(['php:Admin\\Form']);
  expect(graph.nodes.map((n) => [n.id, n.tags])).toEqual([
    ['php:Admin\\Form', ['duplicate']],
    ['php:Admin\\Form@b/Form.php', ['duplicate']],
  ]);
});

test('шаблони за изключване', () => {
  expect(isExcluded('a/vendor/b.php', ['vendor'])).toBe(true);
  expect(isExcluded('a/vendors/b.php', ['vendor'])).toBe(false);
  expect(isExcluded('web/x.min.js', ['*.min.js'])).toBe(true);
  expect(isExcluded('src/legacy/a/b.ts', ['src/legacy/**'])).toBe(true);
  expect(isExcluded('lib/src/legacy/b.ts', ['src/legacy/**'])).toBe(false);
});
