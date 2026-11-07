import type { Edge, Node, TypeId, TypeRef, TypeShape } from './types.ts';

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
}

// Извикване в тялото на метод. Адаптерът знае само локалния контекст (параметри, свойства на класа,
// локални променливи), затова описва получателя като израз. Engine-ът извежда типа му, след като
// са известни всички нодове, и прави ребра `calls` и `creates`.
export type CallSite =
  | { from: Caller; kind: 'method'; on: Expr; name: string } // x.name()
  | { from: Caller; kind: 'function'; id: TypeId } // f(): функция или клас (в Python `X()` създава)
  | { from: Caller; kind: 'new'; id: TypeId }; // new X()

export interface Caller {
  node: string;
  member: string;
}

export type Expr =
  | { kind: 'type'; type: TypeRef } // известен тип: параметър, свойство, `this`, клас при статично извикване
  | { kind: 'field'; of: Expr; name: string } // $order->items
  | { kind: 'result'; of: Expr; name: string } // $repo->find($id)
  | { kind: 'call'; id: TypeId } // f() или X()
  | { kind: 'element'; of: Expr }; // foreach, for ... in, параметър на callback към map/reduce

export interface LanguageAdapter {
  language: string;
  extensions: string[];
  read(files: SourceFile[]): Promise<GraphFragment>;
}
