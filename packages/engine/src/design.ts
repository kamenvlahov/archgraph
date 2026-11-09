import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { edge, type Edge, type Member, type Node, type Port, type TypeRef } from '@archgraph/model';
import {
  DESIGN_STACKS,
  DESIGN_STYLES,
  type Architecture,
  type Design,
  type DesignCondition,
  type DesignEndpoint,
  type Stack,
  type Style,
  type StylePart,
} from '@archgraph/rules';

// Чертежът (етап 11) като нодове: всеки ендпойнт става верига от участниците на стила с имената,
// файловете и id-тата от стека. Id-тата са същите, които адаптерът дава на истинския код, затова
// написаното по плана заменя ghost нода (merge). Archgraph не пише код (D-005): изходът е граф и план.

export interface Blueprint {
  nodes: Node[];
  edges: Edge[];
  registrations: { route: string; file: string; text: string }[];
  architecture: Architecture;
  style: Style;
  stack: Stack;
}

// Ендпойнтът, разчетен: ресурсът и действието от пътя, ако не са дадени изрично.
export interface Reading {
  entity: string; // Invoice
  action: string; // list, get, create, update, delete или думата от пътя (edit, cancel)
  params: string[];
}

const VERBS = new Set(
  'add new create edit update delete remove cancel approve reject archive publish unpublish search export import list index view show confirm pay send close open restore activate deactivate login logout register reset upload download copy clone duplicate move sort preview print submit validate verify assign complete start stop'.split(
    ' ',
  ),
);
const ALIAS: Record<string, string> = { index: 'list', view: 'get', show: 'get', remove: 'delete' };
const BY_METHOD: Record<string, string> = { POST: 'create', PUT: 'update', PATCH: 'update', DELETE: 'delete' };
const CONSTRUCTOR: Record<string, string> = { php: '__construct', node: 'constructor', python: '__init__' };

const isParam = (s: string) => /^\{.*\}$|^:/.test(s);
const paramName = (s: string) => s.replace(/^[{:]/, '').replace(/[:}].*$/, '');

export function readEndpoint(e: DesignEndpoint): Reading {
  const segs = e.path.split('/').filter(Boolean);
  const words = segs.filter((s) => !isParam(s));
  const params = segs.filter(isParam).map(paramName);
  const last = segs.at(-1);
  let resource = words.at(-1) ?? 'home';
  let action: string | undefined;
  if (last && !isParam(last) && words.length >= 2 && VERBS.has(last.toLowerCase())) {
    action = ALIAS[last.toLowerCase()] ?? last.toLowerCase();
    resource = words.at(-2) as string;
  }
  action ??= BY_METHOD[e.method] ?? (last && isParam(last) ? 'get' : plural(resource) === resource ? 'list' : 'get');
  return {
    entity: e.entity ?? pascal(words2(singular(resource))),
    action: e.action ?? action,
    params,
  };
}

export function blueprint(design: Design): Blueprint {
  const style = DESIGN_STYLES.find((s) => s.style === design.style);
  const stack = DESIGN_STACKS.find((s) => s.stack === design.stack);
  if (!style || !stack) throw new Error(`непознат стил или стек: ${design.style}, ${design.stack}`);
  const cs = (words: string[]) => (stack.case === 'snake' ? words.join('_') : camel(words));
  const nodes = new Map<string, Node>();
  const edges = new Map<string, Edge>();
  const registrations: Blueprint['registrations'] = [];
  const globs = new Map<string, Set<string>>(); // слой → файловете му за architecture

  const addEdge = (e: Edge) => edges.set(e.id, e);
  const addMember = (n: Node, m: Member) => {
    if (!n.members.some((x) => x.name === m.name)) n.members.push(m);
  };

  for (const e of design.endpoints) {
    const r = readEndpoint(e);
    const read = e.method === 'GET';
    const holds = (c?: DesignCondition) =>
      !c ||
      (c === 'read' && read) ||
      (c === 'write' && !read) ||
      (c === 'body' && ['POST', 'PUT', 'PATCH'].includes(e.method)) ||
      (c === 'create' && r.action === 'create');
    const actionWords = words2(r.action);
    const vars: Record<string, string> = {
      Entity: r.entity,
      Entities: plural(r.entity),
      entity_snake: words2(r.entity).join('_'),
      entities_snake: words2(plural(r.entity)).join('_'),
      'entity-kebab': words2(r.entity).join('-'),
      'entities-kebab': words2(plural(r.entity)).join('-'),
      Action: pascal(actionWords),
      action: cs(actionWords),
      action_snake: actionWords.join('_'),
      'action-kebab': actionWords.join('-'),
      Target: r.action === 'list' ? plural(r.entity) : r.entity,
      target_snake: words2(r.action === 'list' ? plural(r.entity) : r.entity).join('_'),
      Message: read ? 'Query' : 'Command',
      METHOD: e.method,
      method: e.method.toLowerCase(),
      path: e.path.replace(/\{([^}:]+)(:[^}]*)?\}|:(\w+)/g, (_, a: string, __, b: string) =>
        stack.route.param.replace('*', a ?? b),
      ),
    };
    vars['Module'] = fill(stack.module, vars);
    // слоят на истинския код е по файла от чертежа
    const where = (layer: string, file: string) => globs.set(layer, (globs.get(layer) ?? new Set()).add(file));

    // Участниците на този ендпойнт: id на нода по ключа на частта.
    const here = new Map<string, Node>();
    const node = (key: string, make: () => Node): Node => {
      const made = make();
      const n = nodes.get(made.id) ?? made;
      nodes.set(n.id, n);
      here.set(key, n);
      return n;
    };
    const classNode = (key: string, part: StylePart): Node => {
      const name = fill(part.name, vars);
      const v = {
        ...vars,
        Name: name,
        Folder: stack.folders?.[part.file] ?? part.file,
        dotted: dotted(name, part.file),
      };
      const file = fill(part.kind === 'template' ? stack.template : stack.class.file, v);
      where(part.layer, file);
      return node(key, () => ({
        id: part.kind === 'template' ? `template:${file}` : fill(stack.class.id, { ...v, file }),
        kind: part.kind ?? 'class',
        name,
        language: stack.language,
        role: part.role,
        layer: part.layer,
        context: vars['Module'] as string,
        location: { file, line: 1, endLine: 1 },
        members: [],
        tags: ['ghost'],
      }));
    };

    // Входът: формата е от стека (handler на ендпойнт, controller на ресурс, функция).
    const entryName = fill(stack.entry.name, vars);
    const entryVars = {
      ...vars,
      Name: entryName,
      Folder: stack.folders?.['entry'] ?? 'entry',
      dotted: dotted(entryName, 'controller'),
    };
    const entryFile = fill(stack.entry.file ?? stack.class.file, entryVars);
    where(style.entry, entryFile);
    const entry = node('entry', () => ({
      id: fill(stack.entry.id ?? stack.class.id, { ...entryVars, file: entryFile }),
      kind: stack.entry.kind,
      name: entryName,
      language: stack.language,
      role: 'controller',
      layer: style.entry,
      context: vars['Module'] as string,
      location: { file: entryFile, line: 1, endLine: 1 },
      members: [],
      tags: ['ghost'],
    }));
    for (const [key, part] of Object.entries(style.parts)) if (holds(part.when)) classNode(key, part);
    for (const [key, part] of Object.entries(style.parts)) {
      const impl = here.get(key);
      const contract = part.implements ? here.get(part.implements) : undefined;
      if (impl && contract) addEdge(edge('implements', { node: impl.id }, { node: contract.id }));
    }

    // Типовете в сигнатурите: entity, DTO на ендпойнта, параметрите на пътя.
    const named = (n: Node): TypeRef => ({ kind: 'named', id: n.id });
    const entityNode = [...here.entries()].find(([k]) => ['entity', 'model'].includes(style.parts[k]?.role ?? ''))?.[1];
    const entityType: TypeRef = entityNode ? named(entityNode) : { kind: 'unknown', hint: r.entity };
    const dto = [...here.entries()].find(([k]) => style.parts[k]?.role === 'dto')?.[1];
    const params: Port[] = r.params.map((p) => ({
      name: cs(words2(p)),
      type: { kind: 'primitive', name: stack.types.id },
    }));
    const inputs: Port[] = [...params, ...(dto ? [{ name: cs(['input']), type: named(dto) }] : [])];
    const output: Port = {
      name: 'return',
      type:
        r.action === 'list'
          ? { kind: 'array', of: entityType }
          : r.action === 'delete'
            ? { kind: 'primitive', name: stack.types.void }
            : entityType,
    };
    const member = (n: Node, name: string, ins: Port[], out?: Port, isStatic = false): Member => ({
      name,
      visibility: 'public',
      ...(isStatic ? { static: true } : {}),
      inputs: ins,
      ...(out ? { output: out } : {}),
      location: n.location,
    });

    // Методите на всеки участник, които този ендпойнт ползва.
    const methods = new Map<string, string[]>();
    const entryMethod = stack.entry.kind === 'function' ? entryName : fill(stack.entry.method ?? '{action}', vars);
    const entryInputs: Port[] = stack.entry.inputs
      ? stack.entry.inputs.map((p) => ({ name: p.name, type: { kind: 'named', id: p.type } }))
      : inputs;
    const entryOutput: Port = stack.entry.output
      ? { name: 'return', type: { kind: 'named', id: stack.entry.output } }
      : output;
    addMember(entry, member(entry, entryMethod, entryInputs, entryOutput));
    methods.set('entry', [entryMethod]);
    for (const [key, n] of here) {
      const part = style.parts[key];
      if (!part?.method) continue;
      const found: Member[] = [];
      if (part.method === 'action') found.push(member(n, vars['action'] as string, inputs, output));
      if (part.method === 'execute' || part.method === 'handle') {
        const message = part.method === 'handle' ? dto : undefined;
        found.push(
          member(n, part.method, message ? [{ name: cs(['message']), type: named(message) }] : inputs, output),
        );
      }
      if (part.method === 'storage') {
        const id: Port = { name: cs(['id']), type: { kind: 'primitive', name: stack.types.id } };
        const one: Port = { name: 'return', type: entityType };
        const none: Port = { name: 'return', type: { kind: 'primitive', name: stack.types.void } };
        const findById = member(n, cs(['find', 'by', 'id']), [id], one);
        const save = member(n, cs(['save']), [{ name: cs(['entity']), type: entityType }], none);
        if (r.action === 'list') found.push(member(n, cs(['find', 'all']), [], output));
        else if (r.action === 'delete') found.push(member(n, cs(['delete']), [id], none));
        else if (r.action === 'create') found.push(save);
        else if (read) found.push(findById);
        else found.push(findById, save);
      }
      if (part.method === 'domain' && !read && r.action !== 'delete')
        found.push(
          r.action === 'create'
            ? member(n, cs(['create']), inputs, { name: 'return', type: named(n) }, true)
            : member(
                n,
                vars['action'] as string,
                inputs.filter((p) => p.type.kind !== 'primitive'),
              ),
        );
      for (const m of found) addMember(n, m);
      methods.set(
        key,
        found.map((m) => m.name),
      );
    }
    // Имплементацията има методите на договора си.
    for (const [key, part] of Object.entries(style.parts)) {
      const impl = here.get(key);
      const contract = part.implements ? here.get(part.implements) : undefined;
      if (!impl || !contract) continue;
      for (const m of contract.members) addMember(impl, { ...m, location: impl.location });
      methods.set(key, methods.get(part.implements as string) ?? []);
    }

    // Веригата: извиквания, създаване и изгледи; при извикване на клас — и инжектиране.
    for (const f of style.flow) {
      const from = here.get(f.from);
      const to = here.get(f.to);
      if (!from || !to || !holds(f.when)) continue;
      const kind = f.kind ?? 'calls';
      const sources = (methods.get(f.from) ?? []).filter(
        (m) => kind !== 'creates' || f.from === 'entry' || !/save|delete/i.test(m),
      );
      for (const fm of sources) {
        if (kind === 'calls')
          for (const tm of methods.get(f.to) ?? [])
            addEdge(edge('calls', { node: from.id, member: fm }, { node: to.id, member: tm }));
        else addEdge(edge(kind, { node: from.id, member: fm }, { node: to.id }));
      }
      // entity и DTO се зареждат и създават, не се инжектират
      const injectable = !['entity', 'model', 'dto', 'view'].includes(style.parts[f.to]?.role ?? '');
      if (kind === 'calls' && injectable && (methods.get(f.to) ?? []).length) {
        const port = cs(words2(to.name));
        const at =
          from.kind === 'function'
            ? (methods.get(f.from)?.[0] ?? from.name)
            : (CONSTRUCTOR[stack.language] ?? 'constructor');
        if (from.kind !== 'function') addMember(from, member(from, at, []));
        // при функция (FastAPI) зависимостта е параметър: `service = Depends(...)`
        const ctor = from.members.find((m) => m.name === at);
        if (ctor && !ctor.inputs.some((p) => p.name === port)) ctor.inputs.push({ name: port, type: named(to) });
        addEdge(edge('injects', { node: to.id }, { node: from.id, member: at, port }));
      }
    }

    // Route-ът и редът, с който се регистрира.
    const routeFile = stack.route.file ?? entryFile;
    const route: Node = {
      id: `${stack.language}:route:${e.method} ${vars['path']}`,
      kind: 'route',
      name: `${e.method} ${vars['path']}`,
      language: stack.language,
      role: 'route',
      location: { file: routeFile, line: 1, endLine: 1 },
      members: [],
      tags: ['ghost'],
    };
    nodes.set(route.id, route);
    addEdge(edge('routes-to', { node: route.id }, { node: entry.id, member: entryMethod }));
    if (stack.route.line)
      registrations.push({
        route: route.id,
        file: routeFile,
        text: fill(stack.route.line, { ...vars, Entry: entryName }),
      });
  }

  // Конструкторът е последен в класа само ако е добавен след методите: местим го отпред.
  for (const n of nodes.values()) {
    const ctor = n.members.findIndex((m) => m.name === CONSTRUCTOR[stack.language]);
    if (ctor > 0) n.members.unshift(...n.members.splice(ctor, 1));
  }

  const architecture: Architecture = {
    style: style.style,
    layers: style.layers
      .filter((l) => globs.has(l))
      .map((l) => ({ name: l, match: { path_glob: [...(globs.get(l) as Set<string>)] } })),
    allow: {},
  };
  return { nodes: [...nodes.values()], edges: [...edges.values()], registrations, architecture, style, stack };
}

// Ghost нодовете, които още ги няма в кода, и ребрата, които водят до тях. Route се сравнява по метод
// и път без имената на параметрите (`{id:\d+}` и `:id` са едно и също); шаблонът — по файла.
export function merge(
  root: string,
  real: Node[],
  bp: Blueprint,
): { nodes: Node[]; edges: Edge[]; done: number; total: number } {
  const ids = new Set(real.map((n) => n.id));
  const routes = new Map(real.filter((n) => n.kind === 'route').map((n) => [routeKey(n.name), n.id]));
  const actual = new Map<string, string>(); // id в чертежа → id в кода
  for (const n of bp.nodes) {
    if (ids.has(n.id)) actual.set(n.id, n.id);
    else if (n.kind === 'route' && routes.has(routeKey(n.name)))
      actual.set(n.id, routes.get(routeKey(n.name)) as string);
    else if (n.kind === 'template' && existsSync(join(root, n.location.file))) actual.set(n.id, n.id);
  }
  const ghosts = bp.nodes.filter((n) => !actual.has(n.id));
  const ghostIds = new Set(ghosts.map((n) => n.id));
  // Към истински нод: ако методът от чертежа още го няма в класа, реброто сочи самия клас.
  const byId = new Map(real.map((n) => [n.id, n]));
  const end = (x: Edge['from']): Edge['from'] => {
    const id = actual.get(x.node) ?? x.node;
    const n = byId.get(id);
    if (!n || !x.member || n.members.some((m) => m.name === x.member)) return { ...x, node: id };
    return { node: id };
  };
  const edges = bp.edges.flatMap((e) => {
    if (!ghostIds.has(e.from.node) && !ghostIds.has(e.to.node)) return [];
    return [edge(e.kind, end(e.from), end(e.to), 'inferred')];
  });
  // Истинските шаблони ги няма в графа (адаптери за шаблони — етап 10): нодът е от чертежа, без ghost.
  const templates = bp.nodes.filter((n) => n.kind === 'template' && actual.has(n.id)).map((n) => ({ ...n, tags: [] }));
  return { nodes: [...ghosts, ...templates], edges, done: bp.nodes.length - ghosts.length, total: bp.nodes.length };
}

function routeKey(name: string): string {
  const [method = '', path = ''] = name.split(' ');
  return `${method} ${path.replace(/\{[^}]*\}|:\w+/g, '{}').replace(/\/$/, '')}`;
}

function fill(template: string, vars: Record<string, string>): string {
  return template.replace(/\{([\w-]+)\}/g, (m, k: string) => vars[k] ?? m);
}

// Името на файла в Nest: `CreateInvoiceUseCase` → `create-invoice.use-case`, `Invoice` → `invoice.entity`.
const SUFFIXES = ['UseCase', 'Controller', 'Service', 'Repository', 'Handler', 'Command', 'Query', 'Input', 'Dto'];
function dotted(name: string, file: string): string {
  const suffix = SUFFIXES.find((s) => name.endsWith(s) && name !== s);
  if (!suffix) return `${words2(name).join('-')}.${file}`;
  return `${words2(name.slice(0, -suffix.length)).join('-')}.${words2(suffix).join('-')}`;
}

function words2(s: string): string[] {
  return s
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .split(/[\s_\-.]+/)
    .filter(Boolean)
    .map((w) => w.toLowerCase());
}

function pascal(words: string[]): string {
  return words.map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join('');
}

function camel(words: string[]): string {
  const p = pascal(words);
  return p.charAt(0).toLowerCase() + p.slice(1);
}

function plural(s: string): string {
  if (/[^aeiou]y$/i.test(s)) return `${s.slice(0, -1)}ies`;
  if (/(s|x|ch|sh)$/i.test(s)) return /ss$/i.test(s) || !/s$/i.test(s) ? `${s}es` : s;
  return `${s}s`;
}

function singular(s: string): string {
  if (/ies$/i.test(s)) return `${s.slice(0, -3)}y`;
  if (/(x|ch|sh|ss)es$/i.test(s)) return s.slice(0, -2);
  if (/s$/i.test(s) && !/ss$/i.test(s)) return s.slice(0, -1);
  return s;
}
