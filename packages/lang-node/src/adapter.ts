import { posix } from 'node:path';
import {
  edge,
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
  type Port,
  type SourceFile,
  type TypeRef,
  type TypeShape,
} from '@archgraph/model';
import { withTree, type Node, type Parser } from '@archgraph/syntax';
import { typescriptParser } from './grammar.ts';

const UNKNOWN: TypeRef = { kind: 'unknown' };
const EXTENSIONS = ['.ts', '.mts', '.cts', '.js', '.mjs', '.cjs'];

interface Ctx {
  file: string;
  files: Set<string>;
  parser: Parser;
  locals: Set<string>; // имена, декларирани на ниво модул в този файл
  imports: Map<string, { module: string; name: string }>;
  edges: Edge[];
  calls: CallSite[];
  types: Record<string, TypeShape>;
  annotations: Annotation[];
}

export const nodeAdapter: LanguageAdapter = {
  language: 'node',
  extensions: EXTENSIONS,
  indexer: {
    command: 'scip-typescript',
    args: (out) => ['index', '--infer-tsconfig', '--no-progress-bar', '--output', out],
    // `--infer-tsconfig` записва `{}` в корена, а празен tsconfig.json чупи JS проекта в редактора
    leaves: ['tsconfig.json'],
  },
  async read(files: SourceFile[], all = files.map((f) => f.path)): Promise<GraphFragment> {
    const parser = await typescriptParser();
    const known = new Set(all);
    const edges: Edge[] = [];
    const calls: CallSite[] = [];
    const types: Record<string, TypeShape> = {};
    const annotations: Annotation[] = [];
    const nodes = files.flatMap((file) => {
      const ctx: Ctx = {
        file: file.path,
        files: known,
        parser,
        locals: new Set(),
        imports: new Map(),
        edges,
        calls,
        types,
        annotations,
      };
      return withTree(parser, file.text, (tree) => readModule(tree.rootNode, ctx));
    });
    return { nodes, edges, types, calls, annotations };
  },
};

function readModule(root: Node, ctx: Ctx): GraphNode[] {
  const decls: { decl: Node; outer: Node }[] = [];
  for (const stmt of root.namedChildren) {
    if (stmt.type === 'import_statement') addImports(stmt, ctx);
    const decl = stmt.type === 'export_statement' ? stmt.childForFieldName('declaration') : stmt;
    if (decl) decls.push({ decl, outer: stmt });
  }
  for (const { decl } of decls) for (const name of declaredNames(decl)) ctx.locals.add(name);
  objectFacts(root, ctx);
  return decls.flatMap(({ decl, outer }) => readDeclaration(decl, outer, ctx));
}

// Обекти в масив с поне едно низово свойство: таблици като Angular `Routes`
// (`{ path: 'login', loadComponent: () => import('./login').then((m) => m.Login), children: [...] }`).
// Кое от тях е route, решават правилата (D-012).
function objectFacts(root: Node, ctx: Ctx) {
  for (const obj of root.descendantsOfType('object')) {
    if (obj.parent?.type !== 'array') continue;
    const args = obj.namedChildren.flatMap((pair): Arg[] => {
      if (pair.type !== 'pair') return [];
      const key = pair.childForFieldName('key');
      const value = pair.childForFieldName('value');
      const name = key?.type === 'string' ? key.text.slice(1, -1) : (key?.text ?? '');
      return value ? [{ ...lazyClass(value, ctx), name }] : [];
    });
    if (!args.some((a) => a.kind === 'string')) continue;
    // обект → масив → pair (`children:`) → обект
    const outer = obj.parent?.parent?.type === 'pair' ? obj.parent.parent.parent : undefined;
    ctx.annotations.push({
      kind: 'object',
      name: '',
      args,
      ...(outer?.type === 'object' ? { parent: location(outer, ctx.file) } : {}),
      location: location(obj, ctx.file),
    });
  }
}

// `() => import('./x').then((m) => m.X)` е препратка към класа X в ./x; останалото като argValue.
function lazyClass(value: Node, ctx: Ctx): Arg {
  const m = /^\(\)\s*=>\s*import\(\s*['"]([^'"]+)['"]\s*\)\s*\.then\(\s*\(?\s*(\w+)\s*\)?\s*=>\s*\2\.(\w+)\s*\)$/s.exec(
    value.text,
  );
  if (m?.[1] && m[3]) return { kind: 'class', id: `node:${resolveModule(m[1], ctx)}#${m[3]}` };
  return argValue(value, ctx);
}

function declaredNames(decl: Node): string[] {
  if (decl.type === 'lexical_declaration' || decl.type === 'variable_declaration')
    return decl.namedChildren.flatMap((d) =>
      d.type === 'variable_declarator' ? [d.childForFieldName('name')?.text ?? ''] : [],
    );
  const name = decl.childForFieldName('name')?.text;
  return name ? [name] : [];
}

// import { A, B as C } from './x'; import D from 'y'; import * as ns from 'z';
function addImports(stmt: Node, ctx: Ctx) {
  const source = stmt.childForFieldName('source')?.text.slice(1, -1);
  const clause = stmt.namedChildren.find((c) => c.type === 'import_clause');
  if (!source || !clause) return;
  const module = resolveModule(source, ctx);
  for (const part of clause.namedChildren) {
    if (part.type === 'identifier') ctx.imports.set(part.text, { module, name: 'default' });
    else if (part.type === 'namespace_import') {
      const alias = part.namedChildren.find((c) => c.type === 'identifier')?.text;
      if (alias) ctx.imports.set(alias, { module, name: '*' });
    } else if (part.type === 'named_imports') {
      for (const spec of part.namedChildren.filter((c) => c.type === 'import_specifier')) {
        const name = spec.childForFieldName('name')?.text ?? '';
        ctx.imports.set(spec.childForFieldName('alias')?.text ?? name, { module, name });
      }
    }
  }
}

// Относителен импорт → файл от проекта (`./x.js` може да е `x.ts`). Пакет остава с името си.
function resolveModule(spec: string, ctx: Ctx): string {
  if (!spec.startsWith('.')) return spec;
  const base = posix.join(posix.dirname(ctx.file), spec);
  const stem = base.replace(/\.[cm]?[jt]s$/, '');
  const candidates = [base, ...EXTENSIONS.map((e) => stem + e), ...EXTENSIONS.map((e) => `${base}/index${e}`)];
  return candidates.find((c) => ctx.files.has(c)) ?? base;
}

function named(name: string, ctx: Ctx, args?: TypeRef[]): TypeRef {
  const [head = '', ...rest] = name.split('.');
  const imported = ctx.imports.get(head);
  let id: string;
  if (imported)
    id = `node:${imported.module}#${imported.name === '*' ? rest.join('.') : [imported.name, ...rest].join('.')}`;
  else if (ctx.locals.has(head)) id = `node:${ctx.file}#${name}`;
  else id = `node:${name}`; // глобален тип: Date, Error, Map...
  return args ? { kind: 'named', id, args } : { kind: 'named', id };
}

function location(n: Node, file: string, start: Node = n): Location {
  return { file, line: start.startPosition.row + 1, endLine: n.endPosition.row + 1 };
}

function readDeclaration(decl: Node, outer: Node, ctx: Ctx): GraphNode[] {
  const node = (kind: string, name: string, members: Member[], tags: string[] = []): GraphNode => {
    const n: GraphNode = {
      id: `node:${ctx.file}#${name}`,
      kind,
      name,
      language: 'node',
      location: location(outer, ctx.file),
      members,
    };
    if (tags.length > 0) n.tags = tags;
    return n;
  };
  const name = decl.childForFieldName('name')?.text ?? '';
  switch (decl.type) {
    case 'class_declaration':
    case 'abstract_class_declaration': {
      const body = decl.childForFieldName('body')?.namedChildren ?? [];
      const methods = body.filter((c) => c.type === 'method_definition' || c.type === 'abstract_method_signature');
      const members = methods.map((m) => readMember(m, ctx));
      const n = node('class', name, members, decl.type === 'abstract_class_declaration' ? ['abstract'] : []);
      addHeritage(decl, n.id, ctx);
      // `@Controller('orders') export class` има декоратора в export-а, иначе е в класа.
      const own = [...(outer === decl ? [] : outer.namedChildren), ...decl.namedChildren];
      annotate(own, { node: n.id }, ctx);
      methods.forEach((m, i) => annotate(precedingDecorators(m), { node: n.id, member: members[i]?.name ?? '' }, ctx));
      const props = new Map<string, Expr>(
        addFields(n, body, ctx)
          .filter((f) => f.type.kind !== 'unknown')
          .map((f) => [f.name, { kind: 'type', type: f.type }]),
      );
      // Конструкторът първи, защото `this.x = ...` в него дава типа на свойството за останалите.
      const order = methods
        .map((m, i) => i)
        .sort((a, b) => +(members[b]?.name === 'constructor') - +(members[a]?.name === 'constructor'));
      for (const i of order) readCalls(methods[i] as Node, members[i] as Member, { node: n.id, props, ctx });
      return [n];
    }
    case 'interface_declaration': {
      const members = (decl.childForFieldName('body')?.namedChildren ?? [])
        .filter((c) => c.type === 'method_signature')
        .map((m) => readMember(m, ctx));
      const n = node('interface', name, members);
      addHeritage(decl, n.id, ctx);
      addFields(n, decl.childForFieldName('body')?.namedChildren ?? [], ctx);
      return [n];
    }
    case 'enum_declaration':
      return [node('enum', name, [])];
    case 'function_declaration':
    case 'generator_function_declaration': {
      const n = node('function', name, [readMember(decl, ctx, name)]);
      readCalls(decl, n.members[0] as Member, { node: n.id, props: new Map(), ctx });
      return [n];
    }
    case 'lexical_declaration':
    case 'variable_declaration':
      // const handler = async (req, res) => {...} е функция като всяка друга (Express).
      return decl.namedChildren.flatMap((d) => {
        const value = d.childForFieldName('value');
        const fnName = d.childForFieldName('name')?.text ?? '';
        if (d.type !== 'variable_declarator' || !value || !/^(arrow_function|function_expression)$/.test(value.type))
          return [];
        const n = node('function', fnName, [readMember(value, ctx, fnName, location(outer, ctx.file))]);
        readCalls(value, n.members[0] as Member, { node: n.id, props: new Map(), ctx });
        return [n];
      });
    default:
      return [];
  }
}

// class A extends B implements I, J<X>; interface K extends I. `extends mixin(B)` е израз без име и се пропуска.
function addHeritage(decl: Node, id: string, ctx: Ctx) {
  const heritage = decl.namedChildren.find((c) => c.type === 'class_heritage')?.namedChildren ?? [];
  const clauses = [...heritage, ...decl.namedChildren.filter((c) => c.type === 'extends_type_clause')];
  for (const clause of clauses) {
    const kind = clause.type === 'implements_clause' ? 'implements' : 'extends';
    const bases = clause.type === 'extends_clause' ? [clause.childForFieldName('value')] : clause.namedChildren;
    for (const base of bases) {
      const head = base?.type === 'generic_type' ? base.childForFieldName('name') : base;
      if (!head || !/^(identifier|type_identifier|member_expression|nested_type_identifier)$/.test(head.type)) continue;
      const to = named(head.text, ctx);
      if (to.kind === 'named') ctx.edges.push(edge(kind, { node: id }, { node: to.id }));
    }
  }
}

function readMember(n: Node, ctx: Ctx, name?: string, loc?: Location): Member {
  const memberName = name ?? n.childForFieldName('name')?.text ?? '';
  const keywords = new Set(n.children.filter((c) => !c.isNamed).map((c) => c.type));
  const doc = jsDoc(n, ctx);
  const params =
    n.childForFieldName('parameters')?.namedChildren ??
    (n.childForFieldName('parameter') ? [n.childForFieldName('parameter') as Node] : []);
  const member: Member = {
    name: memberName,
    visibility: visibility(n),
    inputs: params
      .filter((p) => p.type.endsWith('_parameter') || p.type === 'identifier')
      .map((p) => readPort(p, ctx, doc)),
    location: loc ?? location(n, ctx.file, firstDecorator(n)),
  };
  if (keywords.has('static')) member.static = true;
  let isAsync = keywords.has('async');
  if (memberName !== 'constructor') {
    const annotation = n.childForFieldName('return_type')?.namedChildren[0];
    let type = annotation ? typeRef(annotation, ctx) : doc?.returns;
    // Promise<T> е async с изход T (fixtures/README.md).
    if (type?.kind === 'named' && type.id === 'node:Promise') {
      isAsync = true;
      type = type.args?.[0] ?? UNKNOWN;
    }
    if (!isVoid(type)) member.output = { name: 'return', type: type ?? UNKNOWN };
  }
  if (isAsync) member.async = true;
  return member;
}

function isVoid(t: TypeRef | undefined): boolean {
  return t?.kind === 'primitive' && (t.name === 'void' || t.name === 'undefined');
}

function visibility(n: Node): Member['visibility'] {
  const mod = n.namedChildren.find((c) => c.type === 'accessibility_modifier')?.text;
  if (mod === 'private' || n.childForFieldName('name')?.type === 'private_property_identifier') return 'private';
  return mod === 'protected' ? 'protected' : 'public';
}

function precedingDecorators(n: Node): Node[] {
  const result: Node[] = [];
  for (let prev = n.previousNamedSibling; prev?.type === 'decorator'; prev = prev.previousNamedSibling)
    result.push(prev);
  return result.reverse();
}

// Декораторите като факти за правилата: `@Get(':id')` → име `Get` и аргументите.
function annotate(nodes: Node[], on: { node: string; member?: string }, ctx: Ctx) {
  for (const d of nodes) {
    if (d.type !== 'decorator') continue;
    const e = d.namedChildren[0];
    const call = e?.type === 'call_expression' ? e : undefined;
    ctx.annotations.push({
      kind: 'decorator',
      name: (call ? call.childForFieldName('function') : e)?.text ?? '',
      args: (call?.childForFieldName('arguments')?.namedChildren ?? [])
        .filter((a) => a.type !== 'comment')
        .map((a) => argValue(a, ctx)),
      on,
      location: location(d, ctx.file),
    });
  }
}

function argValue(a: Node, ctx: Ctx): Arg {
  if (a.type === 'string') return { kind: 'string', value: a.namedChildren.map((c) => c.text).join('') };
  if (a.type === 'template_string' && !a.namedChildren.some((c) => c.type === 'template_substitution'))
    return { kind: 'string', value: a.text.slice(1, -1) };
  if (a.type === 'identifier') {
    const ref = named(a.text, ctx);
    if (ref.kind === 'named') return { kind: 'class', id: ref.id };
  }
  return { kind: 'other' };
}

// Декораторите на метод са съседи преди него в тялото на класа.
function firstDecorator(n: Node): Node {
  let first = n;
  for (let prev = n.previousNamedSibling; prev?.type === 'decorator'; prev = prev.previousNamedSibling) first = prev;
  return first;
}

function readPort(p: Node, ctx: Ctx, doc: JsDoc | undefined): Port {
  const pattern = p.type === 'identifier' ? p : p.childForFieldName('pattern');
  const rest = pattern?.type === 'rest_pattern';
  const name = (rest ? pattern.namedChildren[0]?.text : pattern?.text) ?? '';
  const annotation = p.childForFieldName('type')?.namedChildren[0];
  const fromDoc = doc?.params.get(name);
  const port: Port = { name, type: annotation ? typeRef(annotation, ctx) : (fromDoc?.type ?? UNKNOWN) };
  const value = p.childForFieldName('value');
  if (p.type === 'optional_parameter' || value || fromDoc?.optional) port.optional = true;
  if (value) port.default = value.text;
  if (rest) port.variadic = true;
  return port;
}

function typeRef(t: Node, ctx: Ctx): TypeRef {
  switch (t.type) {
    case 'predefined_type':
      return { kind: 'primitive', name: t.text };
    case 'literal_type':
      return { kind: 'primitive', name: t.text };
    case 'type_identifier':
    case 'nested_type_identifier':
      return named(t.text, ctx);
    case 'parenthesized_type':
      return t.namedChildren[0] ? typeRef(t.namedChildren[0], ctx) : UNKNOWN;
    case 'readonly_type':
      return t.namedChildren[0] ? typeRef(t.namedChildren[0], ctx) : UNKNOWN;
    case 'array_type':
      return { kind: 'array', of: t.namedChildren[0] ? typeRef(t.namedChildren[0], ctx) : UNKNOWN };
    case 'union_type':
      return { kind: 'union', of: flattenUnion(t).map((c) => typeRef(c, ctx)) };
    case 'generic_type': {
      const name = t.childForFieldName('name')?.text ?? '';
      const args = (t.childForFieldName('type_arguments')?.namedChildren ?? []).map((a) => typeRef(a, ctx));
      if ((name === 'Array' || name === 'ReadonlyArray') && args[0]) return { kind: 'array', of: args[0] };
      if (name === 'Record' && args[0] && args[1]) return { kind: 'map', key: args[0], value: args[1] };
      return named(name, ctx, args);
    }
    case 'member_expression': {
      // JSDoc: import('socket.io').Server
      const m = /^import\(\s*['"](.+?)['"]\s*\)\.([\w$.]+)$/.exec(t.text);
      return m?.[1] && m[2]
        ? { kind: 'named', id: `node:${resolveModule(m[1], ctx)}#${m[2]}` }
        : { kind: 'unknown', hint: t.text };
    }
    case 'object_type':
      return {
        kind: 'shape',
        fields: t.namedChildren.filter((c) => c.type === 'property_signature').map((c) => field(c, ctx)),
      };
    default:
      return { kind: 'unknown', hint: t.text };
  }
}

function flattenUnion(t: Node): Node[] {
  return t.namedChildren.flatMap((c) => (c.type === 'union_type' ? flattenUnion(c) : [c]));
}

function field(p: Node, ctx: Ctx): Field {
  const type = p.childForFieldName('type')?.namedChildren[0];
  const f: Field = { name: p.childForFieldName('name')?.text ?? '', type: type ? typeRef(type, ctx) : UNKNOWN };
  if (p.children.some((c) => c.type === '?')) f.optional = true;
  return f;
}

interface JsDoc {
  params: Map<string, { type: TypeRef; optional: boolean }>;
  returns?: TypeRef;
}

// JSDoc за чист JS: @param {T} name, @param {T} [name], @param {T=} name, @returns {T}.
// Типът е TypeScript синтаксис, затова се парсва със същата граматика.
function jsDoc(n: Node, ctx: Ctx): JsDoc | undefined {
  let prev = firstDecorator(n).previousNamedSibling;
  if (n.parent?.type === 'export_statement' || n.parent?.type === 'variable_declarator')
    prev = exportOf(n).previousNamedSibling;
  if (prev?.type !== 'comment' || !prev.text.startsWith('/**')) return undefined;
  const doc: JsDoc = { params: new Map() };
  for (const m of prev.text.matchAll(/@(param|returns?)\s+\{/g)) {
    const open = (m.index ?? 0) + m[0].length;
    const close = matchingBrace(prev.text, open);
    const raw = prev.text
      .slice(open, close)
      .replace(/\s*\n\s*\*?\s*/g, ' ')
      .trim();
    const [, bracket, name = ''] = /^\s*(\[?)([\w$.]*)/.exec(prev.text.slice(close + 1)) ?? [];
    const tag = m[1];
    const optional = bracket === '[' || raw.endsWith('=');
    const type = docType(raw.replace(/=$/, ''), ctx);
    if (tag === 'param') doc.params.set(name, { type, optional });
    else doc.returns = type;
  }
  return doc;
}

// {Promise<{ ok: boolean }>} – типът може да съдържа вложени скоби.
function matchingBrace(text: string, from: number): number {
  let depth = 1;
  for (let i = from; i < text.length; i++) {
    if (text[i] === '{') depth++;
    else if (text[i] === '}' && --depth === 0) return i;
  }
  return text.length;
}

function exportOf(n: Node): Node {
  let outer = n;
  while (outer.parent && outer.parent.type !== 'program') outer = outer.parent;
  return outer;
}

function docType(text: string, ctx: Ctx): TypeRef {
  if (text === '*') return { kind: 'primitive', name: 'any' };
  if (text.startsWith('?'))
    return { kind: 'union', of: [docType(text.slice(1), ctx), { kind: 'primitive', name: 'null' }] };
  // import('./x').Row[] граматиката не го чете като масив, затова [] се маха тук.
  if (text.startsWith('import(') && text.endsWith('[]')) return { kind: 'array', of: docType(text.slice(0, -2), ctx) };
  return withTree(ctx.parser, `let __t: ${text};`, (tree) => {
    const annotation = tree.rootNode.descendantsOfType('type_annotation')[0]?.namedChildren[0];
    return annotation && !tree.rootNode.hasError ? typeRef(annotation, ctx) : { kind: 'unknown', hint: text };
  });
}

// Полетата по реда в кода: полета на класа, свойства на интерфейса и параметри на конструктора
// с `private`/`public`/`readonly`. Статичните не са полета на обекта. Записват се в `types`.
function addFields(n: GraphNode, body: Node[], ctx: Ctx): Field[] {
  const fields: Field[] = [];
  const add = (decl: Node, name: string, type: TypeRef, optional: boolean) => {
    const f: Field = { name, type };
    if (optional) f.optional = true;
    if (decl.children.some((c) => c.type === 'readonly')) f.readonly = true;
    fields.push(f);
  };
  for (const c of body) {
    if (c.type === 'public_field_definition' || c.type === 'property_signature') {
      if (c.children.some((m) => m.type === 'static')) continue;
      const annotation = c.childForFieldName('type')?.namedChildren[0];
      const value = c.childForFieldName('value');
      const type = annotation ? typeRef(annotation, ctx) : (initializerType(value, ctx) ?? UNKNOWN);
      add(c, c.childForFieldName('name')?.text ?? '', type, !!value || c.children.some((m) => m.type === '?'));
    }
    if (c.type !== 'method_definition' || c.childForFieldName('name')?.text !== 'constructor') continue;
    for (const p of c.childForFieldName('parameters')?.namedChildren ?? []) {
      const isProperty =
        p.namedChildren.some((m) => m.type === 'accessibility_modifier') ||
        p.children.some((m) => m.type === 'readonly');
      if (!isProperty) continue;
      const annotation = p.childForFieldName('type')?.namedChildren[0];
      add(
        p,
        p.childForFieldName('pattern')?.text ?? '',
        annotation ? typeRef(annotation, ctx) : UNKNOWN,
        p.type === 'optional_parameter' || !!p.childForFieldName('value'),
      );
    }
  }
  if (fields.length > 0) ctx.types[n.id] = { id: n.id, name: n.name, nodeId: n.id, fields };
  return fields;
}

function lineOf(n: Node): number {
  return n.startPosition.row + 1;
}

// Поле без анотация: `x = new X()` или Angular `x = inject(X)`, което връща X.
function initializerType(value: Node | null, ctx: Ctx): TypeRef | undefined {
  if (value?.type === 'new_expression') return named(value.childForFieldName('constructor')?.text ?? '', ctx);
  const arg = value?.childForFieldName('arguments')?.namedChildren[0];
  if (
    value?.type === 'call_expression' &&
    value.childForFieldName('function')?.text === 'inject' &&
    arg?.type === 'identifier'
  )
    return named(arg.text, ctx);
  return undefined;
}

const ARRAY_CALLBACKS = new Set([
  'map',
  'flatMap',
  'filter',
  'find',
  'findLast',
  'some',
  'every',
  'forEach',
  'reduce',
  'reduceRight',
  'sort',
  'findIndex',
]);

interface Body {
  node: string;
  props: Map<string, Expr>;
  ctx: Ctx;
}

// Извикванията в тялото на функция или метод. Локалните променливи се помнят по реда на присвояване.
function readCalls(fn: Node, member: Member, b: Body) {
  const { ctx } = b;
  const from = { node: b.node, member: member.name };
  const vars = new Map<string, Expr>(member.inputs.map((p) => [p.name, { kind: 'type', type: p.type }]));
  const self: Expr = { kind: 'type', type: { kind: 'named', id: b.node } };
  const expr = (n: Node | null | undefined): Expr | undefined => {
    if (!n) return undefined;
    switch (n.type) {
      case 'this':
        return self;
      case 'identifier':
        // Не е локална променлива: клас при статично извикване (`Order.create`).
        return vars.get(n.text) ?? { kind: 'type', type: named(n.text, ctx) };
      case 'member_expression': {
        const obj = n.childForFieldName('object');
        const name = n.childForFieldName('property')?.text ?? '';
        if (obj?.type === 'this' && b.props.has(name)) return b.props.get(name);
        const of = expr(obj);
        return of && { kind: 'field', of, name };
      }
      case 'call_expression': {
        const callee = n.childForFieldName('function');
        if (callee?.type === 'identifier' && !vars.has(callee.text)) {
          const ref = named(callee.text, ctx);
          return ref.kind === 'named' ? { kind: 'call', id: ref.id } : undefined;
        }
        if (callee?.type !== 'member_expression') return undefined;
        const of = expr(callee.childForFieldName('object'));
        return of && { kind: 'result', of, name: callee.childForFieldName('property')?.text ?? '' };
      }
      case 'new_expression':
        return { kind: 'type', type: named(n.childForFieldName('constructor')?.text ?? '', ctx) };
      case 'await_expression':
      case 'non_null_expression':
      case 'parenthesized_expression':
        return expr(n.namedChildren[0]);
      case 'as_expression':
      case 'satisfies_expression': {
        const type = n.namedChildren[1];
        return type ? { kind: 'type', type: typeRef(type, ctx) } : undefined;
      }
      default:
        return undefined;
    }
  };

  const visit = (n: Node) => {
    switch (n.type) {
      case 'variable_declarator': {
        const name = n.childForFieldName('name');
        const annotation = n.childForFieldName('type')?.namedChildren[0];
        const value = annotation
          ? { kind: 'type' as const, type: typeRef(annotation, ctx) }
          : expr(n.childForFieldName('value'));
        if (name?.type === 'identifier' && value) vars.set(name.text, value);
        break;
      }
      case 'assignment_expression': {
        const left = n.childForFieldName('left');
        const value = expr(n.childForFieldName('right'));
        if (!value) break;
        if (left?.type === 'identifier') vars.set(left.text, value);
        else if (left?.type === 'member_expression' && left.childForFieldName('object')?.type === 'this') {
          const name = left.childForFieldName('property')?.text ?? '';
          if (!b.props.has(name)) b.props.set(name, value);
        }
        break;
      }
      case 'for_in_statement': {
        const left = n.childForFieldName('left');
        const of = expr(n.childForFieldName('right'));
        if (left?.type === 'identifier' && of && n.children.some((c) => c.type === 'of'))
          vars.set(left.text, { kind: 'element', of });
        break;
      }
      case 'required_parameter':
      case 'optional_parameter': {
        const type = n.childForFieldName('type')?.namedChildren[0];
        const name = n.childForFieldName('pattern');
        if (type && name?.type === 'identifier') vars.set(name.text, { kind: 'type', type: typeRef(type, ctx) });
        break;
      }
      case 'call_expression': {
        const callee = n.childForFieldName('function');
        if (callee?.type === 'identifier' && !vars.has(callee.text)) {
          const ref = named(callee.text, ctx);
          if (ref.kind === 'named') ctx.calls.push({ from, line: lineOf(callee), kind: 'function', id: ref.id });
        } else if (callee?.type === 'member_expression') {
          const on = expr(callee.childForFieldName('object'));
          const property = callee.childForFieldName('property') ?? callee;
          const name = property.text;
          if (on) ctx.calls.push({ from, line: lineOf(property), kind: 'method', on, name });
          // items.reduce((sum, item) => ...): параметърът на callback-а е елемент на масива.
          const callback = n.childForFieldName('arguments')?.namedChildren[0];
          if (
            on &&
            ARRAY_CALLBACKS.has(name) &&
            callback &&
            /^(arrow_function|function_expression)$/.test(callback.type)
          ) {
            const params = callback.childForFieldName('parameters')?.namedChildren ?? [
              callback.childForFieldName('parameter'),
            ];
            const item = params[name.startsWith('reduce') ? 1 : 0];
            const id = item?.type === 'identifier' ? item : item?.childForFieldName('pattern');
            if (id?.type === 'identifier' && !item?.childForFieldName('type'))
              vars.set(id.text, { kind: 'element', of: on });
          }
        }
        break;
      }
      case 'new_expression': {
        const ref = named(n.childForFieldName('constructor')?.text ?? '', ctx);
        if (ref.kind === 'named') ctx.calls.push({ from, line: lineOf(n), kind: 'new', id: ref.id });
        break;
      }
    }
    for (const c of n.namedChildren) visit(c);
  };
  const body = fn.childForFieldName('body');
  if (body) visit(body);
}
