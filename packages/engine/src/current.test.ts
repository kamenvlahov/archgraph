import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { expect, test } from 'vitest';
import { currentArchitecture } from './current.ts';
import { scan } from './scan.ts';

const php = (ns: string, body: string) => `<?php\nnamespace ${ns};\n${body}\n`;

test('Mezzio: pipeline от middleware, route-ове от конфигурация и слоевете по най-дълбоката папка', async () => {
  const root = mkdtempSync(join(tmpdir(), 'archgraph-'));
  const files: Record<string, string> = {
    'composer.json': '{"require":{"mezzio/mezzio":"^3.0"}}',
    'config/routes.php':
      "<?php\nuse App\\Http\\Actions\\Vpp\\GetPlantsAction;\nuse App\\Http\\Middleware\\AuthMiddleware;\nreturn static function ($app): void {\n    $app->get('/vpp/plants', [AuthMiddleware::class, GetPlantsAction::class], 'vpp.plants');\n};\n",
    'config/autoload/routes.global.php':
      "<?php\nuse App\\Http\\Actions\\Vpp\\GetPlantsAction;\nreturn ['routes' => [['path' => '/vpp/report', 'middleware' => GetPlantsAction::class, 'allowed_methods' => ['GET', 'POST']]]];\n",
    'src/Http/Middleware/AuthMiddleware.php': php(
      'App\\Http\\Middleware',
      'class AuthMiddleware { public function process($r, $h) { return $h->handle($r); } }',
    ),
    'src/Http/Actions/Vpp/GetPlantsAction.php': php(
      'App\\Http\\Actions\\Vpp',
      'use App\\Http\\Services\\VppService;\nclass GetPlantsAction { public function __construct(private VppService $vpp) {} public function handle($r) { return $this->vpp->plants(); } }',
    ),
    'src/Http/Services/VppService.php': php(
      'App\\Http\\Services',
      'class VppService { public function plants() { return []; } }',
    ),
  };
  for (const [file, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, file)), { recursive: true });
    writeFileSync(join(root, file), text);
  }
  const { graph } = await scan(root, { scip: false });
  const routes = graph.edges.filter((e) => e.kind === 'routes-to').map((e) => `${e.from.node} → ${e.to.node}`);
  expect(routes).toEqual(
    expect.arrayContaining([
      'php:route:GET /vpp/plants → php:App\\Http\\Actions\\Vpp\\GetPlantsAction',
      'php:route:GET /vpp/plants → php:App\\Http\\Middleware\\AuthMiddleware',
      'php:route:GET /vpp/report → php:App\\Http\\Actions\\Vpp\\GetPlantsAction',
      'php:route:POST /vpp/report → php:App\\Http\\Actions\\Vpp\\GetPlantsAction',
    ]),
  );
  const current = currentArchitecture(graph);
  expect(current.folders).toMatchObject({ entry: ['Actions', 'Middleware'], application: ['Services'] });
  expect(current.modules.find((m) => m.name === 'Vpp')).toMatchObject({ shape: 'layered', from: { application: 1 } });
});
