import {
  edge,
  type CallSite,
  type Edge,
  type Expr,
  type Field,
  type GraphFragment,
  type LanguageAdapter,
  type Location,
  type Member,
  type Node as GraphNode,
  type Port,
  type SourceFile,
  type TypeRef,
  type TypeShape,
} from '@archgraph/model';
import { withTree, type Node, type Parser } from '@archgraph/syntax';
import { pythonParser } from './grammar.ts';

const UNKNOWN: TypeRef = { kind: 'unknown' };
const PRIMITIVES = new Set(['int', 'str', 'float', 'bool', 'bytes', 'complex', 'object']);
const SEQUENCES = new Set([
  'list',
  'List',
  'set',
  'Set',
  'frozenset',
  'FrozenSet',
  'Sequence',
  'MutableSequence',
  'Iterable',
  'Iterator',
  'Collection',
  'AbstractSet',
]);
const MAPPINGS = new Set(['dict', 'Dict', 'Mapping', 'MutableMapping', 'defaultdict', 'OrderedDict']);

interface Ctx {
  module: string;
  file: string;
  parser: Parser;
  locals: Set<string>;
  imports: Map<string, string>; // локално име → пълно име (модул.Име или модул)
  edges: Edge[];
  calls: CallSite[];
  types: Record<string, TypeShape>;
}

export const pythonAdapter: LanguageAdapter = {
  language: 'python',
  extensions: ['.py', '.pyi'],
  // Празна среда: иначе scip-python вика `pip list`, а външните пакети не ни трябват.
  indexer: {
    command: 'scip-python',
    args: (out, tmp) => [
      'index',
      '--quiet',
      '--project-version',
      '0',
      '--output',
      out,
      '--environment',
      `${tmp}/env.json`,
    ],
    files: { 'env.json': '[]' },
  },
  async read(files: SourceFile[]): Promise<GraphFragment> {
    const parser = await pythonParser();
    // С src/__init__.py `src` е пакет и импортите са `from src.x import Y`.
    const srcIsPackage = files.some((f) => f.path === 'src/__init__.py');
    const edges: Edge[] = [];
    const calls: CallSite[] = [];
    const types: Record<string, TypeShape> = {};
    const nodes = files.flatMap((file) => {
      const ctx: Ctx = {
        module: moduleName(file.path, srcIsPackage),
        file: file.path,
        parser,
        locals: new Set(),
        imports: new Map(),
        edges,
        calls,
        types,
      };
      return withTree(parser, file.text, (tree) => readModule(tree.rootNode, ctx));
    });
    return { nodes, edges, types, calls };
  },
};

// app/orders/models.py → app.orders.models; pkg/__init__.py → pkg; src/ layout без `src.`,
// освен ако самият `src` е пакет.
export function moduleName(path: string, srcIsPackage = false): string {
  return (srcIsPackage ? path : path.replace(/^src\//, ''))
    .replace(/\.pyi?$/, '')
    .replace(/\/__init__$/, '')
    .split('/')
    .join('.');
}

function readModule(root: Node, ctx: Ctx): GraphNode[] {
  const decls: Node[] = [];
  for (const stmt of root.namedChildren) {
    if (stmt.type === 'import_statement' || stmt.type === 'import_from_statement') addImports(stmt, ctx);
    const def = definition(stmt);
    if (def) {
      decls.push(stmt);
      ctx.locals.add(def.childForFieldName('name')?.text ?? '');
    }
  }
  return decls.map((stmt) => readDeclaration(stmt, ctx));
}

function definition(stmt: Node): Node | undefined {
  const def = stmt.type === 'decorated_definition' ? stmt.childForFieldName('definition') : stmt;
  return def && (def.type === 'class_definition' || def.type === 'function_definition') ? def : undefined;
}

// import a.b as c; from a.b import X as Y; from ..core import Base
function addImports(stmt: Node, ctx: Ctx) {
  const names = stmt.childrenForFieldName('name');
  if (stmt.type === 'import_statement') {
    for (const n of names) {
      const full = (n.type === 'aliased_import' ? n.childForFieldName('name') : n)?.text ?? '';
      const alias = n.type === 'aliased_import' ? n.childForFieldName('alias')?.text : full.split('.')[0];
      if (alias) ctx.imports.set(alias, n.type === 'aliased_import' ? full : alias);
    }
    return;
  }
  const from = stmt.childForFieldName('module_name');
  const module = from?.type === 'relative_import' ? relative(from, ctx) : (from?.text ?? '');
  for (const n of names) {
    const name = (n.type === 'aliased_import' ? n.childForFieldName('name') : n)?.text ?? '';
    const alias = n.type === 'aliased_import' ? (n.childForFieldName('alias')?.text ?? name) : name;
    ctx.imports.set(alias, `${module}.${name}`);
  }
}

function relative(rel: Node, ctx: Ctx): string {
  const dots = rel.namedChildren.find((c) => c.type === 'import_prefix')?.text.length ?? 1;
  const rest = rel.namedChildren.find((c) => c.type === 'dotted_name')?.text;
  const isPackage = ctx.file.endsWith('__init__.py');
  const parts = ctx.module.split('.');
  const base = parts.slice(0, parts.length - (isPackage ? dots - 1 : dots));
  return [...base, ...(rest ? [rest] : [])].join('.');
}

function named(name: string, ctx: Ctx, args?: TypeRef[]): TypeRef {
  const [head = '', ...rest] = name.split('.');
  const imported = ctx.imports.get(head);
  const full = imported ? [imported, ...rest].join('.') : ctx.locals.has(head) ? `${ctx.module}.${name}` : name;
  const id = `python:${full}`;
  return args ? { kind: 'named', id, args } : { kind: 'named', id };
}

function location(n: Node, file: string): Location {
  return { file, line: n.startPosition.row + 1, endLine: n.endPosition.row + 1 };
}

function decorators(stmt: Node): string[] {
  if (stmt.type !== 'decorated_definition') return [];
  return stmt.namedChildren.filter((c) => c.type === 'decorator').map((d) => d.namedChildren[0]?.text ?? '');
}

function readDeclaration(stmt: Node, ctx: Ctx): GraphNode {
  const def = definition(stmt) as Node;
  const name = def.childForFieldName('name')?.text ?? '';
  const node: GraphNode = {
    id: `python:${ctx.module}.${name}`,
    kind: 'class',
    name,
    language: 'python',
    location: location(stmt, ctx.file),
    members: [],
  };
  if (def.type === 'function_definition') {
    node.kind = 'function';
    node.members = [readMember(stmt, node.id, ctx, false)];
    readCalls(def, node.members[0] as Member, { node: node.id, props: new Map(), isMethod: false, ctx });
    return node;
  }
  const bases = (def.childForFieldName('superclasses')?.namedChildren ?? [])
    .filter((b) => b.type !== 'keyword_argument')
    .map((b) => (b.type === 'subscript' ? (b.childForFieldName('value')?.text ?? '') : b.text));
  if (bases.some((b) => b === 'Protocol' || b.endsWith('.Protocol'))) node.kind = 'interface';
  else if (bases.some((b) => b === 'ABC' || b.endsWith('.ABC'))) node.tags = ['abstract'];
  // Всяка база е extends. Engine-ът го прави implements, когато базата е Protocol (interface).
  for (const base of bases) {
    const to = named(base, ctx);
    if (to.kind === 'named') ctx.edges.push(edge('extends', { node: node.id }, { node: to.id }));
  }
  const body = def.childForFieldName('body')?.namedChildren ?? [];
  const methods = body.filter((s) => definition(s)?.type === 'function_definition');
  node.members = methods.map((s) => readMember(s, node.id, ctx, true));
  const init = methods.findIndex((_, i) => node.members[i]?.name === '__init__');
  const fields = readFields(body, init < 0 ? undefined : (methods[init] as Node), node.members[init], ctx);
  if (fields.length > 0) ctx.types[node.id] = { id: node.id, name, nodeId: node.id, fields };
  // `self.x = ...` в останалите методи допълва типовете, затова __init__ е най-напред.
  const props = new Map<string, Expr>(
    fields.filter((f) => f.type.kind !== 'unknown').map((f) => [f.name, { kind: 'type', type: f.type }]),
  );
  const order = methods
    .map((_, i) => i)
    .sort((a, b) => +(node.members[b]?.name === '__init__') - +(node.members[a]?.name === '__init__'));
  for (const i of order) {
    const isMethod = !decorators(methods[i] as Node).includes('staticmethod');
    readCalls(definition(methods[i] as Node) as Node, node.members[i] as Member, {
      node: node.id,
      props,
      isMethod,
      ctx,
    });
  }
  return node;
}

function readMember(stmt: Node, owner: string, ctx: Ctx, isMethod: boolean): Member {
  const fn = definition(stmt) as Node;
  const name = fn.childForFieldName('name')?.text ?? '';
  const decos = decorators(stmt);
  const isStatic = decos.includes('staticmethod') || decos.includes('classmethod');
  let params = (fn.childForFieldName('parameters')?.namedChildren ?? []).filter(
    (p) => p.type !== 'keyword_separator' && p.type !== 'positional_separator' && p.type !== 'comment',
  );
  // self / cls не са портове.
  if (isMethod && !decos.includes('staticmethod')) params = params.slice(1);
  const member: Member = {
    name,
    visibility:
      name.startsWith('__') && !name.endsWith('__')
        ? 'private'
        : name.startsWith('_') && !name.endsWith('__')
          ? 'protected'
          : 'public',
    inputs: params.map((p) => readPort(p, ctx)),
    location: location(stmt, ctx.file),
  };
  member.inputs.forEach((port, i) => {
    const provider = dependsOn(params[i] as Node, port, ctx);
    if (provider) ctx.edges.push(edge('injects', { node: provider }, { node: owner, member: name, port: port.name }));
  });
  if (isMethod && isStatic) member.static = true;
  if (fn.children.some((c) => c.type === 'async')) member.async = true;
  if (name !== '__init__') {
    const annotation = fn.childForFieldName('return_type');
    const type = annotation ? typeRef(annotation, ctx) : UNKNOWN;
    if (!(type.kind === 'primitive' && type.name === 'None')) member.output = { name: 'return', type };
  }
  return member;
}

function readPort(p: Node, ctx: Ctx): Port {
  const target = p.type === 'typed_parameter' ? (p.namedChildren[0] ?? p) : p;
  const splat = target.type === 'list_splat_pattern' || target.type === 'dictionary_splat_pattern';
  const nameNode = splat
    ? target.namedChildren[0]
    : p.type === 'identifier'
      ? p
      : (p.childForFieldName('name') ?? target);
  const annotation = p.childForFieldName('type');
  const port: Port = { name: nameNode?.text ?? '', type: annotation ? typeRef(annotation, ctx) : UNKNOWN };
  const value = p.childForFieldName('value');
  if (value) {
    port.optional = true;
    port.default = value.text;
  }
  if (splat) port.variadic = true;
  return port;
}

function lineOf(n: Node): number {
  return n.startPosition.row + 1;
}

// FastAPI: `x: S = Depends(get_s)` или `x: Annotated[S, Depends(get_s)]`. `Depends()` без аргумент ползва типа.
function dependsOn(p: Node, port: Port, ctx: Ctx): string | undefined {
  const calls = [p.childForFieldName('value'), ...(p.childForFieldName('type')?.descendantsOfType('call') ?? [])];
  const call = calls.find(
    (c) => c?.type === 'call' && /^(\w+\.)?(Depends|Security)$/.test(c.childForFieldName('function')?.text ?? ''),
  );
  if (!call) return undefined;
  const arg = call.childForFieldName('arguments')?.namedChildren[0];
  const ref = arg && arg.type !== 'keyword_argument' ? named(arg.text, ctx) : port.type;
  return ref.kind === 'named' ? ref.id : undefined;
}

function typeRef(t: Node, ctx: Ctx): TypeRef {
  switch (t.type) {
    case 'type':
      return t.namedChildren[0] ? typeRef(t.namedChildren[0], ctx) : UNKNOWN;
    case 'none':
      return { kind: 'primitive', name: 'None' };
    case 'identifier':
    case 'attribute': {
      if (PRIMITIVES.has(t.text) && !ctx.imports.has(t.text) && !ctx.locals.has(t.text))
        return { kind: 'primitive', name: t.text };
      const ref = named(t.text, ctx);
      return ref.kind === 'named' && (ref.id === 'python:typing.Any' || ref.id === 'python:Any')
        ? { kind: 'primitive', name: 'any' }
        : ref;
    }
    case 'string':
      return forwardRef(t, ctx);
    case 'union_type':
      // list[str] | None: граматиката дава union_type, когато в обединението има генеричен тип.
      return { kind: 'union', of: t.namedChildren.flatMap((c) => flatten(typeRef(c, ctx))) };
    case 'binary_operator':
      if (t.childForFieldName('operator')?.text !== '|') return { kind: 'unknown', hint: t.text };
      return { kind: 'union', of: flattenUnion(t).map((c) => typeRef(c, ctx)) };
    case 'generic_type':
    case 'subscript': {
      const head = t.type === 'subscript' ? t.childForFieldName('value') : t.namedChildren[0];
      const argNodes =
        t.type === 'subscript'
          ? t.childrenForFieldName('subscript')
          : (t.namedChildren.find((c) => c.type === 'type_parameter')?.namedChildren ?? []);
      return generic(head?.text ?? '', argNodes, ctx);
    }
    default:
      return { kind: 'unknown', hint: t.text };
  }
}

function generic(name: string, argNodes: Node[], ctx: Ctx): TypeRef {
  const base = name.split('.').at(-1) ?? name;
  const args = () => argNodes.map((a) => typeRef(a, ctx));
  if (base === 'Annotated') return argNodes[0] ? typeRef(argNodes[0], ctx) : UNKNOWN;
  if (base === 'Literal') return { kind: 'primitive', name: `Literal[${argNodes.map((a) => a.text).join(', ')}]` };
  if (base === 'Optional') return { kind: 'union', of: [...args(), { kind: 'primitive', name: 'None' }] };
  if (base === 'Union') return { kind: 'union', of: args() };
  const [first, second] = args();
  if (SEQUENCES.has(base) && first) return { kind: 'array', of: first };
  // tuple[int, ...] е последователност; tuple[int, str] остава като име с аргументи.
  if ((base === 'tuple' || base === 'Tuple') && first && argNodes[1]?.text === '...')
    return { kind: 'array', of: first };
  if (MAPPINGS.has(base) && first && second) return { kind: 'map', key: first, value: second };
  return named(name, ctx, args());
}

function flatten(t: TypeRef): TypeRef[] {
  return t.kind === 'union' ? t.of : [t];
}

function flattenUnion(t: Node): Node[] {
  return [t.childForFieldName('left'), t.childForFieldName('right')].flatMap((c) =>
    !c ? [] : c.type === 'binary_operator' && c.childForFieldName('operator')?.text === '|' ? flattenUnion(c) : [c],
  );
}

// "Order" като анотация (forward reference) се парсва като истински тип.
function forwardRef(t: Node, ctx: Ctx): TypeRef {
  const text = t.namedChildren.find((c) => c.type === 'string_content')?.text ?? '';
  return withTree(ctx.parser, `x: ${text}\n`, (tree) => {
    const type = tree.rootNode.descendantsOfType('type')[0];
    return type && !tree.rootNode.hasError ? typeRef(type, ctx) : { kind: 'unknown', hint: text };
  });
}

// Полетата: анотации на ниво клас (dataclass, Pydantic, TypedDict) и `self.x = ...` в __init__.
// Стойност по подразбиране прави полето незадължително, освен `Field(...)` / `field()` без default.
function readFields(body: Node[], init: Node | undefined, ctor: Member | undefined, ctx: Ctx): Field[] {
  const fields: Field[] = [];
  const assignments = (stmts: Node[]) =>
    stmts.flatMap((s) =>
      s.type === 'expression_statement' && s.namedChildren[0]?.type === 'assignment' ? [s.namedChildren[0]] : [],
    );
  for (const a of assignments(body)) {
    const left = a.childForFieldName('left');
    const type = a.childForFieldName('type');
    if (left?.type !== 'identifier' || !type || /^(typing\.)?ClassVar\b/.test(type.text)) continue;
    const f: Field = { name: left.text, type: typeRef(type, ctx) };
    if (hasDefault(a.childForFieldName('right'))) f.optional = true;
    fields.push(f);
  }
  const fn = init && definition(init);
  const self = fn?.childForFieldName('parameters')?.namedChildren[0]?.text;
  const block = fn?.childForFieldName('body');
  for (const a of assignments(block?.namedChildren ?? [])) {
    const left = a.childForFieldName('left');
    const name = left?.childForFieldName('attribute')?.text;
    if (left?.type !== 'attribute' || left.childForFieldName('object')?.text !== self || !name) continue;
    if (fields.some((f) => f.name === name)) continue;
    const annotation = a.childForFieldName('type');
    const value = a.childForFieldName('right');
    const param = value?.type === 'identifier' ? ctor?.inputs.find((p) => p.name === value.text) : undefined;
    fields.push({ name, type: annotation ? typeRef(annotation, ctx) : (param?.type ?? UNKNOWN) });
  }
  return fields;
}

function hasDefault(value: Node | null): boolean {
  if (!value) return false;
  if (value.type !== 'call' || !/^(\w+\.)?(Field|field)$/.test(value.childForFieldName('function')?.text ?? ''))
    return true;
  const args = value.childForFieldName('arguments')?.namedChildren ?? [];
  const first = args[0];
  if (first && first.type !== 'keyword_argument' && first.type !== 'ellipsis') return true;
  return args.some(
    (k) => k.type === 'keyword_argument' && /^default(_factory)?$/.test(k.childForFieldName('name')?.text ?? ''),
  );
}

interface Body {
  node: string;
  props: Map<string, Expr>;
  isMethod: boolean; // първият параметър е self / cls
  ctx: Ctx;
}

// Извикванията в тялото на функция или метод. Локалните променливи се помнят по реда на присвояване.
function readCalls(fn: Node, member: Member, b: Body) {
  const { ctx } = b;
  const from = { node: b.node, member: member.name };
  const vars = new Map<string, Expr>(member.inputs.map((p) => [p.name, { kind: 'type', type: p.type }]));
  // self / cls не е порт, затова името му идва от синтаксиса.
  const first = fn.childForFieldName('parameters')?.namedChildren[0];
  const self = b.isMethod && first?.type === 'identifier' ? first.text : undefined;
  if (self) vars.set(self, { kind: 'type', type: { kind: 'named', id: b.node } });

  const expr = (n: Node | null | undefined): Expr | undefined => {
    if (!n) return undefined;
    switch (n.type) {
      case 'identifier':
        // Не е локална променлива: клас при `OrderItem.of(...)`.
        return vars.get(n.text) ?? { kind: 'type', type: named(n.text, ctx) };
      case 'attribute': {
        const obj = n.childForFieldName('object');
        const name = n.childForFieldName('attribute')?.text ?? '';
        if (obj?.text === self && b.props.has(name)) return b.props.get(name);
        const of = expr(obj);
        return of && { kind: 'field', of, name };
      }
      case 'call': {
        const callee = n.childForFieldName('function');
        if (callee?.type === 'identifier' && !vars.has(callee.text)) {
          const ref = named(callee.text, ctx);
          return ref.kind === 'named' ? { kind: 'call', id: ref.id } : undefined;
        }
        if (callee?.type !== 'attribute') return undefined;
        const of = expr(callee.childForFieldName('object'));
        return of && { kind: 'result', of, name: callee.childForFieldName('attribute')?.text ?? '' };
      }
      case 'await':
      case 'parenthesized_expression':
        return expr(n.namedChildren[0]);
      default:
        return undefined;
    }
  };

  const bind = (target: Node | null, of: Expr | undefined) => {
    if (target?.type === 'identifier' && of) vars.set(target.text, { kind: 'element', of });
  };

  const visit = (n: Node) => {
    switch (n.type) {
      case 'assignment': {
        const left = n.childForFieldName('left');
        const type = n.childForFieldName('type');
        const value = type ? { kind: 'type' as const, type: typeRef(type, ctx) } : expr(n.childForFieldName('right'));
        if (!value) break;
        if (left?.type === 'identifier') vars.set(left.text, value);
        else if (left?.type === 'attribute' && left.childForFieldName('object')?.text === self) {
          const name = left.childForFieldName('attribute')?.text ?? '';
          if (!b.props.has(name)) b.props.set(name, value);
        }
        break;
      }
      case 'for_statement':
      case 'for_in_clause':
        bind(n.childForFieldName('left'), expr(n.childForFieldName('right')));
        break;
      case 'generator_expression':
      case 'list_comprehension':
      case 'set_comprehension':
      case 'dictionary_comprehension':
        // `item.subtotal() for item in self.items`: тялото е преди for-а, а типът на item идва от for-а.
        for (const c of n.namedChildren.filter((c) => c.type === 'for_in_clause')) visit(c);
        break;
      case 'call': {
        const callee = n.childForFieldName('function');
        if (callee?.type === 'identifier' && !vars.has(callee.text)) {
          const ref = named(callee.text, ctx);
          if (ref.kind === 'named') ctx.calls.push({ from, line: lineOf(callee), kind: 'function', id: ref.id });
        } else if (callee?.type === 'attribute') {
          const obj = callee.childForFieldName('object');
          const attr = callee.childForFieldName('attribute') ?? callee;
          const on = expr(obj);
          if (on) ctx.calls.push({ from, line: lineOf(attr), kind: 'method', on, name: attr.text });
          // module.func() и package.module.func(): `import app.pricing as pricing; pricing.apply(...)`
          const head = callee.text.split('.')[0] ?? '';
          if (/^[\w.]+$/.test(callee.text) && !vars.has(head)) {
            const ref = named(callee.text, ctx);
            if (ref.kind === 'named') ctx.calls.push({ from, line: lineOf(attr), kind: 'function', id: ref.id });
          }
        }
        break;
      }
    }
    for (const c of n.namedChildren) visit(c);
  };
  const body = fn.childForFieldName('body');
  if (body) visit(body);
}
