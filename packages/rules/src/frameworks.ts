import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';

// Правилата по framework (D-002, docs/RULES.md): кога се включват, роли, route-ове и регистрация на услуги.

export interface FrameworkRules {
  framework: string;
  language: string;
  // правилата важат, ако някой от файловете в корена съдържа низа; празно — винаги (правила на проекта)
  detect: { file: string; contains: string }[];
  // ролите по ред: първото съвпадение печели
  roles?: Record<string, Condition>;
  routes?: RouteRules;
  // ключовете на масивите с регистрации на услуги (D-008, форма `array_map`)
  services?: { invokables: string[]; factories: string[]; aliases: string[] };
}

// Условие за роля (docs/RULES.md). Няколко ключа в един обект трябва да важат всички.
export interface Condition {
  any?: Condition[];
  all?: Condition[];
  not?: Condition;
  implements?: string | string[]; // по пълното име, транзитивно; и външни типове
  extends?: string | string[];
  name_suffix?: string | string[];
  name_prefix?: string | string[];
  namespace_contains?: string | string[]; // в id-то: namespace, модул или път
  path_glob?: string | string[];
  decorator?: string | string[]; // TS/Python декоратор
  attribute?: string | string[]; // PHP атрибут
  has_method?: string | string[];
  readonly_class?: boolean;
  kind?: string | string[]; // class, interface, function…
  injected?: boolean; // инжектира се някъде (конструктор, Depends)
  route_handler?: boolean; // към него сочи route
  role?: string | string[]; // за слоевете в architecture.yaml: ролята, вече дадена от правилата
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
  // route-ове в конфигурация (Mezzio `routes`): път, middleware-ите (handler-ът е последният) и методите
  config?: { path: string; middleware: string; methods: string };
  // ZF2/Laminas MVC: `'options' => ['route' => '/status[/][:action]', 'defaults' => ['controller' => ...]]`.
  // С `:action` в пътя всеки `…Action` метод на контролера е route; без него — `defaults.action`.
  segments?: { route: string; defaults: string; controller: string; action: string; suffix: string };
}

// Вградените правила са YAML файлове в packages/rules/frameworks/ (формат: docs/RULES.md).
export const FRAMEWORKS: FrameworkRules[] = loadFrameworks(join(import.meta.dirname, '../frameworks'));

// Всички `*.yaml` в папката. Липсваща папка не е грешка: проектът може да няма свои правила.
export function loadFrameworks(dir: string): FrameworkRules[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith('.yaml') || f.endsWith('.yml'))
    .sort()
    .map((f) => fromYaml(parse(readFileSync(join(dir, f), 'utf8')) as YamlRules, f));
}

interface YamlRules {
  framework?: string;
  language?: string;
  detect?: Record<string, string[]>; // файл в корена → низове, някой от които трябва да е в него
  roles?: Record<string, Condition>;
  wiring?: { routes?: RouteRules; services?: FrameworkRules['services'] };
}

function fromYaml(y: YamlRules, file: string): FrameworkRules {
  if (!y.framework || !y.language) throw new Error(`${file}: липсва framework или language`);
  const rules: FrameworkRules = {
    framework: y.framework,
    language: y.language,
    detect: Object.entries(y.detect ?? {}).flatMap(([f, values]) => values.map((contains) => ({ file: f, contains }))),
  };
  if (y.roles) rules.roles = y.roles;
  if (y.wiring?.routes) rules.routes = y.wiring.routes;
  if (y.wiring?.services) rules.services = y.wiring.services;
  return rules;
}
