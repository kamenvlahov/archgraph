// Правилата по framework (D-002, docs/RULES.md). Засега само `wiring.routes`, като данни със
// същата форма като YAML-а. Зареждането от `.yaml` идва с двигателя на правилата (TASK-020).

export interface FrameworkRules {
  framework: string;
  language: string;
  // правилата важат, ако някой от файловете в корена съдържа низа
  detect: { file: string; contains: string }[];
  routes?: RouteRules;
  // ключовете на масивите с регистрации на услуги (D-008, форма `array_map`)
  services?: { invokables: string[]; factories: string[]; aliases: string[] };
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
  // таблица от обекти: `{ path: 'x', component: X, children: [...] }` (Angular). Пътят на вложения
  // обект започва с пътищата на обектите, в които е; обект без handler само дава префикс.
  objects?: { path: string; handler: string[]; method: string };
  // ZF2/Laminas MVC: `'options' => ['route' => '/status[/][:action]', 'defaults' => ['controller' => ...]]`.
  // С `:action` в пътя всеки `…Action` метод на контролера е route; без него — `defaults.action`.
  segments?: { route: string; defaults: string; controller: string; action: string; suffix: string };
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
    services: { invokables: ['invokables'], factories: ['factories'], aliases: ['aliases'] },
  },
  {
    framework: 'zf2',
    language: 'php',
    detect: [
      { file: 'composer.json', contains: '"zendframework/zendframework"' },
      { file: 'composer.json', contains: '"zendframework/zend-mvc"' },
      { file: 'composer.json', contains: '"laminas/laminas-mvc"' },
    ],
    routes: {
      segments: { route: 'route', defaults: 'defaults', controller: 'controller', action: 'action', suffix: 'Action' },
    },
    services: { invokables: ['invokables'], factories: ['factories'], aliases: ['aliases'] },
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
  {
    framework: 'angular',
    language: 'node',
    detect: [{ file: 'package.json', contains: '"@angular/router"' }],
    routes: { objects: { path: 'path', handler: ['component', 'loadComponent'], method: 'PAGE' } },
  },
  {
    // `@routes.get("/prompt")`, често във вложена функция в метод (ComfyUI `PromptServer.__init__`)
    framework: 'aiohttp',
    language: 'python',
    detect: [
      { file: 'requirements.txt', contains: 'aiohttp' },
      { file: 'pyproject.toml', contains: 'aiohttp' },
    ],
    routes: { decorators: ['get', 'post', 'put', 'patch', 'delete', 'head', 'view'] },
  },
  {
    framework: 'flask',
    language: 'python',
    detect: [
      { file: 'requirements.txt', contains: 'flask' },
      { file: 'pyproject.toml', contains: 'flask' },
    ],
    routes: {
      decorators: ['route', 'get', 'post', 'put', 'patch', 'delete'],
      prefix: { assign: 'Blueprint', keyword: 'url_prefix' },
    },
  },
];
