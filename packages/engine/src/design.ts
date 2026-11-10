import { existsSync } from 'node:fs';
import { join } from 'node:path';
import {
  edge,
  type Edge,
  type Field,
  type Member,
  type Node,
  type Port,
  type TypeRef,
  type TypeShape,
} from '@archgraph/model';
import {
  DESIGN_STACKS,
  DESIGN_STYLES,
  validFields,
  validOutput,
  type Architecture,
  type Design,
  type DesignCondition,
  type DesignEndpoint,
  type FieldSpec,
  type Fields,
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
  types: Record<string, TypeShape>; // полетата на DTO (входът) и на entity (изходът)
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
// при запис формата (GET /gallery/edit) и записът (PUT /gallery/edit) са различни действия
const WRITE_ALIAS: Record<string, string> = { edit: 'update', add: 'create', new: 'create' };
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
  // глаголът е последната дума, след нея може да има само параметри: /gallery/edit/{id}
  const verb = words.at(-1)?.toLowerCase();
  if (verb && words.length >= 2 && VERBS.has(verb)) {
    action = (e.method !== 'GET' && WRITE_ALIAS[verb]) || ALIAS[verb] || verb;
    resource = words.at(-2) as string;
  }
  action ??= BY_METHOD[e.method] ?? (last && isParam(last) ? 'get' : plural(resource) === resource ? 'list' : 'get');
  return {
    entity: e.entity ?? pascal(words2(singular(resource))),
    action: e.action ?? action,
    params,
  };
}

// GET без параметри е списък, ако същият ресурс има и ендпойнт с id: GET /gallery и GET /gallery/view/{id}.
function readAll(design: Design): Reading[] {
  const all = design.endpoints.map(readEndpoint);
  return all.map((r, i) => {
    const e = design.endpoints[i] as DesignEndpoint;
    const listed =
      e.method === 'GET' &&
      !e.action &&
      r.action === 'get' &&
      !r.params.length &&
      all.some((x) => x.entity === r.entity && x.params.length);
    return listed ? { ...r, action: 'list' } : r;
  });
}

// Предупреждения за чертежа: два ендпойнта с едно и също действие и ресурси, които се различават с една буква.
export function designWarnings(design: Design): string[] {
  const all = readAll(design);
  const out: string[] = [];
  const seen = new Map<string, string>();
  for (const [i, r] of all.entries()) {
    const e = design.endpoints[i] as DesignEndpoint;
    const key = `${r.action} ${r.entity}`;
    const other = seen.get(key);
    if (other) out.push(`${other} и ${e.method} ${e.path} са едно и също действие (${key}); дай им различни пътища`);
    else seen.set(key, `${e.method} ${e.path}`);
  }
  const known = new Set([...all.map((r) => r.entity), ...Object.keys(design.resources ?? {})]);
  if (design.auth && !known.has(design.auth))
    out.push(`auth: ${design.auth} не е ресурс от чертежа; влезлият е ресурс като User`);
  for (const [name, res] of Object.entries(design.resources ?? {})) {
    if (res.owner && !known.has(res.owner)) out.push(`${name}: собственикът ${res.owner} не е ресурс от чертежа`);
    else if (res.owner && owners(design, name).includes(name)) out.push(`${name}: собствениците образуват кръг`);
    if (res.fields !== undefined && !validFields(res.fields))
      out.push(`${name}: полетата са {име: тип}; имената са букви, цифри и _`);
  }
  if (!design.auth && design.endpoints.some((e) => e.public))
    out.push('публични ендпойнти има смисъл само с auth (ресурсът на влезлия)');
  for (const e of design.endpoints) {
    if (e.input !== undefined && !validFields(e.input))
      out.push(`${e.method} ${e.path}: входът е {име: тип}; имената са букви, цифри и _`);
    if (e.output !== undefined && !validOutput(e.output))
      out.push(`${e.method} ${e.path}: изходът е тип, [тип] или {име: тип}; имената са букви, цифри и _`);
  }
  const entities = [...new Set(all.map((r) => r.entity))];
  for (const [i, a] of entities.entries())
    for (const b of entities.slice(i + 1))
      if (oneEdit(a.toLowerCase(), b.toLowerCase())) out.push(`${a} и ${b} са различни ресурси; печатна грешка ли е?`);
  return out;
}

// Веригата от собственици нагоре: Photo → Album → User. Спира при кръг.
function owners(design: Design, entity: string): string[] {
  const chain: string[] = [];
  for (let x = design.resources?.[entity]?.owner; x && !chain.includes(x); x = design.resources?.[x]?.owner)
    chain.push(x);
  return chain;
}

// Данните са на влезлия, ако ресурсът е самият той или веригата от собственици стига до него.
const ownedByCaller = (design: Design, entity: string) =>
  !!design.auth && (entity === design.auth || owners(design, entity).includes(design.auth));

// Ресурсите на чертежа: от ендпойнтите и от секцията `resources`.
export function designEntities(design: Design): string[] {
  return [...new Set([...readAll(design).map((r) => r.entity), ...Object.keys(design.resources ?? {})])];
}

// Имената на ресурса за шаблоните на стила и стека: Album, Albums, album_snake…
function entityVars(entity: string): Record<string, string> {
  return {
    Entity: entity,
    Entities: plural(entity),
    entity_snake: words2(entity).join('_'),
    entities_snake: words2(plural(entity)).join('_'),
    'entity-kebab': words2(entity).join('-'),
    'entities-kebab': words2(plural(entity)).join('-'),
  };
}

function oneEdit(a: string, b: string): boolean {
  if (Math.abs(a.length - b.length) > 1 || a === b) return false;
  let i = 0;
  while (i < a.length && a[i] === b[i]) i++;
  const rest = (x: string, n: number) => x.slice(i + n);
  return rest(a, 1) === rest(b, 1) || rest(a, 0) === rest(b, 1) || rest(a, 1) === rest(b, 0);
}

export function blueprint(design: Design): Blueprint {
  const style = DESIGN_STYLES.find((s) => s.style === design.style);
  const stack = DESIGN_STACKS.find((s) => s.stack === design.stack);
  if (!style || !stack) throw new Error(`непознат стил или стек: ${design.style}, ${design.stack}`);
  const cs = (words: string[]) => (stack.case === 'snake' ? words.join('_') : camel(words));
  const nodes = new Map<string, Node>();
  const edges = new Map<string, Edge>();
  const registrations: Blueprint['registrations'] = [];
  const types: Record<string, TypeShape> = {};
  // полетата се събират по нод: entity получава изхода на всички ендпойнти на ресурса
  const addFields = (n: Node, fields: Field[]) => {
    const shape = types[n.id] ?? { id: n.id, name: n.name, nodeId: n.id, fields: [] };
    for (const f of fields) if (!shape.fields.some((x) => x.name === f.name)) shape.fields.push(f);
    types[n.id] = shape;
  };
  const globs = new Map<string, Set<string>>(); // слой → файловете му за architecture

  const classVars = new Map<string, Record<string, string>>(); // id → променливите на класа: за вложените обекти
  const nestedIds = new Set<string>();

  const addEdge = (e: Edge) => edges.set(e.id, e);
  const addMember = (n: Node, m: Member) => {
    if (!n.members.some((x) => x.name === m.name)) n.members.push(m);
  };

  const readings = readAll(design);
  for (const [i, e] of design.endpoints.entries()) {
    const r = readings[i] as Reading;
    const read = e.method === 'GET';
    const holds = (c?: DesignCondition) =>
      !c ||
      (c === 'read' && read) ||
      (c === 'write' && !read) ||
      (c === 'body' && ['POST', 'PUT', 'PATCH'].includes(e.method)) ||
      (c === 'create' && r.action === 'create');
    const actionWords = words2(r.action);
    const vars: Record<string, string> = {
      ...entityVars(r.entity),
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
    // класът на част от стила; с други променливи — на друг ресурс (repository-то на собственика)
    const place = (part: StylePart, name: string, from: Record<string, string>): Node => {
      const v = {
        ...from,
        Name: name,
        Folder: stack.folders?.[part.file] ?? part.file,
        dotted: dotted(name, part.file),
      };
      const file = fill(part.kind === 'template' ? stack.template : stack.class.file, v);
      const id = part.kind === 'template' ? `template:${file}` : fill(stack.class.id, { ...v, file });
      classVars.set(id, v);
      where(part.layer, file);
      const n = nodes.get(id) ?? {
        id,
        kind: part.kind ?? 'class',
        name,
        language: stack.language,
        role: part.role,
        layer: part.layer,
        context: from['Module'] as string,
        location: { file, line: 1, endLine: 1 },
        members: [],
        tags: ['ghost'],
      };
      nodes.set(id, n);
      return n;
    };
    const classNode = (key: string, part: StylePart, name = fill(part.name, vars)): Node => {
      const n = place(part, name, vars);
      here.set(key, n);
      return n;
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
    const idPort = (words: string[]): Port => ({ name: cs(words), type: { kind: 'primitive', name: stack.types.id } });
    const params: Port[] = r.params.map((p) => idPort(words2(p)));
    // влезлият: id-то му идва от входа (токена), не от пътя; само при неговите данни и без `public`
    const caller =
      design.auth && !e.public && ownedByCaller(design, r.entity) ? idPort([...words2(design.auth), 'id']) : undefined;
    const ids = [...params, ...(caller && !params.some((p) => p.name === caller.name) ? [caller] : [])];
    const resource = design.resources?.[r.entity];
    const ownerId = resource?.owner ? idPort([...words2(resource.owner), 'id']) : undefined;
    // Вложеният обект е клас до собственика си, в неговия слой: PHP — свой файл, Nest и Python — същият.
    // Името е от полето (photos → Photo); ако е заето от друг клас — с името на собственика отпред.
    const nested = (owner: Node, field: string, spec: Fields): Node => {
      const v = classVars.get(owner.id) ?? {};
      const at = (name: string) => {
        const file = fill(stack.class.file, { ...v, Name: name });
        return { name, file, id: fill(stack.class.id, { ...v, Name: name, file }) };
      };
      // photos → Photo; ако името е на друг клас или ресурс (entity Photo) — с ресурса отпред: AlbumPhoto
      const plain = pascal(words2(singular(field)));
      let place = at(plain);
      const taken =
        (nodes.has(place.id) && !nestedIds.has(place.id)) ||
        readings.some((x) => x.entity === plain) ||
        [...nodes.values()].some((x) => x.name === plain && x.id !== place.id);
      if (taken) place = at(r.entity + plain);
      const n = nodes.get(place.id) ?? {
        id: place.id,
        kind: 'class',
        name: place.name,
        language: stack.language,
        ...(owner.role ? { role: owner.role } : {}),
        ...(owner.layer ? { layer: owner.layer } : {}),
        ...(owner.context ? { context: owner.context } : {}),
        location: { file: place.file, line: 1, endLine: 1 },
        members: [],
        tags: ['ghost'],
      };
      nodes.set(n.id, n);
      nestedIds.add(n.id);
      classVars.set(n.id, v);
      if (owner.layer) where(owner.layer, place.file);
      addFields(n, fields(spec, n));
      return n;
    };
    // общият тип (int, date) на езика на стека; друго име е клас от чертежа или остава както е написано.
    // Без собственик (параметри на метод) вложеният обект е просто object на езика.
    const fieldType = (t: FieldSpec, field: string, owner?: Node): TypeRef => {
      if (Array.isArray(t)) return { kind: 'array', of: fieldType(t[0] ?? 'string', field, owner) };
      if (typeof t === 'object')
        return owner ? named(nested(owner, field, t)) : { kind: 'primitive', name: stack.types['object'] ?? 'object' };
      const entity = [...nodes.values()].find((n) => n.name === t && n.kind !== 'route');
      if (entity) return named(entity);
      const list = /^list\[(.+)\]$|^(.+)\[\]$/.exec(t);
      if (list) return { kind: 'array', of: fieldType((list[1] ?? list[2]) as string, field, owner) };
      return { kind: 'primitive', name: stack.types[t] ?? t };
    };
    const fields = (spec: Fields = {}, owner?: Node): Field[] =>
      Object.entries(spec).map(([name, t]) => ({ name: cs(words2(name)), type: fieldType(t, name, owner) }));
    // съобщението (DDD) е единственият вход на handler-а: носи и параметрите от пътя
    const carries = Object.values(style.parts).some((p) => p.method === 'handle');
    if (dto) addFields(dto, [...(carries ? ids : []), ...fields(e.input, dto)]);
    // без DTO входът са параметри на методите (GET: query параметрите)
    const query: Port[] = dto ? [] : fields(e.input).map((f) => ({ name: f.name, type: f.type }));
    const inputs: Port[] = [...ids, ...query, ...(dto ? [{ name: cs(['input']), type: named(dto) }] : [])];
    // полетата на entity-то са от секцията `resources`: id, собственикът (по id, не обект) и описаните
    if (entityNode && resource)
      addFields(entityNode, [idPort(['id']), ...(ownerId ? [ownerId] : []), ...fields(resource.fields, entityNode)]);
    // Изходът е какво връщат методите: избран тип (Gallery, Gallery[], int) или полета, от които става
    // клас за отговора до DTO-тата (при списък — един елемент). Без изход — entity-то.
    const resultPart =
      Object.values(style.parts).find((p) => p.role === 'dto') ??
      Object.values(style.parts).find((p) => p.role === 'entity' || p.role === 'model');
    // where: 'top' — самият изход, 'item' — елемент на масив (при списък изходът е масив от елементи)
    const outputType = (spec: FieldSpec, where: 'top' | 'item'): TypeRef => {
      if (typeof spec === 'string') return fieldType(spec, 'result');
      if (Array.isArray(spec)) return { kind: 'array', of: outputType(spec[0] ?? 'string', 'item') };
      if (!resultPart) return { kind: 'primitive', name: stack.types['object'] ?? 'object' };
      const list = where === 'top' && r.action === 'list';
      const result = classNode(
        'result',
        { ...resultPart, role: 'dto', kind: 'class' },
        list || where === 'item' ? `${r.entity}Item` : `${vars['Action']}${r.entity}Result`,
      );
      addFields(result, fields(spec, result));
      return list ? { kind: 'array', of: named(result) } : named(result);
    };
    const output: Port = {
      name: 'return',
      type:
        e.output !== undefined
          ? outputType(e.output, 'top')
          : r.action === 'list'
            ? { kind: 'array', of: entityType }
            : r.action === 'delete'
              ? { kind: 'primitive', name: stack.types.void }
              : entityType,
    };
    const member = (n: Node, name: string, ins: Port[], out?: Port, isStatic = false): Member => ({
      name,
      visibility: 'public',
      ...(isStatic ? { static: true } : {}),
      inputs: [...ins], // копие: зависимостите на функцията се добавят към нейните параметри
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
        // repository-то е в domain: връща entity-та, не класа за отговора от application
        const many: Port = { name: 'return', type: { kind: 'array', of: entityType } };
        // списъкът и търсенето са само на влезлия: findAll(userId), search(userId, q)
        const mine = caller && r.entity !== design.auth ? [caller] : [];
        const criteria: Port[] = [...mine, ...fields(e.input).map((f) => ({ name: f.name, type: f.type }))];
        if (r.action === 'list') found.push(member(n, cs(['find', 'all']), mine, many));
        else if (r.action === 'delete') found.push(member(n, cs(['delete']), [id], none));
        else if (r.action === 'create') found.push(save);
        else if (read && r.action !== 'get' && !r.params.length && criteria.length > mine.length)
          found.push(member(n, vars['action'] as string, criteria, many)); // search(q): Album[]
        else if (read) found.push(findById);
        else found.push(findById, save);
      }
      // домейнът не знае за DTO-тата от application: получава полетата им
      const domainInputs: Port[] = fields(e.input, entityNode).map((f) => ({ name: f.name, type: f.type }));
      // create получава и параметрите от пътя (POST /albums/{albumId}/photos → albumId) и собственика
      // (Album::create(userId, …)); друго действие е метод на агрегата само ако е върху един от тях
      // (update или /invoices/{id}/cancel), не login или logout
      const created = [...params, ...(ownerId && !params.some((p) => p.name === ownerId.name) ? [ownerId] : [])];
      if (part.method === 'domain' && !read && r.action === 'create')
        found.push(member(n, cs(['create']), [...created, ...domainInputs], { name: 'return', type: named(n) }, true));
      else if (part.method === 'domain' && !read && r.action !== 'delete' && (r.action === 'update' || r.params.length))
        found.push(member(n, vars['action'] as string, domainInputs));
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

    // Зависимостта влиза в конструктора; при функция (FastAPI) е параметър: `service = Depends(...)`.
    const inject = (from: Node, fromKey: string, to: Node) => {
      const port = cs(words2(to.name));
      const at =
        from.kind === 'function'
          ? (methods.get(fromKey)?.[0] ?? from.name)
          : (CONSTRUCTOR[stack.language] ?? 'constructor');
      if (from.kind !== 'function') addMember(from, member(from, at, []));
      const ctor = from.members.find((m) => m.name === at);
      if (ctor && !ctor.inputs.some((p) => p.name === port)) ctor.inputs.push({ name: port, type: named(to) });
      addEdge(edge('injects', { node: to.id }, { node: from.id, member: at, port }));
    };

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
      if (kind === 'calls' && injectable && (methods.get(f.to) ?? []).length) inject(from, f.from, to);
    }

    // Чий е записът: агрегатът най-горе във веригата до влезлия (Album) проверява собственика с
    // checkOwner(userId), а който работи със снимка, зарежда и албума ѝ през неговото repository.
    // Списъкът и търсенето вече са само на влезлия (findAll(userId)); create на Album сам задава собственика.
    const chain = caller && r.entity !== design.auth && r.params.length ? [r.entity, ...owners(design, r.entity)] : [];
    const above = chain.slice(1, chain.indexOf(design.auth as string));
    const root = above.at(-1) ?? (chain.length ? r.entity : undefined);
    const contract = Object.entries(style.parts).find(([, p]) => p.method === 'storage' && !p.implements);
    const users = contract
      ? style.flow.filter((f) => f.to === contract[0] && (f.kind ?? 'calls') === 'calls' && holds(f.when))
      : [];
    const entityPart = Object.values(style.parts).find((p) => p.role === 'entity' || p.role === 'model');
    const varsOf = (entity: string) => {
      const v = { ...vars, ...entityVars(entity) };
      return { ...v, Module: fill(stack.module, v) };
    };
    for (const owner of contract ? above : []) {
      const [key, part] = contract as [string, StylePart];
      const ov = varsOf(owner);
      const entity = entityPart ? place(entityPart, fill(entityPart.name, ov), ov) : undefined;
      const one: Port = { name: 'return', type: entity ? named(entity) : { kind: 'unknown', hint: owner } };
      const repo = place(part, fill(part.name, ov), ov);
      const findById = member(repo, cs(['find', 'by', 'id']), [idPort(['id'])], one);
      addMember(repo, findById);
      for (const impl of Object.values(style.parts).filter((p) => p.implements === key)) {
        const store = place(impl, fill(impl.name, ov), ov);
        addMember(store, { ...findById, location: store.location });
        addEdge(edge('implements', { node: store.id }, { node: repo.id }));
      }
      for (const f of users) {
        const from = here.get(f.from);
        if (!from) continue;
        for (const fm of methods.get(f.from) ?? [])
          addEdge(edge('calls', { node: from.id, member: fm }, { node: repo.id, member: findById.name }));
        if (style.parts[f.to]?.role !== 'model') inject(from, f.from, repo);
      }
    }
    const domain = Object.values(style.parts).some((p) => p.method === 'domain');
    if (root && caller && domain && entityPart) {
      const ov = varsOf(root);
      const aggregate = root === r.entity && entityNode ? entityNode : place(entityPart, fill(entityPart.name, ov), ov);
      const none: Port = { name: 'return', type: { kind: 'primitive', name: stack.types.void } };
      addMember(aggregate, member(aggregate, cs(['check', 'owner']), [caller], none));
      for (const f of users) {
        const from = here.get(f.from);
        for (const fm of from ? (methods.get(f.from) ?? []) : [])
          addEdge(
            edge(
              'calls',
              { node: (from as Node).id, member: fm },
              { node: aggregate.id, member: cs(['check', 'owner']) },
            ),
          );
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
  return { nodes: [...nodes.values()], edges: [...edges.values()], registrations, architecture, style, stack, types };
}

// Ghost нодовете, които още ги няма в кода, и ребрата, които водят до тях. Route се сравнява по метод
// и път без имената на параметрите (`{id:\d+}` и `:id` са едно и също); шаблонът — по файла.
export function merge(
  root: string,
  real: Node[],
  bp: Blueprint,
): { nodes: Node[]; edges: Edge[]; types: Record<string, TypeShape>; done: number; total: number } {
  const ids = new Set(real.map((n) => n.id));
  // route-ът на друг език (PHP при чертеж на NestJS) не е написан по този чертеж
  const routes = new Map(
    real.filter((n) => n.kind === 'route' && n.language === bp.stack.language).map((n) => [routeKey(n.name), n.id]),
  );
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
  const types = Object.fromEntries(Object.entries(bp.types).filter(([id]) => ghostIds.has(id)));
  return {
    nodes: [...ghosts, ...templates],
    edges,
    types,
    done: bp.nodes.length - ghosts.length,
    total: bp.nodes.length,
  };
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
