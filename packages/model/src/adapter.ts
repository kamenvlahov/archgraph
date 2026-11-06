import type { Edge, Node, TypeId, TypeShape } from './types.ts';

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
}

export interface LanguageAdapter {
  language: string;
  extensions: string[];
  read(files: SourceFile[]): Promise<GraphFragment>;
}
