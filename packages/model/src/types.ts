// Общият модел от docs/ARCHITECTURE.md. Тук няма нищо, което зависи от език или framework.
// Видовете нодове, ребра и езици са в registry.ts.

export const MODEL_VERSION = 1;

export const VISIBILITIES = ['public', 'protected', 'private'] as const;
export const CONFIDENCES = ['exact', 'inferred'] as const;
export const TYPE_REF_KINDS = ['named', 'primitive', 'array', 'map', 'union', 'shape', 'unknown'] as const;

export type Visibility = (typeof VISIBILITIES)[number];
export type Confidence = (typeof CONFIDENCES)[number];

// Ролите идват от YAML правилата (docs/RULES.md), а видовете и езиците от регистъра.
export type Role = string;
export type Language = string;
export type NodeKind = string;
export type EdgeKind = string;
export type TypeId = string;

export interface GraphModel {
  version: typeof MODEL_VERSION;
  root: string;
  nodes: Node[];
  edges: Edge[];
  types: Record<TypeId, TypeShape>;
}

export interface Node {
  id: string;
  kind: NodeKind;
  name: string;
  language: Language;
  role?: Role;
  framework?: string;
  // от архитектурата на проекта (.archgraph/architecture.yaml): слой и bounded context/модул
  layer?: string;
  context?: string;
  location: Location;
  members: Member[];
  tags?: string[];
}

export interface Member {
  name: string;
  visibility: Visibility;
  static?: boolean;
  async?: boolean;
  inputs: Port[];
  output?: Port;
  throws?: TypeRef[];
  location: Location;
}

export interface Port {
  name: string;
  type: TypeRef;
  optional?: boolean;
  default?: string;
  variadic?: boolean;
}

export type TypeRef =
  | { kind: 'named'; id: TypeId; args?: TypeRef[] }
  | { kind: 'primitive'; name: string }
  | { kind: 'array'; of: TypeRef }
  | { kind: 'map'; key: TypeRef; value: TypeRef }
  | { kind: 'union'; of: TypeRef[] }
  | { kind: 'shape'; fields: Field[] }
  | { kind: 'unknown'; hint?: string };

export interface TypeShape {
  id: TypeId;
  name: string;
  nodeId?: string;
  fields: Field[];
}

export interface Field {
  name: string;
  type: TypeRef;
  optional?: boolean;
  readonly?: boolean;
}

export interface EdgeEnd {
  node: string;
  member?: string;
  port?: string;
}

export interface Edge {
  id: string;
  kind: EdgeKind;
  from: EdgeEnd;
  to: EdgeEnd;
  confidence: Confidence;
  // къде е описана връзката, ако не е в кода на нода (DI регистрация, route файл)
  location?: Location;
}

export interface Location {
  file: string;
  line: number;
  endLine: number;
}
