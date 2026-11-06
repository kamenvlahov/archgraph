import type {
  GraphFragment,
  LanguageAdapter,
  Location,
  Member,
  Node as GraphNode,
  NodeKind,
  Port,
  SourceFile,
  TypeRef,
} from '@archgraph/model';
import { withTree, type Node } from '@archgraph/syntax';
import { phpParser } from './grammar.ts';
import { isPrimitive, parseDocComment, parseDocType, type DocComment } from './phpdoc.ts';

const KINDS: Record<string, NodeKind> = {
  class_declaration: 'class',
  interface_declaration: 'interface',
  trait_declaration: 'trait',
  enum_declaration: 'enum',
};
const TAGS: Record<string, string> = {
  abstract_modifier: 'abstract',
  final_modifier: 'final',
  readonly_modifier: 'readonly',
};

interface Scope {
  namespace: string;
  uses: Map<string, string>; // alias (lowercase) → пълно име
  self?: string;
}

export const phpAdapter: LanguageAdapter = {
  language: 'php',
  extensions: ['.php'],
  async read(files: SourceFile[]): Promise<GraphFragment> {
    const parser = await phpParser();
    const nodes = files.flatMap((file) => withTree(parser, file.text, (tree) => readFile(tree.rootNode, file.path)));
    return { nodes, edges: [], types: {} };
  },
};

function readFile(root: Node, file: string): GraphNode[] {
  const nodes: GraphNode[] = [];
  const scope: Scope = { namespace: '', uses: new Map() };
  const visit = (statements: Node[]) => {
    for (const n of statements) {
      if (n.type === 'namespace_definition') {
        scope.namespace = n.childForFieldName('name')?.text ?? '';
        scope.uses = new Map();
        const body = n.childForFieldName('body');
        if (body) visit(body.namedChildren);
      } else if (n.type === 'namespace_use_declaration') {
        addUses(n, scope);
      } else if (KINDS[n.type]) {
        nodes.push(readClass(n, file, scope));
      } else if (n.type === 'function_definition') {
        nodes.push(readFunction(n, file, scope));
      }
    }
  };
  visit(root.namedChildren);
  return nodes;
}

// use A\B; use A\B as C; use A\{B, C as D};
function addUses(decl: Node, scope: Scope) {
  const group = decl.namedChildren.find((c) => c.type === 'namespace_use_group');
  const prefix = group ? decl.namedChildren.find((c) => c.type === 'namespace_name')?.text : undefined;
  const clauses = (group ?? decl).namedChildren.filter((c) => c.type === 'namespace_use_clause');
  for (const clause of clauses) {
    const alias = clause.childForFieldName('alias');
    const name = clause.namedChildren.find((c) => c !== alias && (c.type === 'qualified_name' || c.type === 'name'));
    if (!name) continue;
    const full = (prefix ? `${prefix}\\${name.text}` : name.text).replace(/^\\/, '');
    const key = alias?.text ?? full.split('\\').at(-1) ?? full;
    scope.uses.set(key.toLowerCase(), full);
  }
}

function resolveClass(name: string, scope: Scope): string {
  if (name.startsWith('\\')) return name.slice(1);
  if (['self', 'static', '$this'].includes(name.toLowerCase()) && scope.self) return scope.self;
  const [first = '', ...rest] = name.split('\\');
  const used = scope.uses.get(first.toLowerCase());
  if (used) return [used, ...rest].join('\\');
  return scope.namespace ? `${scope.namespace}\\${name}` : name;
}

function named(name: string, scope: Scope, args?: TypeRef[]): TypeRef {
  const id = `php:${resolveClass(name, scope)}`;
  return args ? { kind: 'named', id, args } : { kind: 'named', id };
}

function location(n: Node, file: string): Location {
  return { file, line: n.startPosition.row + 1, endLine: n.endPosition.row + 1 };
}

function readClass(n: Node, file: string, outer: Scope): GraphNode {
  const body = n.childForFieldName('body');
  // Счупено заглавие (напр. `class Null` от PHP 5): tree-sitter взима грешно име, затова го четем от текста.
  const broken = n.namedChildren.some((c) => c.type === 'ERROR' && (!body || c.startIndex < body.startIndex));
  const name =
    (broken ? /(?<!::)\b(?:class|interface|trait|enum)\s+(\w+)/i.exec(n.text)?.[1] : undefined) ??
    n.childForFieldName('name')?.text ??
    '';
  const fqn = outer.namespace ? `${outer.namespace}\\${name}` : name;
  const scope: Scope = { ...outer, self: fqn };
  const tags = n.namedChildren.flatMap((c) => (TAGS[c.type] ? [TAGS[c.type] as string] : []));
  if (broken) tags.push('syntax-error');
  const members = (body?.namedChildren ?? [])
    .filter((c) => c.type === 'method_declaration')
    .map((m) => readMember(m, file, scope));
  const node: GraphNode = {
    id: `php:${fqn}`,
    kind: KINDS[n.type] ?? 'class',
    name,
    language: 'php',
    location: location(n, file),
    members,
  };
  if (tags.length > 0) node.tags = tags;
  return node;
}

// Функция извън клас е нод с един член със същото име (fixtures/README.md).
function readFunction(n: Node, file: string, outer: Scope): GraphNode {
  const name = n.childForFieldName('name')?.text ?? '';
  const fqn = outer.namespace ? `${outer.namespace}\\${name}` : name;
  return {
    id: `php:${fqn}`,
    kind: 'function',
    name,
    language: 'php',
    location: location(n, file),
    members: [readMember(n, file, outer)],
  };
}

function readMember(n: Node, file: string, scope: Scope): Member {
  const name = n.childForFieldName('name')?.text ?? '';
  const doc = docComment(n);
  const member: Member = {
    name,
    visibility: visibility(n),
    inputs: (n.childForFieldName('parameters')?.namedChildren ?? [])
      .filter((p) => p.type.endsWith('_parameter'))
      .map((p) => readPort(p, scope, doc)),
    location: location(n, file),
  };
  if (n.namedChildren.some((c) => c.type === 'static_modifier')) member.static = true;
  if (name.toLowerCase() !== '__construct') {
    const type = docType(doc?.return, scope) ?? nativeType(n.childForFieldName('return_type'), scope);
    if (!(type?.kind === 'primitive' && type.name === 'void'))
      member.output = { name: 'return', type: type ?? { kind: 'unknown' } };
  }
  return member;
}

function visibility(n: Node): Member['visibility'] {
  const v = n.namedChildren.find((c) => c.type === 'visibility_modifier')?.text.toLowerCase();
  return v === 'protected' || v === 'private' ? v : 'public';
}

function readPort(p: Node, scope: Scope, doc: DocComment | undefined): Port {
  const name = (p.childForFieldName('name')?.text ?? '').replace(/^\$/, '');
  const port: Port = {
    name,
    type: docType(doc?.params.get(name), scope) ??
      nativeType(p.childForFieldName('type'), scope) ?? { kind: 'unknown' },
  };
  const def = p.childForFieldName('default_value');
  if (def) {
    port.optional = true;
    port.default = def.text;
  }
  if (p.type === 'variadic_parameter') port.variadic = true;
  return port;
}

// PHPDoc точно преди метода (атрибутите са вътре в метода, така че не пречат).
function docComment(n: Node): DocComment | undefined {
  const prev = n.previousNamedSibling;
  if (prev?.type !== 'comment' || !prev.text.startsWith('/**')) return undefined;
  if (prev.endPosition.row < n.startPosition.row - 1) return undefined;
  return parseDocComment(prev.text);
}

function docType(text: string | undefined, scope: Scope): TypeRef | undefined {
  return text ? parseDocType(text, (name, args) => named(name, scope, args)) : undefined;
}

function nativeType(t: Node | null, scope: Scope): TypeRef | undefined {
  if (!t) return undefined;
  switch (t.type) {
    case 'primitive_type':
    case 'bottom_type':
      return { kind: 'primitive', name: t.text.toLowerCase() };
    case 'named_type':
      return isPrimitive(t.text) ? { kind: 'primitive', name: t.text.toLowerCase() } : named(t.text, scope);
    case 'optional_type': {
      const inner = nativeType(t.namedChildren[0] ?? null, scope) ?? { kind: 'unknown' };
      return { kind: 'union', of: [inner, { kind: 'primitive', name: 'null' }] };
    }
    case 'union_type':
      return { kind: 'union', of: t.namedChildren.map((c) => nativeType(c, scope) ?? { kind: 'unknown' }) };
    default:
      // intersection и DNF типове нямат място в TypeRef засега.
      return { kind: 'unknown', hint: t.text };
  }
}
