import {
  edge,
  PATH_LIKE,
  type Annotation,
  type Arg,
  type CallSite,
  type Edge,
  type Expr,
  type Field,
  type GraphFragment,
  type LanguageAdapter,
  type Location,
  type Member,
  type Node as GraphNode,
  type NodeKind,
  type PathCall,
  type Port,
  type SourceFile,
  type TypeRef,
  type TypeShape,
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

// Ребрата и извикванията от всички файлове.
interface Out {
  edges: Edge[];
  calls: CallSite[];
  paths: PathCall[];
  types: Record<string, TypeShape>;
  annotations: Annotation[];
}

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
    const out: Out = { edges: [], calls: [], paths: [], types: {}, annotations: [] };
    const nodes = files.flatMap((file) =>
      withTree(parser, file.text, (tree) => readFile(tree.rootNode, file.path, out)),
    );
    const { edges, types, calls, annotations, paths } = out;
    return { nodes, edges, types, calls, annotations, paths };
  },
};

function readFile(root: Node, file: string, out: Out): GraphNode[] {
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
        nodes.push(readClass(n, file, scope, out));
      } else if (n.type === 'function_definition') {
        nodes.push(readFunction(n, file, scope, out));
      } else {
        outsideCalls(n, file, scope, out);
      }
    }
  };
  visit(root.namedChildren);
  arrayFacts(root, file, scope, out);
  return nodes;
}

// PHP атрибутите като факти за правилата: `#[ORM\Entity]` → `Doctrine\ORM\Mapping\Entity` през `use`.
function attributes(decl: Node, on: { node: string; member?: string }, scope: Scope, file: string, out: Out) {
  for (const a of decl.childForFieldName('attributes')?.descendantsOfType('attribute') ?? []) {
    const name = a.namedChildren.find((c) => c.type === 'name' || c.type === 'qualified_name');
    const args = a.childForFieldName('parameters')?.namedChildren.filter((x) => x.type === 'argument') ?? [];
    out.annotations.push({
      kind: 'decorator',
      name: resolveClass(name?.text ?? '', scope),
      args: args.map((x) => ({
        ...argValue(x.namedChildren.at(-1), scope),
        ...(x.childForFieldName('name') ? { name: x.childForFieldName('name')?.text ?? '' } : {}),
      })),
      on,
      location: location(a, file),
    });
  }
}

// Масиви с низови ключове като факти: регистрация на услуги (`'invokables' => [...]`,
// `'aliases' => [I::class => C::class]`) и ZF2 route таблици. Смисълът им го дават правилата (D-012).
function arrayFacts(root: Node, file: string, scope: Scope, out: Out) {
  for (const arr of root.descendantsOfType('array_creation_expression')) {
    const args = arr.namedChildren.flatMap((el): Arg[] => {
      const [k, v] = el.namedChildren;
      if (el.type !== 'array_element_initializer' || !v) return [];
      const key = argValue(k, scope);
      const name = key.kind === 'string' ? key.value : key.kind === 'class' ? key.id : undefined;
      return name === undefined ? [] : [{ ...argValue(v, scope), name, line: el.startPosition.row + 1 }];
    });
    if (!args.length) continue;
    // `'invokables' => array(...)`: ключът на масива и масивът, в който е
    const holder = arr.parent?.type === 'array_element_initializer' ? arr.parent : undefined;
    const key =
      holder?.namedChildren[1]?.startIndex === arr.startIndex ? argValue(holder.namedChildren[0], scope) : undefined;
    const outer = holder?.parent?.type === 'array_creation_expression' ? holder.parent : undefined;
    out.annotations.push({
      kind: 'object',
      name: '',
      args,
      ...(key?.kind === 'string' ? { key: key.value } : {}),
      ...(outer ? { parent: location(outer, file) } : {}),
      location: location(arr, file),
    });
  }
}

const CALLS = ['member_call_expression', 'scoped_call_expression', 'function_call_expression'];

// Извикванията извън класовете (config файлове, closures на ниво файл) с низов аргумент като факти
// за правилата: `$app->post('/orders', PlaceOrderHandler::class)`, `Route::get('/x', ...)`.
function outsideCalls(n: Node, file: string, scope: Scope, out: Out) {
  for (const call of n.descendantsOfType(CALLS)) {
    if (!call) continue;
    const args = (call.childForFieldName('arguments')?.namedChildren ?? [])
      .filter((a) => a.type === 'argument')
      .map((a) => argValue(a.namedChildren.at(-1), scope));
    if (!args.some((a) => a.kind === 'string')) continue;
    const fn = call.childForFieldName('function');
    const object = call.childForFieldName('object') ?? call.childForFieldName('scope');
    const name = call.childForFieldName('name')?.text ?? '';
    out.annotations.push({
      kind: 'call',
      name: fn ? fn.text : `${object?.text ?? ''}${call.type === 'scoped_call_expression' ? '::' : '->'}${name}`,
      args,
      location: location(call, file),
    });
  }
}

// Низовете сред аргументите, по ред. Променлива в низа или конкатенация е `{}`: "/albums/$id" → /albums/{}
function literalStrings(args: Node | null): string[] {
  const text = (v: Node | undefined): string | undefined => {
    if (v?.type === 'string' || v?.type === 'encapsed_string')
      return v.namedChildren
        .map((c) => (c.type === 'string_content' ? c.text : c.type === 'escape_sequence' ? c.text.slice(1) : '{}'))
        .join('');
    if (v?.type === 'binary_expression' && v.childForFieldName('operator')?.text === '.') {
      const [l, r] = [text(v.childForFieldName('left') ?? undefined), text(v.childForFieldName('right') ?? undefined)];
      return l === undefined && r === undefined ? undefined : `${l ?? '{}'}${r ?? '{}'}`;
    }
    return undefined;
  };
  return (args?.namedChildren ?? []).flatMap((a) => {
    const s = text(a.namedChildren.at(-1));
    return s === undefined ? [] : [s];
  });
}

function argValue(v: Node | undefined, scope: Scope): Arg {
  if (
    (v?.type === 'string' || v?.type === 'encapsed_string') &&
    v.namedChildren.every((c) => c.type === 'string_content' || c.type === 'escape_sequence')
  )
    return {
      kind: 'string',
      value: v.namedChildren.map((c) => (c.type === 'escape_sequence' ? c.text.slice(1) : c.text)).join(''),
    };
  if (v?.type === 'class_constant_access_expression' && v.namedChildren[1]?.text.toLowerCase() === 'class')
    return { kind: 'class', id: `php:${resolveClass(v.namedChildren[0]?.text ?? '', scope)}` };
  return { kind: 'other' };
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

function readClass(n: Node, file: string, outer: Scope, out: Out): GraphNode {
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
  // class A extends B implements I; interface K extends I, J
  for (const clause of n.namedChildren) {
    const kind =
      clause.type === 'base_clause' ? 'extends' : clause.type === 'class_interface_clause' ? 'implements' : '';
    if (!kind) continue;
    for (const base of clause.namedChildren)
      out.edges.push(edge(kind, { node: node.id }, { node: `php:${resolveClass(base.text, outer)}` }));
  }
  const fields = readFields(body, members, scope, tags.includes('readonly'));
  if (fields.length > 0) out.types[node.id] = { id: node.id, name, nodeId: node.id, fields };
  const props = new Map(fields.filter((f) => f.type.kind !== 'unknown').map((f) => [f.name, f.type]));
  const methods = (body?.namedChildren ?? []).filter((c) => c.type === 'method_declaration');
  attributes(n, { node: node.id }, scope, file, out);
  methods.forEach((m, i) => attributes(m, { node: node.id, member: members[i]?.name ?? '' }, scope, file, out));
  methods.forEach((m, i) => readCalls(m, members[i] as Member, { node: node.id, scope, props, out }));
  return node;
}

// Функция извън клас е нод с един член със същото име (fixtures/README.md).
function readFunction(n: Node, file: string, outer: Scope, out: Out): GraphNode {
  const name = n.childForFieldName('name')?.text ?? '';
  const fqn = outer.namespace ? `${outer.namespace}\\${name}` : name;
  const member = readMember(n, file, outer);
  readCalls(n, member, { node: `php:${fqn}`, scope: outer, props: new Map(), out });
  return {
    id: `php:${fqn}`,
    kind: 'function',
    name,
    language: 'php',
    location: location(n, file),
    members: [member],
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

// Полетата на класа по реда в кода: декларирани свойства (`@var` е с предимство) и промотирани
// параметри на конструктора. Статичните свойства не са полета на обекта.
function readFields(body: Node | null, members: Member[], scope: Scope, readonlyClass: boolean): Field[] {
  const fields: Field[] = [];
  const add = (decl: Node, name: string, type: TypeRef, hasDefault: boolean) => {
    const f: Field = { name, type };
    if (hasDefault) f.optional = true;
    if (readonlyClass || decl.namedChildren.some((c) => c.type === 'readonly_modifier')) f.readonly = true;
    fields.push(f);
  };
  for (const decl of body?.namedChildren ?? []) {
    if (decl.type === 'property_declaration' && !decl.namedChildren.some((c) => c.type === 'static_modifier')) {
      const type = docType(docComment(decl)?.var, scope) ??
        nativeType(decl.childForFieldName('type'), scope) ?? { kind: 'unknown' };
      for (const el of decl.namedChildren.filter((c) => c.type === 'property_element'))
        add(
          decl,
          (el.childForFieldName('name')?.text ?? '').replace(/^\$/, ''),
          type,
          !!el.childForFieldName('default_value'),
        );
    }
    if (decl.type !== 'method_declaration' || decl.childForFieldName('name')?.text.toLowerCase() !== '__construct')
      continue;
    const ctor = members.find((m) => m.name.toLowerCase() === '__construct');
    for (const p of decl.childForFieldName('parameters')?.namedChildren ?? []) {
      if (p.type !== 'property_promotion_parameter') continue;
      const name = (p.childForFieldName('name')?.text ?? '').replace(/^\$/, '');
      const port = ctor?.inputs.find((i) => i.name === name);
      add(p, name, port?.type ?? { kind: 'unknown' }, !!p.childForFieldName('default_value'));
    }
  }
  return fields;
}

interface Body {
  node: string;
  scope: Scope;
  props: Map<string, TypeRef>;
  out: Out;
}

// Извикванията в тялото на метод. Локалните променливи се помнят по реда на присвояване.
function readCalls(fn: Node, member: Member, b: Body) {
  const from = { node: b.node, member: member.name };
  // извикване с низ като път (`$client->request('GET', "/albums/$id")`): engine-ът решава дали е HTTP
  const path = (n: Node, name: string) => {
    const strings = literalStrings(n.childForFieldName('arguments'));
    if (strings.some((s) => PATH_LIKE.test(s))) b.out.paths.push({ from, line: lineOf(n), name, strings });
  };
  const vars = new Map<string, Expr>(member.inputs.map((p) => [`$${p.name}`, { kind: 'type', type: p.type }]));
  const self = b.scope.self;
  const expr = (n: Node | null): Expr | undefined => {
    if (!n) return undefined;
    const obj = n.childForFieldName('object');
    const name = n.childForFieldName('name')?.text ?? '';
    switch (n.type) {
      case 'variable_name':
        return n.text === '$this' && self
          ? { kind: 'type', type: { kind: 'named', id: `php:${self}` } }
          : vars.get(n.text);
      case 'member_access_expression':
      case 'nullsafe_member_access_expression': {
        const prop = obj?.text === '$this' ? b.props.get(name) : undefined;
        if (prop) return { kind: 'type', type: prop };
        const of = expr(obj);
        return of && { kind: 'field', of, name };
      }
      case 'member_call_expression':
      case 'nullsafe_member_call_expression': {
        // $sm->get('OrderMap'): типът е в регистрацията на услугите; $container->get(X::class) е X (PSR-11)
        const only = n.childForFieldName('arguments')?.namedChildren;
        if (name === 'get' && only?.length === 1) {
          const arg = argValue(only[0]?.namedChildren[0], b.scope);
          if (arg.kind === 'string') return { kind: 'service', key: arg.value };
          if (arg.kind === 'class') return { kind: 'type', type: { kind: 'named', id: arg.id } };
        }
        const of = expr(obj);
        return of && { kind: 'result', of, name };
      }
      case 'scoped_call_expression':
        return { kind: 'result', of: { kind: 'type', type: classRef(n.childForFieldName('scope')) }, name };
      case 'object_creation_expression':
        return created(n) ? { kind: 'type', type: classRef(created(n)) } : undefined;
      case 'function_call_expression':
        return { kind: 'call', id: `php:${resolveFunction(n.childForFieldName('function')?.text ?? '', b.scope)}` };
      case 'parenthesized_expression':
        return expr(n.namedChildren[0] ?? null);
      default:
        return undefined;
    }
  };
  const classRef = (n: Node | null): TypeRef => named(n?.text ?? '', b.scope);
  const created = (n: Node) => n.namedChildren.find((c) => c.type === 'name' || c.type === 'qualified_name') ?? null;

  const visit = (n: Node) => {
    switch (n.type) {
      case 'assignment_expression': {
        const left = n.childForFieldName('left');
        const value = expr(n.childForFieldName('right'));
        if (left?.type === 'variable_name' && value) vars.set(left.text, value);
        break;
      }
      case 'foreach_statement': {
        const [iter, binding] = n.namedChildren;
        const item = binding?.type === 'pair' ? binding.namedChildren[1] : binding;
        const of = expr(iter ?? null);
        if (item?.type === 'variable_name' && of) vars.set(item.text, { kind: 'element', of });
        break;
      }
      case 'simple_parameter': {
        // параметър на closure или arrow function: fn (OrderItem $i) => ...
        const type = nativeType(n.childForFieldName('type'), b.scope);
        const name = n.childForFieldName('name')?.text;
        if (type && name) vars.set(name, { kind: 'type', type });
        break;
      }
      case 'member_call_expression':
      case 'nullsafe_member_call_expression': {
        const on = expr(n.childForFieldName('object'));
        const name = n.childForFieldName('name');
        path(n, name?.text ?? '');
        if (on) b.out.calls.push({ from, line: lineOf(name ?? n), kind: 'method', on, name: name?.text ?? '' });
        break;
      }
      case 'scoped_call_expression':
        path(n, n.childForFieldName('name')?.text ?? '');
        b.out.calls.push({
          from,
          line: lineOf(n.childForFieldName('name') ?? n),
          kind: 'method',
          on: { kind: 'type', type: classRef(n.childForFieldName('scope')) },
          name: n.childForFieldName('name')?.text ?? '',
        });
        break;
      case 'object_creation_expression': {
        const ref = created(n) && classRef(created(n));
        if (ref?.kind === 'named') b.out.calls.push({ from, line: lineOf(n), kind: 'new', id: ref.id });
        break;
      }
      case 'function_call_expression': {
        // Неквалифицирана функция в namespace: PHP търси първо в namespace-а, после глобално.
        const fn = n.childForFieldName('function') ?? n;
        path(n, fn.text.split('\\').at(-1) ?? '');
        const ids = new Set([resolveFunction(fn.text, b.scope), fn.text.includes('\\') ? '' : fn.text]);
        for (const id of ids) if (id) b.out.calls.push({ from, line: lineOf(fn), kind: 'function', id: `php:${id}` });
        break;
      }
    }
    for (const c of n.namedChildren) visit(c);
  };
  const body = fn.childForFieldName('body');
  if (body) visit(body);
}

function lineOf(n: Node): number {
  return n.startPosition.row + 1;
}

// Функциите не се резолват през `use` на класове. Без namespace остава глобалното име.
function resolveFunction(name: string, scope: Scope): string {
  if (name.startsWith('\\')) return name.slice(1);
  return scope.namespace ? `${scope.namespace}\\${name}` : name;
}
