import { appendFileSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { expect, test } from 'vitest';
import { blueprint, Project, skeleton } from '@archgraph/engine';
import { saveDesign, type Design } from '@archgraph/rules';
import { designPlan } from './plan.ts';

test('designPlan: на английски, с местене, промени и махане, не само новите класове', async () => {
  const root = mkdtempSync(join(tmpdir(), 'archgraph-plan-'));
  const design: Design = {
    stack: 'php-mezzio',
    style: 'ddd',
    endpoints: [{ method: 'GET', path: '/albums', output: [{ title: 'string' }] }],
  };
  saveDesign(root, design);
  writeFileSync(join(root, 'composer.json'), '{"require": {"mezzio/mezzio": "^3.0"}}');
  const bp = blueprint(design);
  for (const file of new Set(bp.nodes.map((n) => n.location.file))) {
    const code = skeleton(bp, file);
    if (!code) continue;
    mkdirSync(dirname(join(root, file)), { recursive: true });
    appendFileSync(join(root, file), code);
  }
  const { graph } = await Project.open(root, { scip: false });
  expect(designPlan(graph, design, bp)).toContain('Everything in the design is in the code and matches.');

  // Album на ниво 1: handler-ът вика repository-то, Query и QueryHandler са излишни, AlbumItem се мести
  const flat: Design = { ...design, resources: { Album: { level: 1 } } };
  const text = designPlan(graph, flat, blueprint(flat));
  expect(text).toContain('# Plan: DDD in PHP · Mezzio');
  expect(text).toContain('- **AlbumItem**: `src/Album/Application/AlbumItem.php` → `src/Album/Dto/AlbumItem.php`');
  expect(text).toMatch(
    /- \*\*ListAlbumsHandler\*\* in `src\/Album\/Handler\/ListAlbumsHandler\.php:\d+`\n {2}- `__construct\(listAlbumsQueryHandler: ListAlbumsQueryHandler\)` → `__construct\(albumRepository: AlbumRepository\)`/,
  );
  expect(text).toContain('- class **ListAlbumsQueryHandler** — `src/Album/Application/ListAlbumsQueryHandler.php');
  expect(text).not.toContain('## New');
});
