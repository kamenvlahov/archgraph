import type { Edge, Location, Node, TypeId, TypeRef, TypeShape } from './types.ts';

// Договорът между engine-а и езиковите адаптери. Тук са само типове,
// за да не зависи моделът от tree-sitter или от конкретен език.

export interface SourceFile {
  path: string; // относителен от корена на проекта, както в Location.file
  text: string;
}

// Частта от графа, която дава един адаптер. Engine-ът слива частите и валидира целия граф.
export interface GraphFragment {
  nodes: Node[];
  edges: Edge[];
  types: Record<TypeId, TypeShape>;
  calls?: CallSite[];
  annotations?: Annotation[];
}

// Синтактичен факт за правилата на framework-а (route-ове сега, по-късно роли и bindings).
// Адаптерът не знае framework-а. Дава декораторите и атрибутите с литералните им аргументи,
// извикванията извън класовете, които имат низов аргумент (`$app->post('/orders', H::class)`),
// и присвояванията на ниво модул от такова извикване (`router = APIRouter(prefix="/orders")`).
export interface Annotation {
  kind: 'decorator' | 'call' | 'assign' | 'object';
  // object: ключът, под който обектът стои в родителя си (`'invokables' => [...]`), ако има такъв
  key?: string;
  name: string; // както е в кода, без `@` и `#[`: `router.post`, `Post`, `$app->post`, `APIRouter`
  args: Arg[];
  on?: { node: string; member?: string }; // decorator: класът или методът
  target?: string; // assign: променливата
  // object: обект в масив (`[{ path: 'login', component: Login }]`), свойствата са именувани args;
  // `parent` е мястото на обекта, в чийто масив е вложен (`children: [...]`)
  parent?: Location;
  location: Location;
}

// `line` е редът на елемента в обект (PHP масив): регистрацията на услуга е ред в конфигурацията.
export type Arg = { name?: string; line?: number } & (
  | { kind: 'string'; value: string }
  | { kind: 'class'; id: TypeId } // `X::class`, `X` в TS/Python
  | { kind: 'other' }
);

// Извикване в тялото на метод. Адаптерът знае само локалния контекст (параметри, свойства на класа,
// локални променливи), затова описва получателя като израз. Engine-ът извежда типа му, след като
// са известни всички нодове, и прави ребра `calls` и `creates`.
export type CallSite =
  | { from: Caller; line: number; kind: 'method'; on: Expr; name: string } // x.name()
  | { from: Caller; line: number; kind: 'function'; id: TypeId } // f(): функция или клас (в Python `X()` създава)
  | { from: Caller; line: number; kind: 'new'; id: TypeId }; // new X()

// `line` е редът на името (`name` в `x->name(`), където SCIP слага референцията.
export interface Caller {
  node: string;
  member: string;
}

export type Expr =
  | { kind: 'type'; type: TypeRef } // известен тип: параметър, свойство, `this`, клас при статично извикване
  | { kind: 'field'; of: Expr; name: string } // $order->items
  | { kind: 'result'; of: Expr; name: string } // $repo->find($id)
  | { kind: 'call'; id: TypeId } // f() или X()
  | { kind: 'service'; key: string } // $container->get('OrderMap'): типът е в регистрацията на услугите
  | { kind: 'element'; of: Expr }; // foreach, for ... in, параметър на callback към map/reduce

export interface LanguageAdapter {
  language: string;
  extensions: string[];
  // `all`: пътищата на всички файлове на езика в проекта, когато се препрочитат само някои
  // (импортите към файл, който не е в `files`, пак трябва да се разрешат)
  read(files: SourceFile[], all?: string[]): Promise<GraphFragment>;
  indexer?: Indexer;
}

// SCIP индексатор за езика. Engine-ът го пуска в корена на проекта, ако командата е инсталирана.
export interface Indexer {
  command: string;
  args(out: string, tmp: string): string[];
  files?: Record<string, string>; // помощни файлове, които се записват в `tmp` преди пускането
  leaves?: string[]; // файлове, които индексаторът създава в проекта; трият се след него, ако ги е нямало
}
