import { posix } from 'node:path';
import type { Edge, Member, Node, Port, TypeRef } from '@archgraph/model';
import type { Blueprint } from './design.ts';

// Скелетът на файл от чертежа (D-014): namespace, импорти, класът или интерфейсът, конструкторът
// със зависимостите и методите със сигнатурите. Тялото е само коментар кого вика и TODO: логиката
// е на човека или на агента по плана. Пише се само при „Създай файла“ в редактора.

interface Ctx {
  bp: Blueprint;
  byId: Map<string, Node>;
  out: Map<string, Edge[]>;
  routes: Map<string, Node>; // `id#member` на входа → route-ът към него
}

export function skeleton(bp: Blueprint, file: string): string | undefined {
  const nodes = bp.nodes.filter((n) => n.location.file === file);
  if (!nodes.length) return undefined;
  const byId = new Map(bp.nodes.map((n) => [n.id, n]));
  const out = Map.groupBy(bp.edges, (e) => e.from.node);
  const routes = new Map(
    bp.edges
      .filter((e) => e.kind === 'routes-to')
      .map((e) => [`${e.to.node}#${e.to.member ?? ''}`, byId.get(e.from.node) as Node]),
  );
  const ctx: Ctx = { bp, byId, out, routes };
  if (nodes.every((n) => n.kind === 'route')) return routesFile(ctx, nodes);
  const own = nodes.filter((n) => n.kind !== 'route');
  if (own.some((n) => n.kind === 'template')) return `<!-- ${own[0]?.name}: изгледът от чертежа -->\n`;
  if (bp.stack.language === 'php') return php(ctx, own[0] as Node);
  if (bp.stack.language === 'node') return ts(ctx, ordered(ctx, own));
  return python(ctx, ordered(ctx, own));
}

// Вложените обекти от същия файл преди класа, който ги ползва в полетата си (Python ги чете при дефиницията).
function ordered(ctx: Ctx, own: Node[]): Node[] {
  const here = new Set(own.map((n) => n.id));
  const seen = new Set<string>();
  const out: Node[] = [];
  const visit = (n: Node) => {
    if (seen.has(n.id)) return;
    seen.add(n.id);
    const refs = new Set<string>();
    for (const f of ctx.bp.types[n.id]?.fields ?? []) named(f.type, ctx, refs);
    for (const id of refs) if (here.has(id)) visit(ctx.byId.get(id) as Node);
    out.push(n);
  };
  for (const n of own) visit(n);
  return out;
}

// Кого вика методът: редовете за коментара в тялото.
function calls(ctx: Ctx, n: Node, m: Member, sep: string): string[] {
  return (ctx.out.get(n.id) ?? [])
    .filter((e) => e.from.member === m.name && ['calls', 'creates', 'renders'].includes(e.kind))
    .map((e) => {
      const to = ctx.byId.get(e.to.node)?.name ?? e.to.node;
      if (e.kind === 'creates') return `new ${to}`;
      if (e.kind === 'renders') return `изглед ${ctx.byId.get(e.to.node)?.location.file ?? to}`;
      return `→ ${to}${sep}${e.to.member}()`;
    });
}

const implementsOf = (ctx: Ctx, n: Node) =>
  (ctx.out.get(n.id) ?? []).filter((e) => e.kind === 'implements').map((e) => ctx.byId.get(e.to.node) as Node);

const isCtor = (m: Member) => ['__construct', 'constructor', '__init__'].includes(m.name);

// Имената на типовете в сигнатурите (без пакета) и нодовете от чертежа, към които водят.
function named(t: TypeRef, ctx: Ctx, found: Set<string>): void {
  if (t.kind === 'named') found.add(t.id);
  if (t.kind === 'array') named(t.of, ctx, found);
  if (t.kind === 'union') for (const x of t.of) named(x, ctx, found);
}
function referenced(ctx: Ctx, n: Node, extra: string[] = []): Node[] {
  const ids = new Set<string>();
  for (const m of n.members) {
    for (const p of m.inputs) named(p.type, ctx, ids);
    if (m.output) named(m.output.type, ctx, ids);
  }
  for (const f of ctx.bp.types[n.id]?.fields ?? []) named(f.type, ctx, ids);
  for (const b of implementsOf(ctx, n)) ids.add(b.id);
  for (const x of extra) ids.add(x);
  ids.delete(n.id);
  return [...ids].flatMap((id) => (ctx.byId.has(id) ? [ctx.byId.get(id) as Node] : []));
}
const externals = (n: Node) => {
  const ids = new Set<string>();
  for (const m of n.members) {
    for (const p of m.inputs) if (p.type.kind === 'named') ids.add(p.type.id);
    if (m.output?.type.kind === 'named') ids.add(m.output.type.id);
  }
  return ids;
};

// --- PHP: един клас на файл, PSR-4 namespace от id-то, конструктор с promoted properties.

function php(ctx: Ctx, n: Node): string {
  const fqcn = n.id.replace(/^php:/, '');
  const ns = fqcn.split('\\').slice(0, -1).join('\\');
  const type = (t: TypeRef): string => {
    if (t.kind === 'primitive') return t.name;
    if (t.kind === 'named') return ctx.byId.get(t.id)?.name ?? t.id;
    if (t.kind === 'array') return 'array';
    return 'mixed';
  };
  const entry = n.role === 'controller' && ctx.bp.stack.entry.implements;
  const uses = new Set<string>();
  for (const r of referenced(ctx, n)) {
    const full = r.id.replace(/^php:/, '');
    if (full.split('\\').slice(0, -1).join('\\') !== ns) uses.add(full);
  }
  const imports = ctx.bp.stack.imports ?? {};
  for (const id of [...externals(n), ...(entry ? [entry] : [])]) if (imports[id]) uses.add(imports[id]);

  const bases = implementsOf(ctx, n).map((b) => b.name);
  if (entry) bases.push(entry);
  const head =
    n.kind === 'interface'
      ? `interface ${n.name}`
      : `${['entity', 'dto', 'model'].includes(n.role ?? '') ? '' : 'final '}class ${n.name}${bases.length ? ` implements ${bases.join(', ')}` : ''}`;
  const body: string[] = [];
  // полетата: на DTO са в конструктора (readonly), на entity — свойства
  const fields = ctx.bp.types[n.id]?.fields ?? [];
  const doc = (t: TypeRef, indent: string) => (t.kind === 'array' ? `${indent}/** @var ${type(t.of)}[] */\n` : '');
  if (fields.length && n.role === 'dto')
    body.push(
      `    public function __construct(\n${fields.map((f) => `${doc(f.type, '        ')}        public readonly ${type(f.type)} $${f.name},`).join('\n')}\n    ) {\n    }`,
    );
  else if (fields.length)
    body.push(fields.map((f) => `${doc(f.type, '    ')}    private ${type(f.type)} $${f.name};`).join('\n'));
  for (const m of n.members) {
    if (isCtor(m)) {
      const props = m.inputs.map((p) => `        private readonly ${type(p.type)} $${p.name},`);
      body.push(`    public function __construct(${props.length ? `\n${props.join('\n')}\n    ` : ''}) {\n    }`);
      continue;
    }
    const ret = m.output?.type.kind === 'array' ? `    /** @return ${type(m.output.type.of)}[] */\n` : '';
    const sig = `public ${m.static ? 'static ' : ''}function ${m.name}(${m.inputs.map((p) => `${type(p.type)} $${p.name}`).join(', ')})${m.output ? `: ${type(m.output.type)}` : ''}`;
    if (n.kind === 'interface') {
      body.push(`${ret}    ${sig};`);
      continue;
    }
    const lines = calls(ctx, n, m, '::').map((c) => `        // ${c}`);
    if (m.output && type(m.output.type) !== 'void')
      lines.push(`        throw new \\LogicException('TODO: ${n.name}::${m.name}');`);
    else if (!lines.length) lines.push('        // TODO');
    body.push(`${ret}    ${sig}\n    {\n${lines.join('\n')}\n    }`);
  }
  return [
    '<?php',
    '',
    'declare(strict_types=1);',
    '',
    `namespace ${ns};`,
    '',
    ...(uses.size ? [...[...uses].sort().map((u) => `use ${u};`), ''] : []),
    head,
    '{',
    body.join('\n\n'),
    '}',
    '',
  ]
    .join('\n')
    .replace('{\n\n}', '{\n}');
}

// config/routes.php на Mezzio skeleton: route-овете от чертежа.
function routesFile(ctx: Ctx, routes: Node[]): string {
  const lines = ctx.bp.registrations.filter((r) => routes.some((n) => n.id === r.route)).map((r) => `    ${r.text}`);
  return [
    '<?php',
    '',
    'declare(strict_types=1);',
    '',
    'use Mezzio\\Application;',
    'use Mezzio\\MiddlewareFactory;',
    'use Psr\\Container\\ContainerInterface;',
    '',
    'return static function (Application $app, MiddlewareFactory $factory, ContainerInterface $container): void {',
    ...lines,
    '};',
    '',
  ].join('\n');
}

// --- TypeScript (NestJS): договорите са abstract class, за да са DI token; route-овете са декоратори.

function ts(ctx: Ctx, nodes: Node[]): string {
  const file = nodes[0]?.location.file ?? '';
  const type = (t: TypeRef): string => {
    if (t.kind === 'primitive') return t.name;
    if (t.kind === 'named') return ctx.byId.get(t.id)?.name ?? t.id;
    if (t.kind === 'array') return `${type(t.of)}[]`;
    return 'unknown';
  };
  const imports = new Map<string, Set<string>>();
  const add = (from: string, name: string) => imports.set(from, (imports.get(from) ?? new Set()).add(name));
  const parts = nodes.map((n) => {
    for (const r of referenced(ctx, n))
      if (r.location.file !== file) {
        const rel = posix.relative(posix.dirname(file), r.location.file).replace(/\.ts$/, '');
        add(rel.startsWith('.') ? rel : `./${rel}`, r.name);
      }
    const controller = n.role === 'controller';
    const injectable = n.kind !== 'interface' && !controller && !['entity', 'dto', 'model'].includes(n.role ?? '');
    if (controller) add('@nestjs/common', 'Controller');
    if (injectable) add('@nestjs/common', 'Injectable');
    const bases = implementsOf(ctx, n).map((b) => b.name);
    const abstract = n.kind === 'interface';
    const fields = (ctx.bp.types[n.id]?.fields ?? []).map((f) => `  ${f.name}!: ${type(f.type)};`);
    const body = n.members.map((m) => {
      const params = m.inputs.map((p) => {
        if (!controller || isCtor(m)) return `${isCtor(m) ? 'private readonly ' : ''}${p.name}: ${type(p.type)}`;
        const route = ctx.routes.get(`${n.id}#${m.name}`);
        if (route && new RegExp(`:${p.name}\\b`).test(route.name)) {
          add('@nestjs/common', 'Param');
          return `@Param('${p.name}') ${p.name}: ${type(p.type)}`;
        }
        // при GET входният обект е от query параметрите, иначе от тялото
        const from = route?.name.startsWith('GET ') ? 'Query' : 'Body';
        add('@nestjs/common', from);
        return `@${from}() ${p.name}: ${type(p.type)}`;
      });
      if (isCtor(m))
        return params.join(', ').length > 80
          ? `  constructor(\n${params.map((p) => `    ${p},`).join('\n')}\n  ) {}`
          : `  constructor(${params.join(', ')}) {}`;
      const sig = `${m.static ? 'static ' : ''}${m.name}(${params.join(', ')})${m.output ? `: ${type(m.output.type)}` : ''}`;
      if (abstract) return `  abstract ${sig};`;
      const route = controller ? ctx.routes.get(`${n.id}#${m.name}`) : undefined;
      let deco = '';
      if (route) {
        const [method = 'GET', path = '/'] = route.name.split(' ');
        const verb = method.charAt(0) + method.slice(1).toLowerCase();
        add('@nestjs/common', verb);
        deco = `  @${verb}('${path.replace(/^\//, '')}')\n`;
      }
      const lines = calls(ctx, n, m, '.').map((c) => `    // ${c}`);
      if (m.output && type(m.output.type) !== 'void') lines.push(`    throw new Error('TODO: ${n.name}.${m.name}');`);
      else if (!lines.length) lines.push('    // TODO');
      return `${deco}  ${sig} {\n${lines.join('\n')}\n  }`;
    });
    const deco = controller ? '@Controller()\n' : injectable ? '@Injectable()\n' : '';
    const head = `${deco}export ${abstract ? 'abstract ' : ''}class ${n.name}${bases.length ? ` implements ${bases.join(', ')}` : ''}`;
    const all = [...(fields.length ? [fields.join('\n')] : []), ...body];
    return all.length ? `${head} {\n${all.join('\n\n')}\n}\n` : `${head} {}\n`;
  });
  const header = [...imports]
    .sort(([a], [b]) => (a.startsWith('.') ? 1 : 0) - (b.startsWith('.') ? 1 : 0) || a.localeCompare(b))
    .map(([from, names]) => `import { ${[...names].sort().join(', ')} } from '${from}';`);
  return `${header.length ? `${header.join('\n')}\n\n` : ''}${parts.join('\n')}`;
}

// --- Python (FastAPI): модул с няколко класа или функции; договорите са Protocol, DTO — pydantic.

function python(ctx: Ctx, nodes: Node[]): string {
  const module = (n: Node) =>
    n.id
      .replace(/^python:/, '')
      .split('.')
      .slice(0, -1)
      .join('.');
  const here = nodes[0] ? module(nodes[0]) : '';
  const imports = new Map<string, Set<string>>();
  const add = (from: string, name: string) => imports.set(from, (imports.get(from) ?? new Set()).add(name));
  const type = (t: TypeRef): string => {
    if (t.kind === 'primitive' && ['date', 'datetime'].includes(t.name)) add('datetime', t.name);
    if (t.kind === 'primitive') return t.name;
    if (t.kind === 'named') return ctx.byId.get(t.id)?.name ?? t.id;
    if (t.kind === 'array') return `list[${type(t.of)}]`;
    return 'object';
  };
  const router = nodes.some((n) => n.kind === 'function');
  if (router) add('fastapi', 'APIRouter');
  const param = (p: Port) => `${p.name}: ${type(p.type)}`;
  const parts = nodes.map((n) => {
    for (const r of referenced(ctx, n)) if (module(r) !== here) add(module(r), r.name);
    const lines = (m: Member, indent: string) => {
      const body = calls(ctx, n, m, '.').map((c) => `${indent}# ${c}`);
      body.push(m.output && type(m.output.type) !== 'None' ? `${indent}raise NotImplementedError` : `${indent}pass`);
      return body.join('\n');
    };
    if (n.kind === 'function') {
      const m = n.members[0] as Member;
      const route = ctx.routes.get(`${n.id}#${m.name}`);
      const [method = 'get', path = '/'] = (route?.name ?? '').split(' ');
      // зависимостите на функцията са параметри с Depends
      const deps = new Set(
        (ctx.bp.edges ?? []).filter((e) => e.kind === 'injects' && e.to.node === n.id).map((e) => e.to.port as string),
      );
      if (deps.size) add('fastapi', 'Depends');
      // при GET входният обект е от query параметрите: `= Depends()`
      const query = (p: Port) => method === 'GET' && p.type.kind === 'named';
      const params = m.inputs.map((p) =>
        deps.has(p.name) ? `${param(p)} = Depends(${type(p.type)})` : query(p) ? `${param(p)} = Depends()` : param(p),
      );
      const deco = route ? `@router.${method.toLowerCase()}("${path}")\n` : '';
      return `${deco}def ${n.name}(${params.join(', ')})${m.output ? ` -> ${type(m.output.type)}` : ''}:\n${lines(m, '    ')}\n`;
    }
    const protocol = n.kind === 'interface';
    const dto = n.role === 'dto';
    if (protocol) add('typing', 'Protocol');
    if (dto) add('pydantic', 'BaseModel');
    const bases = protocol ? ['Protocol'] : dto ? ['BaseModel'] : implementsOf(ctx, n).map((b) => b.name);
    // полетата: на DTO са на pydantic модела, на entity — на dataclass
    const fields = (ctx.bp.types[n.id]?.fields ?? []).map((f) => `    ${f.name}: ${type(f.type)}`);
    const data = fields.length && !dto && !protocol;
    if (data) add('dataclasses', 'dataclass');
    const methods = n.members.map((m) => {
      const self = m.static ? 'cls' : 'self';
      const args = [self, ...m.inputs.map(param)].join(', ');
      const deco = m.static ? '    @classmethod\n' : '';
      if (isCtor(m))
        return `    def __init__(${args}) -> None:\n${m.inputs.map((p) => `        self.${p.name} = ${p.name}`).join('\n') || '        pass'}`;
      const sig = `${deco}    def ${m.name}(${args})${m.output ? ` -> ${type(m.output.type)}` : ''}:`;
      return protocol ? `${sig} ...` : `${sig}\n${lines(m, '        ')}`;
    });
    const all = [...(fields.length ? [fields.join('\n')] : []), ...methods];
    return `${data ? '@dataclass\n' : ''}class ${n.name}${bases.length ? `(${bases.join(', ')})` : ''}:\n${all.join('\n\n') || '    pass'}\n`;
  });
  const header = [...imports]
    .sort(([a], [b]) => (a.startsWith('app') ? 1 : 0) - (b.startsWith('app') ? 1 : 0) || a.localeCompare(b))
    .map(([from, names]) => `from ${from} import ${[...names].sort().join(', ')}`);
  // празен ред между външните импорти и тези от проекта
  const split = header.findIndex((h) => h.startsWith('from app'));
  if (split > 0) header.splice(split, 0, '');
  return [
    ...(header.length ? [...header, '', ''] : []),
    ...(router ? ['router = APIRouter()', '', ''] : []),
    parts.join('\n\n'),
  ].join('\n');
}
