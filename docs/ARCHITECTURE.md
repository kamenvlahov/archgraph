# Архитектура

## Слоеве

```
  PHP          Node (JS/TS)        Python
   │                │                 │
   ▼                ▼                 ▼
┌──────────────────────────────────────────────────────────┐
│ 1. Синтаксис   tree-sitter (WASM)                         │  класове, методи, сигнатури, импорти
│ 2. Семантика   SCIP индексатори / LSP                     │  референции, имплементации, типове
└────────────────────────────┬─────────────────────────────┘
                             ▼
┌──────────────────────────────────────────────────────────┐
│ 3. Езиков адаптер → общ модел (GraphModel)                │  един и същ за всички езици
└────────────────────────────┬─────────────────────────────┘
                             ▼
┌──────────────────────────────────────────────────────────┐
│ 4. Правила по framework (YAML) → роли, routes, DI връзки  │  docs/RULES.md
└────────────────────────────┬─────────────────────────────┘
                             ▼
┌──────────────── Engine (отделен процес, REST + SSE) ─────┐
│ граф в памет · наблюдение на файлове · заявки · планове  │
└───────┬──────────────────────┬───────────────────────┬───┘
        ▼                      ▼                       ▼
  VS Code разширение    JetBrains плъгин         MCP сървър
  (webview)             (JCEF, същият UI)        (AI агенти)
```

**Правило:** интерфейсът, подреждането, плановете и MCP работят **само с общия модел** и не знаят от какъв език идват данните. Всичко, което зависи от езика, е в адаптера. Всичко, което зависи от framework-а, е в YAML правилата.

## Технологии

| Част             | Избор                                         | Защо                                                               |
| ---------------- | --------------------------------------------- | ------------------------------------------------------------------ |
| Език на проекта  | TypeScript                                    | Engine, UI и VS Code разширението са на един език                  |
| Монорепо         | pnpm workspaces                               | Отделни пакети, общи типове                                        |
| Парсване         | `web-tree-sitter` (WASM)                      | Една библиотека за трите езика, без native билд и работи навсякъде |
| Семантика PHP    | `scip-php` + PHPDoc/phpstan типове            | Референции и генерици от PHPDoc                                    |
| Семантика Node   | `scip-typescript` (работи и за JS чрез JSDoc) | TS Compiler API отдолу, пълни типове                               |
| Семантика Python | `scip-python` (pyright)                       | Типови подсказки, наследяване                                      |
| Граф UI          | React + `@xyflow/react` (React Flow)          | Богати custom нодове с портове, zoom, minimap                      |
| Подреждане       | `elkjs` (layered)                             | Подрежда отляво надясно с портове, като процес                     |
| Комуникация      | REST + Server-Sent Events на 127.0.0.1        | Един engine за всички клиенти; браузър и VS Code без разлика.      |
| Кеш              | `.archgraph/` в проекта (gitignore)           | Пусканията след първото са бързи                                   |
| AI               | MCP сървър + генератор на планове (Markdown)  | Работи с Claude Code, Cursor и всеки MCP клиент                    |

## Структура на репото

```
archgraph/
├─ packages/
│  ├─ model/          общ модел: типове, валидация, сериализация
│  ├─ syntax/         обвивка около web-tree-sitter: зареждане на граматика, парсване, синтактични грешки
│  ├─ engine/         зарежда адаптери и правила, държи графа, наблюдава файлове, REST API
│  ├─ lang-php/       tree-sitter-php + scip-php → модел
│  ├─ lang-node/      tree-sitter-typescript/javascript + scip-typescript → модел
│  ├─ lang-python/    tree-sitter-python + scip-python → модел
│  ├─ rules/          YAML правила за frameworks + двигател за съпоставяне
│  ├─ ui/             React Flow приложение (webview и самостоятелно в браузър)
│  ├─ planner/        маркирани нодове → план за AI
│  └─ cli/            archgraph scan | serve | plan
├─ apps/
│  ├─ vscode/         VS Code разширение
│  ├─ mcp/            MCP сървър
│  └─ jetbrains/      (етап 9) Kotlin плъгин с JCEF
├─ fixtures/          малки примерни проекти за тестове
│  ├─ php-mezzio/  php-laravel/  php-symfony/
│  ├─ node-express/  node-nestjs/
│  └─ python-fastapi/  python-django/
└─ docs/
```

## Общ модел

```ts
type Language = string; // от регистъра: ядро 'php' | 'node' | 'python' + разширения

interface GraphModel {
  version: 1;
  root: string; // абсолютен път до проекта
  nodes: Node[];
  edges: Edge[];
  types: Record<TypeId, TypeShape>; // речник на типовете за структурата на портовете
  unresolved?: UnresolvedCall[]; // извиквания без ребро, които може да са пропусната връзка (D-011)
}

interface UnresolvedCall {
  // получателят е без тип или функцията я няма; пази се само ако името съвпада с член в проекта
  from: { node: string; member: string };
  name: string;
  line: number;
}

interface Node {
  id: string; // "php:App\\Order\\OrderService"
  kind: string; // от регистъра: ядро class | interface | trait | enum | function | module | route
  name: string;
  language: Language;
  role?: Role; // от правилата: controller, service, repository, factory, dto, entity...
  framework?: string; // "mezzio", "nestjs", "fastapi"...
  layer?: string; // от .archgraph/architecture.yaml: "domain", "application"... (D-009)
  context?: string; // bounded context / модул: "Order", "Billing"
  location: Location;
  members: Member[]; // методите → редове с портове в нода
  tags?: string[]; // "abstract", "final", "deprecated", "unused"
}

interface Member {
  name: string;
  visibility: 'public' | 'protected' | 'private';
  static?: boolean;
  async?: boolean;
  inputs: Port[]; // параметри
  output?: Port; // връщан тип
  throws?: TypeRef[];
  location: Location;
}

interface Port {
  name: string; // "dto", "return"
  type: TypeRef;
  optional?: boolean;
  default?: string;
  variadic?: boolean;
}

type TypeRef =
  | { kind: 'named'; id: TypeId; args?: TypeRef[] } // Order, Collection<Item>
  | { kind: 'primitive'; name: string } // int, string, bool, float, None
  | { kind: 'array'; of: TypeRef } // Item[], list[Item]
  | { kind: 'map'; key: TypeRef; value: TypeRef } // dict[str, int], array<string,int>
  | { kind: 'union'; of: TypeRef[] } // int|null, Optional[int]
  | { kind: 'shape'; fields: Field[] } // array{id:int}, TypedDict, { id: number }
  | { kind: 'unknown'; hint?: string }; // липсва тип - показва се като сив порт

interface TypeShape {
  // структурата, която се разгъва под порта
  id: TypeId;
  name: string;
  nodeId?: string; // ако типът е клас в проекта → линк към нода му
  fields: Field[]; // свойства / полета / DTO полета
}

interface Field {
  name: string;
  type: TypeRef;
  optional?: boolean;
  readonly?: boolean;
}

interface Edge {
  id: string;
  kind: string; // от регистъра: ядро implements | extends | injects | calls | creates | routes-to | returns | uses-type | binds
  from: { node: string; member?: string; port?: string };
  to: { node: string; member?: string; port?: string };
  confidence: 'exact' | 'inferred'; // exact = от SCIP/типове, inferred = от евристика
  location?: Location; // къде е описана връзката извън нода: DI регистрация, route файл
}

interface Location {
  file: string;
  line: number;
  endLine: number;
}
```

## Видове зависимости

| Зависимост                   | Ребро                   | Откъде                                                                            | Къде       |
| ---------------------------- | ----------------------- | --------------------------------------------------------------------------------- | ---------- |
| Наследяване                  | `extends`, `implements` | синтаксис                                                                         | ядро       |
| Инжектиране                  | `injects`               | конструктор, `Depends`, декоратори                                                | ядро       |
| Регистрация в DI             | `binds`                 | `bindings` в YAML правилата ([RULES.md](RULES.md#регистрация-на-услуги-bindings)) | ядро       |
| Създаване                    | `creates`               | `new X`, `X(...)`, фабрики                                                        | ядро       |
| Извикване (вкл. статично)    | `calls`                 | синтаксис + SCIP                                                                  | ядро       |
| Типове в сигнатури           | `uses-type`, `returns`  | портовете                                                                         | ядро       |
| HTTP вход                    | `routes-to`             | route файлове, декоратори                                                         | ядро       |
| Изгледи                      | `renders`, `includes`   | ресурсен адаптер за шаблони                                                       | разширение |
| Събития                      | `emits`, `listens`      | dispatch извиквания, listener регистрации                                         | разширение |
| Опашки и задачи              | `dispatches`, `handles` | `dispatch(new Job)`, message handlers                                             | разширение |
| Таблици                      | `maps-to`               | ORM атрибути, миграции                                                            | разширение |
| Модули и импорти             | `imports`               | `use`, `import`, `from ... import`                                                | разширение |
| Външни услуги и конфигурация | `requests`, `reads`     | HTTP клиенти, `env()`/`getenv`                                                    | разширение |

Ядрото покрива това, което има във всеки backend проект. Останалото е разширение по [D-007](DECISIONS.md), а за конкретния framework всичко се настройва в YAML правилата.

## Слоеве и контексти

Слоевете и контекстите са две независими оси, описани в `.archgraph/architecture.yaml` ([RULES.md](RULES.md#архитектура-на-проекта-слоеве-и-контексти), [D-009](DECISIONS.md)):

- **Слой** (`layer`): domain, application, adapters... според стила. В интерфейса слоевете са хоризонтални ленти, а elkjs подрежда нодовете в лентата на слоя им.
- **Контекст** (`context`): bounded context или модул. В интерфейса е група, която може да се свие, както групите в ComfyUI.
- **`allow`**: позволените посоки на зависимост. Ребро извън тях е нарушение. Маркира се в червено и се връща от MCP (`violations`).
- **Плановете за AI** включват слоя на всеки засегнат и нов клас и списъка от какво той не може да зависи.

## Разширяване

Ядрото не изброява всички компоненти на архитектурата ([D-007](DECISIONS.md)). Има три места за разширение:

| Какво               | Къде                        | Пример                                                 |
| ------------------- | --------------------------- | ------------------------------------------------------ |
| Видове нодове/ребра | регистър в `packages/model` | `template` + `renders`, `event` + `emits`/`listens`    |
| Роли                | каталог в YAML правилата    | `middleware`, `job`, `listener` със слой, цвят, икона  |
| Източници           | езиков или ресурсен адаптер | Go (език), Twig/Blade/Jinja, `services.yaml` (ресурси) |

Едно разширение обявява какво регистрира и носи адаптера си:

```ts
const views: Extension = { name: 'views', nodeKinds: ['template'], edgeKinds: ['renders', 'includes'] };
const registry = extendRegistry(CORE_REGISTRY, views);
validate(graph, registry);
```

Engine-ът сглобява регистъра от заредените разширения. Интерфейсът и плановете не съдържат списъци с видове. Взимат ги от регистъра и каталога на ролите.

## Портове и структура на типовете

Това е сърцето на интерфейса. Всеки публичен метод е ред в нода. Параметрите са **входни портове** вляво, а връщаният тип е **изходен порт** вдясно. Ако типът е DTO, клас или shape, портът се **разгъва** и показва полетата си, рекурсивно до зададена дълбочина.

**Цветове по тип**, както IMAGE и LATENT в ComfyUI. Еднакъв тип има еднакъв цвят, затова на око се вижда къде данните „текат“ правилно:

| Категория          | Цвят         | Примери                         |
| ------------------ | ------------ | ------------------------------- |
| Примитиви          | сиво-син     | int, string, bool               |
| DTO / value object | зелен        | PlaceOrderDto, OrderData        |
| Entity / модел     | оранжев      | Order, User                     |
| Колекция           | лилав        | Item[], Collection<Order>       |
| Request / Response | син          | ServerRequestInterface, Request |
| Неизвестен         | сив, пунктир | липсва тип                      |

**Интерфейсите** се рисуват с пунктирна рамка и надпис «interface». Показват само договора, т.е. сигнатурите. Имплементациите са свързани с ребро `implements`. Ако имплементацията не спазва договора (различен тип или липсващ метод), портът се маркира в червено.

**Откъде идват типовете, по езици:**

| Език   | Основен източник  | Допълнително                                                                                                                     |
| ------ | ----------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| PHP    | type hints (8.x)  | PHPDoc `@param`/`@return`, phpstan/psalm shapes `array{id:int}`, генерици `Collection<Order>`, промотирани конструктор параметри |
| Node   | TypeScript типове | JSDoc `@param {Order}` за чист JS; `interface`/`type` alias като shape; Zod/class-validator схеми като DTO                       |
| Python | type hints        | dataclass, Pydantic модели, TypedDict, `Optional`/`Union`; без hints → `unknown`                                                 |

Където няма тип, портът остава сив с `unknown`. Така в графа се вижда и къде кодът няма типове.

## Синхронизация

1. Първото сканиране парсва всичко с tree-sitter и пуска SCIP индексатора. Резултатът отива в кеша `.archgraph/`.
2. Наблюдател на файлове: при промяна на файл се препарсва само той с tree-sitter, за милисекунди. Нодовете и ребрата от него се подменят.
3. SCIP се пуска отново на заден план с debounce. Дотогава ребрата от евристиката са с `confidence: 'inferred'` и се показват с пунктир.
4. Engine-ът праща на UI-а само разликите (`graph/patch`), не целия граф.

## Протокол engine ↔ клиенти (REST + Server-Sent Events)

Engine-ът е `archgraph serve`: HTTP само на 127.0.0.1. Интерфейсът в браузъра и VS Code разширението ползват едно и също API. Промените по файловете идват като събития, а клиентът презарежда каквото показва.

| Ресурс                                | Описание                                               |
| ------------------------------------- | ------------------------------------------------------ |
| `GET /api/project`                    | име, корен, файлове по език, framework-и               |
| `GET /api/endpoints`                  | входните точки: route-овете (без тях controller-ите)   |
| `GET /api/search?q=`                  | класове, функции и методи по име                       |
| `GET /api/processes/{target}?depth=N` | процесът от ендпойнт, клас или метод                   |
| `GET /api/nodes?file=&line=`          | нодът и методът на това място (курсорът в редактора)   |
| `POST /api/plans` `{task, targets}`   | маркирани нодове + задача → план за AI (Markdown)      |
| `GET /api/events`                     | SSE: `changed` с файловете, след като графът е обновен |

Отварянето на `file:line` е съобщение от панела към VS Code разширението, а курсорът в редактора е съобщение в обратната посока. Шаблоните (`pattern/apply`, етап 8) ще са `POST /api/patterns`.

MCP сървърът дава същите заявки като MCP инструменти: `trace`, `dependents`, `describe_node`, `find_by_role`, `plan`.
