import { posix } from 'node:path';
import type {
  Field,
  GraphFragment,
  LanguageAdapter,
  Location,
  Member,
  Node as GraphNode,
  Port,
  SourceFile,
  TypeRef,
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
}

export const nodeAdapter: LanguageAdapter = {
  language: 'node',
  extensions: EXTENSIONS,
  async read(files: SourceFile[]): Promise<GraphFragment> {
    const parser = await typescriptParser();
    const known = new Set(files.map((f) => f.path));
    const nodes = files.flatMap((file) => {
      const ctx: Ctx = { file: file.path, files: known, parser, locals: new Set(), imports: new Map() };
      return withTree(parser, file.text, (tree) => readModule(tree.rootNode, ctx));
    });
    return { nodes, edges: [], types: {} };
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
  return decls.flatMap(({ decl, outer }) => readDeclaration(decl, outer, ctx));
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
      const members = (decl.childForFieldName('body')?.namedChildren ?? [])
        .filter((c) => c.type === 'method_definition' || c.type === 'abstract_method_signature')
        .map((m) => readMember(m, ctx));
      return [node('class', name, members, decl.type === 'abstract_class_declaration' ? ['abstract'] : [])];
    }
    case 'interface_declaration': {
      const members = (decl.childForFieldName('body')?.namedChildren ?? [])
        .filter((c) => c.type === 'method_signature')
        .map((m) => readMember(m, ctx));
      return [node('interface', name, members)];
    }
    case 'enum_declaration':
      return [node('enum', name, [])];
    case 'function_declaration':
    case 'generator_function_declaration':
      return [node('function', name, [readMember(decl, ctx, name)])];
    case 'lexical_declaration':
    case 'variable_declaration':
      // const handler = async (req, res) => {...} е функция като всяка друга (Express).
      return decl.namedChildren.flatMap((d) => {
        const value = d.childForFieldName('value');
        const fnName = d.childForFieldName('name')?.text ?? '';
        if (d.type !== 'variable_declarator' || !value || !/^(arrow_function|function_expression)$/.test(value.type))
          return [];
        return [node('function', fnName, [readMember(value, ctx, fnName, location(outer, ctx.file))])];
      });
    default:
      return [];
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
