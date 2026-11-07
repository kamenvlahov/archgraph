// Правилата по framework (D-002, docs/RULES.md). Засега само `wiring.routes`, като данни със
// същата форма като YAML-а. Зареждането от `.yaml` идва с двигателя на правилата (TASK-020).

export interface FrameworkRules {
  framework: string;
  language: string;
  // правилата важат, ако някой от файловете в корена съдържа низа
  detect: { file: string; contains: string }[];
  routes?: RouteRules;
}

export interface RouteRules {
  // декоратор с това последно име прави route: `@router.post` → post, `@Post()` → Post
  decorators?: string[];
  // извикване с това име: `$app->post('/orders', Handler::class)`
  calls?: string[];
  // префиксът на пътя: от декоратор на класа (`@Controller('orders')`) или от присвояване
  // на обекта на декоратора (`router = APIRouter(prefix="/orders")`)
  prefix?: { decorator: string } | { assign: string; keyword: string };
  // монтиране с още префикс: извикване или присвояване с низ `keyword=` и препратка към обекта
  // на декоратора (`app.include_router(router, prefix="/x")`, `Module(router=router, prefix="/x")`)
  mount?: { keyword: string };
  // методът на класа-handler, към който сочи `routes-to`
  handlerMethods?: string[];
}

export const FRAMEWORKS: FrameworkRules[] = [
  {
    framework: 'mezzio',
    language: 'php',
    detect: [{ file: 'composer.json', contains: '"mezzio/mezzio"' }],
    routes: {
      calls: ['$app->get', '$app->post', '$app->put', '$app->patch', '$app->delete', '$app->any', '$app->route'],
      handlerMethods: ['handle', 'process', '__invoke'],
    },
  },
  {
    framework: 'nestjs',
    language: 'node',
    detect: [{ file: 'package.json', contains: '"@nestjs/core"' }],
    routes: {
      decorators: ['Get', 'Post', 'Put', 'Patch', 'Delete', 'All'],
      prefix: { decorator: 'Controller' },
    },
  },
  {
    framework: 'fastapi',
    language: 'python',
    detect: [
      { file: 'pyproject.toml', contains: 'fastapi' },
      { file: 'requirements.txt', contains: 'fastapi' },
    ],
    routes: {
      decorators: ['get', 'post', 'put', 'patch', 'delete', 'api_route'],
      prefix: { assign: 'APIRouter', keyword: 'prefix' },
      mount: { keyword: 'prefix' },
    },
  },
];
