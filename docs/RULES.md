# Правила за роли по framework

Ролите зависят от framework-а, а не от езика. „Controller“ в PHP означава едно в Mezzio и друго в Laravel. Затова разпознаването е в **YAML файлове с правила**, а не в кода на engine-а. За нов framework пишеш нов файл.

## Формат

```yaml
framework: mezzio
language: php
detect: # кога правилата се включват за проекта
  composer: ['mezzio/mezzio']

roles: # първото съвпадение печели, редът има значение
  controller:
    any:
      - implements: "Psr\\Http\\Server\\RequestHandlerInterface"
      - implements: "Psr\\Http\\Server\\MiddlewareInterface"
  factory:
    all:
      - name_suffix: 'Factory'
      - has_method: '__invoke'
  repository:
    any:
      - extends: "Doctrine\\ORM\\EntityRepository"
      - name_suffix: 'Repository'
  service:
    any:
      - namespace_contains: "\\Service\\"
      - name_suffix: 'Service'
  entity:
    any:
      - attribute: "Doctrine\\ORM\\Mapping\\Entity"
  dto:
    any:
      - name_suffix: ['Dto', 'Data', 'Request', 'Command']
      - readonly_class: true

wiring: # откъде идват връзките извън кода на класа
  di_config:
    method: 'ConfigProvider::getDependencies'
    keys: ['factories', 'aliases', 'invokables']
  factory_creates: '__invoke' # какво връща фабриката → ребро creates
  routes:
    calls: ['$app->get', '$app->post', '$app->put', '$app->delete', '$app->route']
```

### Условия

| Условие                            | Значение                                     |
| ---------------------------------- | -------------------------------------------- |
| `implements`, `extends`            | по пълното име на типа, транзитивно          |
| `name_suffix`, `name_prefix`       | по името на класа, низ или списък            |
| `namespace_contains` / `path_glob` | по namespace/модул или път на файла          |
| `attribute` / `decorator`          | PHP атрибут, TS/Python декоратор             |
| `has_method`                       | има метод с това име                         |
| `readonly_class`                   | PHP readonly class, frozen dataclass         |
| `kind`                             | class, interface, function…                  |
| `injected`                         | инжектира се някъде (конструктор, `Depends`) |
| `route_handler`                    | към него сочи route                          |
| `any` / `all` / `not`              | комбиниране                                  |

Няколко ключа в един обект трябва да важат всички. `implements` и `extends` гледат и външни типове (`Psr\Http\Server\RequestHandlerInterface`, `pydantic.BaseModel`). Кратко име (`Controller`, `dataclass`) съвпада с последната част на пълното.

Вградените правила са в `packages/rules/frameworks/*.yaml`. `detect` е речник файл в корена → низове, някой от които трябва да е в него. Правилата на проекта в `.archgraph/rules/*.yaml` са със същия формат; без `detect` важат винаги и са преди вградените.

## Първоначални frameworks

| Език   | Framework   | Роли                                                                                          | Връзки (wiring)                                                                  |
| ------ | ----------- | --------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| PHP    | **Mezzio**  | handler/middleware, factory, service, repository, entity                                      | `ConfigProvider`, routes в `config/routes.php`                                   |
| PHP    | **Laravel** | controller, model (Eloquent), service, repository, job, event/listener, request (FormRequest) | `routes/*.php`, service providers (`bind`, `singleton`), инжекция в конструктора |
| PHP    | **Symfony** | controller, service, repository, entity, command, subscriber                                  | атрибути `#[Route]`, autowiring, `services.yaml`                                 |
| Node   | **NestJS**  | controller, provider/service, module, repository, dto, guard, pipe                            | декоратори `@Controller`, `@Get`, `@Injectable`, `@Module({providers})`          |
| Node   | **Express** | router, handler, middleware, service                                                          | `app.get/router.post(...)` и подадените функции                                  |
| Python | **FastAPI** | router, endpoint, dependency, schema (Pydantic), repository, service                          | `@router.get`, `Depends(...)` → ребро `injects`                                  |
| Python | **Django**  | view, model, serializer, form, service, url                                                   | `urls.py` (`path`), `ForeignKey` → ребро към друг model                          |

## Примери

### NestJS

```yaml
framework: nestjs
language: node
detect:
  package_json: ['@nestjs/core']
roles:
  controller: { decorator: 'Controller' }
  service: { decorator: 'Injectable', name_suffix: 'Service' }
  repository: { any: [{ name_suffix: 'Repository' }, { decorator: 'InjectRepository', on: 'param' }] }
  module: { decorator: 'Module' }
  dto: { name_suffix: 'Dto' }
wiring:
  routes:
    decorators: ['Get', 'Post', 'Put', 'Patch', 'Delete']
    prefix_from: 'Controller'
  di: constructor_params
```

### FastAPI

```yaml
framework: fastapi
language: python
detect:
  requirements: ['fastapi']
roles:
  endpoint: { decorator: ['router.get', 'router.post', 'app.get', 'app.post'] }
  schema: { extends: 'pydantic.BaseModel' }
  repository: { name_suffix: 'Repository' }
  service: { name_suffix: 'Service' }
wiring:
  di:
    call: 'Depends' # def x(svc: OrderService = Depends(get_service)) → injects
  routes:
    decorators: ['get', 'post', 'put', 'patch', 'delete']
    prefix: { assign: 'APIRouter', keyword: 'prefix' } # router = APIRouter(prefix="/orders")
    mount: { keyword: 'prefix' } # app.include_router(router, prefix="/api")
```

> Правилата са YAML файлове в `packages/rules/frameworks/` (mezzio, zf2, nestjs, fastapi, aiohttp, flask, angular). Route-овете и регистрацията на услуги са под `wiring` ([D-012](DECISIONS.md)).

## Регистрация на услуги (`bindings`)

Коя имплементация дава DI контейнерът за даден интерфейс ([D-008](DECISIONS.md)). Всеки запис е **форма** (общ извличач в engine-а) с параметри. Нов framework или собствен контейнер означава нов YAML, а не нов код. Нов код трябва само за напълно нова форма.

Всеки запис създава ребро `binds`, от интерфейса към имплементацията, с `location` към реда на регистрацията. Ако формата има и потребител (contextual binding), реброто тръгва от порта на потребителя и важи само за него.

```yaml
bindings:
  - form: array_map # Interface::class => Impl::class в PHP масив
    in: 'ConfigProvider::getDependencies'
    keys: ['aliases'] # factories → creates от фабриката, invokables → без интерфейс
  - form: call # $this->app->bind(I::class, Impl::class)
    calls: ['$this->app->bind', '$this->app->singleton', '$this->app->scoped']
    args: { interface: 0, impl: 1 }
  - form: chain # $this->app->when(A::class)->needs(I::class)->give(B::class)
    steps: { consumer: when, interface: needs, impl: give }
  - form: config_file # services.yaml
    file: 'config/services.yaml'
    entries: 'services' # I: '@Impl' / I: { class: Impl } / _defaults.bind
  - form: attribute # #[AsAlias(I::class)] на имплементацията
    name: "Symfony\\Component\\DependencyInjection\\Attribute\\AsAlias"
    interface_arg: 0
  - form: object_literal # { provide: TOKEN, useClass: Impl }
    keys: { token: provide, impl: [useClass, useExisting], factory: useFactory }
  - form: provider_return # def get_repo() -> I: return Impl()  /  useFactory: () => new Impl()
    when: { decorator: 'lru_cache' } # по избор: кои функции са доставчици
  - form: string_path # Django settings: EMAIL_BACKEND = 'app.mail.SmtpBackend'
    file: '**/settings*.py'
    keys: ['*_BACKEND', '*_CLASS']
  - form: autowire # няма регистрация, но интерфейсът има точно една имплементация
    confidence: inferred
```

| Форма             | Покрива                                                                                           |
| ----------------- | ------------------------------------------------------------------------------------------------- |
| `array_map`       | Mezzio/Laminas `aliases`, Laravel `$bindings`/`$singletons` в provider                            |
| `call`            | Laravel `bind`/`singleton`/`scoped`/`instance`, InversifyJS `bind(I).to(X)`, `container.register` |
| `chain`           | Laravel contextual binding, InversifyJS `.whenTargetNamed()`                                      |
| `config_file`     | Symfony `services.yaml`/`.xml`, Laminas `module.config.php` в отделен файл                        |
| `attribute`       | Symfony `#[AsAlias]`, `#[Autowire(service:)]`, tsyringe `@injectable`/`@registry`                 |
| `object_literal`  | NestJS `providers` (`useClass`, `useExisting`, `useFactory`, `useValue`)                          |
| `provider_return` | FastAPI доставчици за `Depends`, Nest `useFactory`, Python `dependency-injector` `Factory`        |
| `string_path`     | Django `settings.py` (`*_BACKEND`), конфигурации с класове като низове                            |
| `autowire`        | Symfony/Laravel/Nest без изрична регистрация. Само при една имплементация, иначе „нееднозначно“.  |

Token вместо интерфейс (Nest `ORDER_REPOSITORY`) се свързва с интерфейса през мястото на инжектиране: `@Inject(TOKEN) x: I`.

**Правила на проекта.** Освен правилата за framework-а engine-ът чете и `.archgraph/rules/*.yaml` в самия проект. Така собствен контейнер или вътрешна конвенция се описва на място, без промяна в archgraph.

## Архитектура на проекта: слоеве и контексти

Слоевете зависят от архитектурата, а не от framework-а. Затова са в `.archgraph/architecture.yaml` в самия проект ([D-009](DECISIONS.md)). Готовите стилове се ползват направо или се променят.

```yaml
style: hexagonal # layered | clean | onion | hexagonal | mvc | none, задава слоеве и allow по подразбиране

layers: # първото съвпадение печели; условията са същите като при ролите + role
  - name: domain
    match: { any: [{ path_glob: 'src/*/Domain/**' }, { role: entity }] }
  - name: application
    match: { namespace_contains: "\\Application\\" }
  - name: ports
    match: { all: [{ kind: interface }, { namespace_contains: "\\Port\\" }] }
  - name: adapters
    match: { any: [{ path_glob: 'src/*/Infrastructure/**' }, { role: [controller, repository] }] }

allow: # от кой слой към кой е позволена зависимост; всичко друго е нарушение
  adapters: [application, ports, domain]
  application: [ports, domain]
  ports: [domain]
  domain: []

ignore_edges: [uses-type] # по избор: кои ребра не се проверяват (напр. DTO в сигнатури)

contexts: # bounded contexts / модули, независими от слоевете
  from: namespace_segment # или path_segment
  index: 1 # App\<Order>\... → context "Order"
  allow_cross: [binds, injects] # между контексти само през тези ребра (по избор)
```

| Стил        | Слоеве по подразбиране (отвън навътре)                                 |
| ----------- | ---------------------------------------------------------------------- |
| `layered`   | presentation → application → domain → infrastructure                   |
| `clean`     | frameworks → interface-adapters → use-cases → entities                 |
| `onion`     | infrastructure → application-services → domain-services → domain-model |
| `hexagonal` | adapters → application → ports → domain                                |
| `mvc`       | controller → model, controller → view                                  |
| `none`      | без слоеве; ползва се само слоят по подразбиране от каталога на ролите |

Ако проектът няма `architecture.yaml`, слоят идва от каталога на ролите: всяка роля има слой по подразбиране.

**Нарушения.** Ребро от слой A към слой B, което не е в `allow`, се маркира в графа и се връща от MCP. Например controller → repository при `layered`, или domain → infrastructure. Същото важи за ребро между два контекста, което не е в `allow_cross`.

Без изричен `allow` важат посоките на стила (всеки слой зависи от по-вътрешните; presentation вижда и domain). Без `architecture.yaml` важи `layered` върху слоевете от каталога. Ролите factory, module и dependency са слой `composition`: DI връзването вижда всичко и не се проверява. Освен слоевете и контекстите се отбелязват цикли между класове и имплементации, които нямат метод на интерфейса или искат повече параметри от него.

## Патерни

Освен ролите, правилата описват и **шаблони на патерни** за командата „правим …“:

```yaml
pattern: factory
language: php
framework: mezzio
params: [target] # "правим Factory за OrderService"
creates:
  - node: '{{target}}Factory'
    role: factory
    file: '{{dir(target)}}/{{target}}Factory.php'
    members:
      - name: __invoke
        inputs: [{ name: container, type: "Psr\\Container\\ContainerInterface" }]
        output: '{{target}}'
edges:
  - { kind: creates, from: '{{target}}Factory', to: '{{target}}' }
wiring:
  - di_config: { key: factories, entry: '{{target}}::class => {{target}}Factory::class' }
```

Шаблонът създава **ghost нодове**, полупрозрачни в графа. Те показват какво ще се появи. Файловете ги пишеш ти или AI по генерирания план. Когато файлът се появи в кода, ghost нодът става истински.

Начални патерни: Factory, Repository + Interface, Service + Interface, DTO, Strategy, Adapter, Decorator, Observer/Event + Listener, CQRS Command + Handler.

## Чертеж (етап 11)

`.archgraph/design.yaml` описва проект, който още го няма (или го допълва):

```yaml
stack: php-mezzio # php-mezzio | ts-nestjs | python-fastapi
style: ddd # layered | mvc | clean | hexagonal | onion | ddd
auth: User # ресурсът на влезлия: ендпойнтите искат вход, освен публичните
resources:
  User: { fields: { email: string } }
  Invoice: { owner: User, level: 3, fields: { total: float, issued_at: date } } # чий е, нивото и полетата
endpoints:
  - { method: POST, path: /users/login, input: { email: string, password: string }, public: true }
  - POST /invoices
  - POST /invoices/{id}/cancel
  - { method: GET, path: /reports/monthly, entity: Invoice, action: report }
  - method: POST
    path: /payments
    input: { invoice_id: int, amount: float, lines: [{ sku: string, qty: int }] } # полетата на DTO; без DTO — параметри
    output: { status: string, paid_at: datetime } # какво връщат методите: клас CreatePaymentResult
  - method: GET
    path: /invoices
    output: [Invoice] # избран тип: Invoice, Invoice[], int…
```

Типовете на полетата са `string`, `int`, `float`, `bool`, `date`, `datetime`, име на клас от чертежа, `[тип]` за масив (или `list[тип]`, `тип[]`) и `{поле: тип}` за вложен обект. Вложеният обект става клас до собственика си, в неговия слой (`photos: [{url: string}]` → `Photo`); стекът превежда простите типове (`types`).

Изходът е какво връщат методите на ендпойнта (service, use case, handler), не полета на entity-то. Той е или избран тип, или полета, от които става клас за отговора до DTO-тата: `{Action}{Entity}Result`, а при списък и при масив — `{Entity}Item` (полетата на един елемент). Без изход методите връщат ресурса.

Ресурсите описват entity-тата: полетата им (към тях се добавят `id` и собственикът като `{owner}_id`) и чии са. Собственикът е друг ресурс; по веригата от собственици (`Photo → Album → User`) до `auth` се знае кои данни са на влезлия. Тогава съобщението (или параметрите на методите) носи id-то на влезлия, `findAll` и търсенето в repository-то го получават (само неговите данни), а `create` в домейна получава собственика (`Invoice::create(userId, …)`). За отделен запис (път с id) проверката е по веригата: агрегатът най-горе преди влезлия (`Album`) получава `checkOwner(userId)` в стиловете с методи в домейна, а който вика repository-то (handler, service, use case) получава и repository-тата на собствениците над записа (за снимка — `AlbumRepository`), за да зареди албума ѝ. Ендпойнтите с `public: true` (регистрация, вход) не носят влезлия.

Нивото на ресурса (`level`) казва на колко парчета се разбива функционалността му. 3 (по подразбиране) е стилът изцяло: в DDD command/query и handler за всяко действие. 2 е един service за ресурса (в Clean — interactor, в Hexagonal — един port и един service). 1 е най-простото: входът вика repository-то и агрегата направо, а класът за отговора е до входа. Ниско ниво е за части, които няма да се разширяват (вход, профил), а високо — за ядрото, което ще расте. Стилът описва нивата си в `levels` (кои части се махат или сливат и кои ребра ги заместват); Layered и MVC нямат по-просто ниво, защото входът не може да прескочи service или вече е най-простото.

Проверката (`design_status`) сравнява кода с чертежа: какво още го няма, какво е излишно (клас, който друга архитектура или друг стек би имал, а този чертеж не), какво само се мести (същото име на друго място), различни сигнатури, липсващи полета и нарушения на слоевете. Най-горе е усилието: класове за писане, местене, махане и промяна, засегнатите файлове и редовете, които се пренасят. Със `style` или `stack` проверката е срещу друга архитектура или език, без запис: слоевете се смятат наново по пътищата на новия чертеж.

Ресурсът и действието идват от пътя: `POST /invoices` е `Invoice` + `create`, `GET /invoices` е `list`, а последната дума от списък с глаголи е действие (`/invoices/{id}/cancel`, `/admin/profile/edit`). Когато пътят подвежда, `entity` и `action` се дават изрично.

Стилът (`packages/rules/design/styles/*.yaml`) изрежда участниците на един ендпойнт: слой, роля, име, вид файл, дали са по един за ендпойнт или общи за ресурса, условие (`read`, `write`, `body`, `create`) и какви методи получават (`action`, `execute`, `handle`, `storage`, `domain`). `flow` казва кой кого вика, създава или рисува. Стекът (`packages/rules/design/stacks/*.yaml`) казва формата на входа (handler на ендпойнт, controller на ресурс, функция), id-то, файла, папките и реда за регистрация на route-а.
