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

| Условие                            | Значение                             |
| ---------------------------------- | ------------------------------------ |
| `implements`, `extends`            | по пълното име на типа, транзитивно  |
| `name_suffix`, `name_prefix`       | по името на класа, низ или списък    |
| `namespace_contains` / `path_glob` | по namespace/модул или път на файла  |
| `attribute` / `decorator`          | PHP атрибут, TS/Python декоратор     |
| `has_method`                       | има метод с това име                 |
| `readonly_class`                   | PHP readonly class, frozen dataclass |
| `any` / `all` / `not`              | комбиниране                          |

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
```

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
