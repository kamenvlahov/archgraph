import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import {
  edge,
  PATH_LIKE,
  type CallSite,
  type Edge,
  type Expr,
  type Field,
  type GraphFragment,
  type LanguageAdapter,
  type Location,
  type Member,
  type Node as GraphNode,
  type PathCall,
  type Port,
  type SourceFile,
  type TypeRef,
  type TypeShape,
} from '@archgraph/model';
import { withTree, type Node } from '@archgraph/syntax';
import { goParser } from './grammar.ts';

const PRIMITIVES = new Set([
  'bool',
  'string',
  'int',
  'int8',
  'int16',
  'int32',
  'int64',
  'uint',
  'uint8',
  'uint16',
  'uint32',
  'uint64',
  'uintptr',
  'byte',
  'rune',
  'float32',
  'float64',
  'complex64',
  'complex128',
  'error',
  'any',
]);
const BUILTINS = new Set([
  'append',
  'cap',
  'clear',
  'close',
  'complex',
  'copy',
  'delete',
  'imag',
  'len',
  'make',
  'max',
  'min',
  'new',
  'panic',
  'print',
  'println',
  'real',
  'recover',
]);
// `len(x)`, `float64(x)`: вградени функции и преобразувания, не извиквания
const isBuiltin = (name: string) => BUILTINS.has(name) || PRIMITIVES.has(name);
const ERROR: TypeRef = { kind: 'primitive', name: 'error' };
const UNKNOWN: TypeRef = { kind: 'unknown' };

interface Ctx {
  pkg: string; // import пътят на пакета: модулът от go.mod + папката
  file: string;
  imports: Map<string, string>; // локално име → import път
  generics: Set<string>; // параметрите на типа в текущата декларация
  edges: Edge[];
  calls: CallSite[];
  paths: PathCall[];
  types: Record<string, TypeShape>;
}

export const goAdapter: LanguageAdapter = {
  language: 'go',
  extensions: ['.go'],
  async read(files: SourceFile[], _all?: string[], root?: string): Promise<GraphFragment> {
    const parser = await goParser();
    const modules = new Map<string, Module | undefined>();
    const edges: Edge[] = [];
    const calls: CallSite[] = [];
    const paths: PathCall[] = [];
    const types: Record<string, TypeShape> = {};
    const methods: { node: string; member: Member }[] = [];
    let read = 0;
    const nodes = files.flatMap((file) => {
      if (outside(file.path, root, modules)) return [];
      read++;
      const ctx: Ctx = {
        pkg: packagePath(file.path, root, modules),
        file: file.path,
        imports: new Map(),
        generics: new Set(),
        edges,
        calls,
        paths,
        types,
      };
      return withTree(parser, file.text, (tree) => readFile(tree.rootNode, ctx, methods));
    });
    return { nodes, edges, types, calls, paths, methods, ...(read === 0 && files.length > 0 ? { ignored: true } : {}) };
  },
};

// Каквото пропуска и самият go инструмент: тестовете, testdata/ и вложен модул (папка със свой
// go.mod вътре в друг модул, напр. tools/). Fenix пази в testdata/ модули, които нарушават пръстените.
export function outside(file: string, root: string | undefined, cache = new Map<string, Module | undefined>()) {
  if (file.endsWith('_test.go') || file.split('/').includes('testdata')) return true;
  if (!root) return false;
  const own = findModule(root, folder(file), cache);
  return own !== undefined && own.dir !== '' && findModule(root, folder(own.dir), cache) !== undefined;
}

const folder = (path: string) => (dirname(path) === '.' ? '' : dirname(path));

interface Module {
  dir: string; // относително от корена, '' за корена
  path: string; // `module` от go.mod
}

// internal/order/service.go с go.mod `module shop` в корена → shop/internal/order.
// Без go.mod (или без корен) пакетът е папката.
export function packagePath(file: string, root: string | undefined, cache = new Map<string, Module | undefined>()) {
  const dir = folder(file);
  const module = root ? findModule(root, dir, cache) : undefined;
  if (!module) return dir || '.';
  const rest = module.dir ? dir.slice(module.dir.length + 1) : dir;
  return rest ? `${module.path}/${rest}` : module.path;
}

function findModule(root: string, dir: string, cache: Map<string, Module | undefined>): Module | undefined {
  if (cache.has(dir)) return cache.get(dir);
  const mod = join(root, dir, 'go.mod');
  const name = existsSync(mod) ? /^module\s+(\S+)/m.exec(readFileSync(mod, 'utf8'))?.[1] : undefined;
  const found = name ? { dir, path: name } : dir ? findModule(root, folder(dir), cache) : undefined;
  cache.set(dir, found);
  return found;
}

function location(n: Node, file: string): Location {
  return { file, line: n.startPosition.row + 1, endLine: n.endPosition.row + 1 };
}

function lineOf(n: Node): number {
  return n.startPosition.row + 1;
}

const nodeId = (pkg: string, name: string) => `go:${pkg}.${name}`;

function readFile(root: Node, ctx: Ctx, methods: { node: string; member: Member }[]): GraphNode[] {
  for (const decl of root.namedChildren.filter((c) => c.type === 'import_declaration'))
    for (const spec of decl.descendantsOfType('import_spec')) {
      const path = stringValue(spec.childForFieldName('path')) ?? '';
      const alias = spec.childForFieldName('name')?.text;
      if (alias === '_' || alias === '.') continue;
      ctx.imports.set(alias ?? path.split('/').at(-1) ?? path, path);
    }

  // Пакетът е архитектурната единица на Go (пръстените, go-arch-lint), затова е нод, дори да е празен.
  // Всеки файл го дава; engine-ът слива еднаквите `module` нодове в един (D-015).
  const clause = root.namedChildren.find((c) => c.type === 'package_clause');
  const nodes: GraphNode[] = [];
  if (clause)
    nodes.push({
      id: `go:${ctx.pkg}`,
      kind: 'module',
      name: clause.namedChildren[0]?.text ?? '',
      language: 'go',
      location: location(clause, ctx.file),
      members: [],
    });
  for (const decl of root.namedChildren) {
    if (decl.type === 'type_declaration') {
      const specs = decl.namedChildren.filter((c) => c.type === 'type_spec');
      for (const spec of specs) nodes.push(readType(spec, specs.length === 1 ? decl : spec, ctx));
    } else if (decl.type === 'function_declaration') {
      nodes.push(readFunction(decl, ctx));
    }
  }
  // Методите са отделно от типа; ако типът е в друг файл на пакета, engine-ът ги слива в нода му.
  const byId = new Map(nodes.map((n) => [n.id, n]));
  for (const decl of root.namedChildren.filter((c) => c.type === 'method_declaration')) {
    const receiver = decl.childForFieldName('receiver')?.namedChildren[0];
    const type = receiver && receiverType(receiver.childForFieldName('type'));
    if (!type) continue;
    const owner = nodeId(ctx.pkg, type.name);
    const scoped = { ...ctx, generics: new Set(type.params) };
    const member = readMember(decl, scoped);
    const self = receiver.childForFieldName('name')?.text;
    readCalls(decl, member, owner, scoped, self);
    const node = byId.get(owner);
    if (node) node.members.push(member);
    else methods.push({ node: owner, member });
  }
  return nodes;
}

// `(s *Service)`, `(r Repo[T])` → Service / Repo с параметрите на типа
function receiverType(t: Node | null): { name: string; params: string[] } | undefined {
  if (!t) return undefined;
  if (t.type === 'pointer_type' || t.type === 'parenthesized_type') return receiverType(t.namedChildren[0] ?? null);
  if (t.type === 'type_identifier') return { name: t.text, params: [] };
  if (t.type === 'generic_type') {
    const name = t.childForFieldName('type')?.text;
    const args = t.childForFieldName('type_arguments')?.namedChildren.map((a) => a.text) ?? [];
    return name ? { name, params: args } : undefined;
  }
  return undefined;
}

function typeParams(n: Node): string[] {
  return (n.childForFieldName('type_parameters')?.namedChildren ?? []).flatMap((d) =>
    d.childrenForFieldName('name').map((x) => x.text),
  );
}

function readType(spec: Node, decl: Node, ctx: Ctx): GraphNode {
  const name = spec.childForFieldName('name')?.text ?? '';
  const id = nodeId(ctx.pkg, name);
  const scoped = { ...ctx, generics: new Set(typeParams(spec)) };
  const type = spec.childForFieldName('type');
  const node: GraphNode = {
    id,
    kind: 'class',
    name,
    language: 'go',
    location: location(decl, ctx.file),
    members: [],
  };
  if (type?.type === 'interface_type') {
    // В Go имплементацията не се декларира: кой я спазва, се извежда по методите (D-015).
    node.kind = 'interface';
    node.tags = ['structural'];
    for (const el of type.namedChildren) {
      if (el.type === 'method_elem') node.members.push(readMember(el, scoped));
      else if (el.type === 'type_elem')
        for (const t of el.namedChildren) {
          const to = typeRef(t, scoped);
          if (to.kind === 'named') ctx.edges.push(edge('extends', { node: id }, { node: to.id }));
        }
    }
  } else if (type?.type === 'struct_type') {
    const fields: Field[] = [];
    const list = type.namedChildren.find((c) => c.type === 'field_declaration_list');
    for (const f of list?.namedChildren.filter((c) => c.type === 'field_declaration') ?? []) {
      const t = f.childForFieldName('type');
      const names = f.childrenForFieldName('name');
      if (!t) continue;
      // Вграденият тип е наследяване: методите и полетата му са на външния.
      if (names.length === 0) {
        const to = typeRef(t, scoped);
        if (to.kind === 'named') ctx.edges.push(edge('extends', { node: id }, { node: to.id }));
        continue;
      }
      for (const n of names) fields.push({ name: n.text, type: typeRef(t, scoped) });
    }
    if (fields.length > 0) ctx.types[id] = { id, name, nodeId: id, fields };
  }
  return node;
}

function readFunction(decl: Node, ctx: Ctx): GraphNode {
  const name = decl.childForFieldName('name')?.text ?? '';
  const id = nodeId(ctx.pkg, name);
  const scoped = { ...ctx, generics: new Set(typeParams(decl)) };
  const member = readMember(decl, scoped);
  // `NewService(repo Repository) *Service` е конструкторът на Go: параметрите му са зависимостите.
  if (/^[Nn]ew[A-Z_]?/.test(name) && returnsOwn(member, ctx.pkg))
    for (const port of member.inputs)
      for (const from of namedIds(port.type))
        ctx.edges.push(edge('injects', { node: from }, { node: id, member: name, port: port.name }));
  readCalls(decl, member, id, scoped);
  return { id, kind: 'function', name, language: 'go', location: location(decl, ctx.file), members: [member] };
}

function returnsOwn(m: Member, pkg: string): boolean {
  return m.output?.type.kind === 'named' && m.output.type.id.startsWith(`go:${pkg}.`);
}

function namedIds(t: TypeRef): string[] {
  if (t.kind === 'named') return [t.id];
  if (t.kind === 'union') return t.of.flatMap(namedIds);
  return [];
}

function readMember(fn: Node, ctx: Ctx): Member {
  const name = fn.childForFieldName('name')?.text ?? '';
  const member: Member = {
    name,
    visibility: /^\p{Lu}/u.test(name) ? 'public' : 'private',
    inputs: params(fn.childForFieldName('parameters'), ctx),
    location: location(fn, ctx.file),
  };
  const result = fn.childForFieldName('result');
  if (result) {
    // `(T, error)`: изходът е T, а грешката е начинът на Go да каже какво хвърля.
    const outs =
      result.type === 'parameter_list' ? params(result, ctx) : [{ name: 'return', type: typeRef(result, ctx) }];
    const last = outs.at(-1);
    const fails = last?.type.kind === 'primitive' && last.type.name === 'error';
    const values = fails ? outs.slice(0, -1) : outs;
    if (fails) member.throws = [ERROR];
    if (values.length === 1 && values[0]) member.output = { name: 'return', type: values[0].type };
    else if (values.length > 1)
      member.output = {
        name: 'return',
        type: {
          kind: 'shape',
          fields: values.map((v, i) => ({ name: v.name.startsWith('_') ? String(i) : v.name, type: v.type })),
        },
      };
  }
  return member;
}

// `a, b int`, `...Item`, `func(int, string)`: всяко име е порт; безименните са `_0`, `_1`…
function params(list: Node | null, ctx: Ctx): Port[] {
  const ports: Port[] = [];
  for (const p of list?.namedChildren ?? []) {
    if (p.type !== 'parameter_declaration' && p.type !== 'variadic_parameter_declaration') continue;
    const t = p.childForFieldName('type');
    const type = t ? typeRef(t, ctx) : UNKNOWN;
    const names = p.childrenForFieldName('name');
    for (const n of names.length ? names.map((x) => x.text) : [`_${ports.length}`]) {
      const port: Port = { name: n, type };
      if (p.type === 'variadic_parameter_declaration') port.variadic = true;
      ports.push(port);
    }
  }
  return ports;
}

function named(name: string, ctx: Ctx, args?: TypeRef[]): TypeRef {
  const id = nodeId(ctx.pkg, name);
  return args?.length ? { kind: 'named', id, args } : { kind: 'named', id };
}

// Указателят е същият тип: `*Order` и `Order` водят към един нод.
function typeRef(t: Node, ctx: Ctx): TypeRef {
  switch (t.type) {
    case 'type_identifier':
      if (ctx.generics.has(t.text)) return { kind: 'primitive', name: t.text };
      if (PRIMITIVES.has(t.text)) return { kind: 'primitive', name: t.text };
      return named(t.text, ctx);
    case 'qualified_type': {
      const pkg = t.childForFieldName('package')?.text ?? '';
      const name = t.childForFieldName('name')?.text ?? '';
      return { kind: 'named', id: `go:${ctx.imports.get(pkg) ?? pkg}.${name}` };
    }
    case 'pointer_type':
    case 'parenthesized_type':
      return t.namedChildren[0] ? typeRef(t.namedChildren[0], ctx) : UNKNOWN;
    case 'slice_type':
    case 'array_type': {
      const of = t.childForFieldName('element');
      return { kind: 'array', of: of ? typeRef(of, ctx) : UNKNOWN };
    }
    case 'map_type': {
      const key = t.childForFieldName('key');
      const value = t.childForFieldName('value');
      return { kind: 'map', key: key ? typeRef(key, ctx) : UNKNOWN, value: value ? typeRef(value, ctx) : UNKNOWN };
    }
    case 'generic_type': {
      const head = t.childForFieldName('type');
      const args = (t.childForFieldName('type_arguments')?.namedChildren ?? []).map((a) =>
        typeRef(a.type === 'type_elem' ? (a.namedChildren[0] ?? a) : a, ctx),
      );
      const base = head ? typeRef(head, ctx) : UNKNOWN;
      return base.kind === 'named' ? { ...base, args } : base;
    }
    case 'interface_type':
      return t.namedChildren.length === 0 ? { kind: 'primitive', name: 'any' } : { kind: 'unknown', hint: t.text };
    case 'struct_type':
      return {
        kind: 'shape',
        fields: t.descendantsOfType('field_declaration').flatMap((f) =>
          f.childrenForFieldName('name').map((n) => {
            const ft = f.childForFieldName('type');
            return { name: n.text, type: ft ? typeRef(ft, ctx) : UNKNOWN };
          }),
        ),
      };
    default:
      return { kind: 'unknown', hint: t.text };
  }
}

function stringValue(n: Node | null | undefined): string | undefined {
  if (n?.type !== 'interpreted_string_literal' && n?.type !== 'raw_string_literal') return undefined;
  return n.namedChildren
    .map((c) => (c.type.endsWith('_content') ? c.text : c.type === 'escape_sequence' ? c.text : ''))
    .join('');
}

// Извикванията в тяло на функция или метод, включително в анонимните функции в него.
function readCalls(fn: Node, member: Member, node: string, ctx: Ctx, self?: string) {
  const from = { node, member: member.name };
  const vars = new Map<string, Expr>(
    member.inputs.map((p): [string, Expr] => [p.name, { kind: 'type', type: p.type }]),
  );
  if (self) vars.set(self, { kind: 'type', type: { kind: 'named', id: node } });

  const isPackage = (n: Node | null) => n?.type === 'identifier' && !vars.has(n.text) && ctx.imports.has(n.text);

  const expr = (n: Node | null | undefined): Expr | undefined => {
    if (!n) return undefined;
    switch (n.type) {
      case 'identifier':
        // Без локална дефиниция: променлива на пакета, типът ѝ не се вижда оттук.
        return vars.get(n.text) ?? { kind: 'type', type: UNKNOWN };
      case 'selector_expression': {
        const operand = n.childForFieldName('operand');
        const field = n.childForFieldName('field')?.text ?? '';
        if (isPackage(operand))
          return { kind: 'type', type: { kind: 'named', id: `go:${ctx.imports.get(operand?.text ?? '')}.${field}` } };
        const of = expr(operand);
        return of && { kind: 'field', of, name: field };
      }
      case 'call_expression': {
        const callee = n.childForFieldName('function');
        if (callee?.type === 'identifier' && !vars.has(callee.text)) {
          if (callee.text === 'new') {
            const t = n.childForFieldName('arguments')?.namedChildren[0];
            return t ? { kind: 'type', type: typeRef(t, ctx) } : undefined;
          }
          return isBuiltin(callee.text) ? undefined : { kind: 'call', id: nodeId(ctx.pkg, callee.text) };
        }
        if (callee?.type !== 'selector_expression') return undefined;
        const operand = callee.childForFieldName('operand');
        const name = callee.childForFieldName('field')?.text ?? '';
        if (isPackage(operand)) return { kind: 'call', id: `go:${ctx.imports.get(operand?.text ?? '')}.${name}` };
        const of = expr(operand);
        return of && { kind: 'result', of, name };
      }
      case 'composite_literal': {
        const t = n.childForFieldName('type');
        return t ? { kind: 'type', type: typeRef(t, ctx) } : undefined;
      }
      case 'type_assertion_expression': {
        const t = n.childForFieldName('type');
        return t ? { kind: 'type', type: typeRef(t, ctx) } : undefined;
      }
      case 'index_expression': {
        const of = expr(n.childForFieldName('operand'));
        return of && { kind: 'element', of };
      }
      case 'unary_expression':
      case 'parenthesized_expression':
        return expr(n.childForFieldName('operand') ?? n.namedChildren[0]);
      default:
        return undefined;
    }
  };

  // `x := y` → x е y; `a, err := f()` → a е резултатът, а последното е грешката (или `ok`)
  const assign = (left: Node | null, right: Node | null) => {
    const names = left?.namedChildren ?? [];
    const values = right?.namedChildren ?? [];
    names.forEach((target, i) => {
      if (target.type !== 'identifier' || target.text === '_') return;
      const spread = values.length !== names.length;
      const e = spread
        ? i === 0
          ? expr(values[0])
          : i === names.length - 1
            ? ({ kind: 'type', type: ERROR } as const)
            : undefined
        : expr(values[i]);
      if (e) vars.set(target.text, e);
      else vars.delete(target.text);
    });
  };

  const created = (t: Node | null) => {
    if (!t) return;
    const ref = typeRef(t, ctx);
    if (ref.kind === 'named') ctx.calls.push({ from, line: lineOf(t), kind: 'new', id: ref.id });
  };

  const visit = (n: Node) => {
    switch (n.type) {
      case 'short_var_declaration':
      case 'assignment_statement':
        for (const c of n.namedChildren) visit(c);
        assign(n.childForFieldName('left'), n.childForFieldName('right'));
        return;
      case 'var_spec': {
        const t = n.childForFieldName('type');
        if (t)
          for (const x of n.childrenForFieldName('name')) vars.set(x.text, { kind: 'type', type: typeRef(t, ctx) });
        else {
          const names = n.childrenForFieldName('name');
          const value = n.childForFieldName('value');
          names.forEach((x, i) => {
            const e = expr(value?.namedChildren[names.length === value.namedChildren.length ? i : 0]);
            if (e) vars.set(x.text, e);
          });
        }
        break;
      }
      case 'range_clause': {
        // `for i, item := range items`: вторият е елементът; при map също стойността
        const of = expr(n.childForFieldName('right'));
        const second = n.childForFieldName('left')?.namedChildren[1];
        if (of && second?.type === 'identifier') vars.set(second.text, { kind: 'element', of });
        break;
      }
      case 'func_literal':
        for (const p of params(n.childForFieldName('parameters'), ctx))
          vars.set(p.name, { kind: 'type', type: p.type });
        break;
      case 'composite_literal':
        created(n.childForFieldName('type'));
        break;
      case 'call_expression': {
        const callee = n.childForFieldName('function');
        const args = n.childForFieldName('arguments');
        const strings = (args?.namedChildren ?? []).flatMap((a) => {
          const s = stringValue(a);
          return s === undefined ? [] : [s];
        });
        if (strings.some((s) => PATH_LIKE.test(s)))
          ctx.paths.push({ from, line: lineOf(n), name: callee?.text.split('.').at(-1) ?? '', strings });
        if (callee?.type === 'identifier' && !vars.has(callee.text)) {
          if (callee.text === 'new') created(args?.namedChildren[0] ?? null);
          else if (!isBuiltin(callee.text))
            ctx.calls.push({ from, line: lineOf(callee), kind: 'function', id: nodeId(ctx.pkg, callee.text) });
        } else if (callee?.type === 'selector_expression') {
          const operand = callee.childForFieldName('operand');
          const field = callee.childForFieldName('field') ?? callee;
          if (isPackage(operand))
            ctx.calls.push({
              from,
              line: lineOf(field),
              kind: 'function',
              id: `go:${ctx.imports.get(operand?.text ?? '')}.${field.text}`,
            });
          else {
            const on = expr(operand);
            if (on) ctx.calls.push({ from, line: lineOf(field), kind: 'method', on, name: field.text });
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
