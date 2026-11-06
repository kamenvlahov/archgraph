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
┌──────────────── Engine (отделен процес, JSON-RPC) ───────┐
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
| Комуникация      | JSON-RPC по stdio                             | Като LSP. Един engine за всички клиенти.                           |
| Кеш              | `.archgraph/` в проекта (gitignore)           | Пусканията след първото са бързи                                   |
| AI               | MCP сървър + генератор на планове (Markdown)  | Работи с Claude Code, Cursor и всеки MCP клиент                    |

## Структура на репото

```
archgraph/
├─ packages/
│  ├─ model/          общ модел: типове, валидация, сериализация
│  ├─ engine/         зарежда адаптери и правила, държи графа, наблюдава файлове, JSON-RPC
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
type Language = 'php' | 'node' | 'python';

interface GraphModel {
  version: 1;
  root: string; // абсолютен път до проекта
  nodes: Node[];
  edges: Edge[];
  types: Record<TypeId, TypeShape>; // речник на типовете за структурата на портовете
}

interface Node {
  id: string; // "php:App\\Order\\OrderService"
  kind: 'class' | 'interface' | 'trait' | 'enum' | 'function' | 'module' | 'route';
  name: string;
  language: Language;
  role?: Role; // от правилата: controller, service, repository, factory, dto, entity...
  framework?: string; // "mezzio", "nestjs", "fastapi"...
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
  kind: 'implements' | 'extends' | 'injects' | 'calls' | 'creates' | 'routes-to' | 'returns' | 'uses-type';
  from: { node: string; member?: string; port?: string };
  to: { node: string; member?: string; port?: string };
  confidence: 'exact' | 'inferred'; // exact = от SCIP/типове, inferred = от евристика
}

interface Location {
  file: string;
  line: number;
  endLine: number;
}
```

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

## Протокол engine ↔ клиенти (JSON-RPC)

| Метод                     | Описание                                                  |
| ------------------------- | --------------------------------------------------------- |
| `graph/get`               | целият граф или филтриран (по роля, папка, framework)     |
| `graph/patch` (известие)  | разлики след промяна на файл                              |
| `graph/trace`             | от route или метод: веригата надолу/нагоре до дълбочина N |
| `graph/dependents`        | кой зависи от даден нод                                   |
| `node/open` (към клиента) | отвори `file:line` в редактора                            |
| `pattern/apply`           | шаблон → празни нодове (ghost) + предложени файлове       |
| `plan/create`             | маркирани нодове + задача → план за AI (Markdown)         |

MCP сървърът дава същите заявки като MCP инструменти: `trace`, `dependents`, `describe_node`, `find_by_role`, `plan`.
