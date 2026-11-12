import { resolve } from 'node:path';
import {
  blueprint,
  designStatus,
  designWarnings,
  draftDesign,
  GraphQuery,
  label,
  pattern,
  scan,
  skeleton,
  where,
  type ScanReport,
  type Target,
} from '@archgraph/engine';
import { designPlan, patternPlan, plan } from '@archgraph/planner';
import {
  DESIGN_STACKS,
  DESIGN_STYLES,
  loadDesign,
  saveDesign,
  validFields,
  validOutput,
  type Design,
  type DesignEndpoint,
  type DesignResource,
  LEVELS,
} from '@archgraph/rules';

// MCP сървър (JSON-RPC 2.0, по едно съобщение на ред през stdio). Протоколът е малък, затова е
// написан на ръка, без SDK: initialize, tools/list, tools/call, ping.
// https://modelcontextprotocol.io/specification

const PROTOCOL_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];

export interface ServerOptions {
  cwd: string; // проектът по подразбиране: Claude Code пуска сървъра в папката на проекта
  scip: boolean;
}

interface Request {
  jsonrpc: '2.0';
  id?: string | number;
  method: string;
  params?: Record<string, unknown>;
}

const project = { type: 'string', description: 'Път до проекта. По подразбиране текущата папка.' };
const target = {
  type: 'string',
  description:
    'Клас, метод или функция: `OrderService#place`, `OrderService::place`, `OrderService.place`, име или id. Или URL: `POST /orders/5`, `/orders/5` (намира route-а и handler-а му).',
};

const TOOLS = [
  {
    name: 'trace',
    description:
      'Веригата от извиквания от метод надолу (кого вика, с имплементациите на интерфейсите) или нагоре (кой го вика). Всеки ред е с file:line. `→` е точно (SCIP), `→?` е по евристика, `⇒` е имплементация, `new` е създаване, `⇢`/`⇠` е route → handler, `??` е възможно извикване само по име (получателят е неизвестен; провери в кода).',
    inputSchema: {
      type: 'object',
      properties: {
        target,
        direction: { type: 'string', enum: ['down', 'up'], description: 'down (по подразбиране) или up' },
        depth: { type: 'integer', minimum: 1, maximum: 20, description: 'по подразбиране 4' },
        project,
      },
      required: ['target'],
    },
  },
  {
    name: 'dependents',
    description:
      'Кой зависи от клас или интерфейс: извиквания по метод, инжекции, наследяване, създаване, портове с този тип и „може би“ извиквания по име, когато получателят е неизвестен. За оценка на въздействието преди промяна.',
    inputSchema: { type: 'object', properties: { target, project }, required: ['target'] },
  },
  {
    name: 'describe_node',
    description: 'Клас, интерфейс, функция или метод: място, наследяване, сигнатури, полета и зависимости.',
    inputSchema: { type: 'object', properties: { target, project }, required: ['target'] },
  },
  {
    name: 'find_by_role',
    description:
      'Нодове по роля (controller, service, repository, route...; ролите идват от правилата за framework), вид (class, interface, function, route) или таг (abstract, duplicate).',
    inputSchema: {
      type: 'object',
      properties: { role: { type: 'string' }, project },
      required: ['role'],
    },
  },
  {
    name: 'plan',
    description:
      'Markdown план за промяна: кодът на засегнатите методи, кой ги вика, как са свързани класовете (образец за нови), типовете в сигнатурите и реда на промените. Подай задачата и нодовете, които ще се променят.',
    inputSchema: {
      type: 'object',
      properties: {
        task: { type: 'string', description: 'Задачата с думи' },
        targets: { type: 'array', items: target, minItems: 1 },
        project,
      },
      required: ['task', 'targets'],
    },
  },
  {
    name: 'pattern',
    description:
      'Нов клас „като този“: от съществуващ образец (OrderService, payment_services) и ново име (Invoice) — кои класове и файлове да се създадат със сигнатурите им, по кои образци, и кои редове за регистрация (DI, route-ове) да се добавят. Markdown план.',
    inputSchema: {
      type: 'object',
      properties: {
        example: { ...target, description: 'Съществуващ клас или функция, който е образецът' },
        to: { type: 'string', description: 'Новото име: Invoice, invoice' },
        from: { type: 'string', description: 'По избор: думата в образеца, ако не е очевидна (Order)' },
        project,
      },
      required: ['example', 'to'],
    },
  },
  {
    name: 'violations',
    description:
      'Нарушенията на архитектурата: зависимост извън позволените посоки между слоеве (presentation → infrastructure) или контексти, цикли между класове, имплементация без метод на интерфейса. С target — само за този клас.',
    inputSchema: { type: 'object', properties: { target, project } },
  },
  {
    name: 'design',
    description:
      'Чертежът на проекта (.archgraph/design.yaml): стек, архитектура, ендпойнтите с входа и изхода им, предупрежденията и планът какво още да се напише — по слоеве, със сигнатурите и реда за регистрация. Ползвай го преди да пишеш код по чертежа.',
    inputSchema: { type: 'object', properties: { project } },
  },
  {
    name: 'design_edit',
    description:
      'Промяна на чертежа: чертеж от написания код (from_code), нов чертеж (stack и style), добавяне или промяна на ендпойнт (endpoint; същият метод и път се заменя) или махане (remove: "GET /galleries/{id}"), ресурс (resource: полетата на entity-то и собственикът му; remove_resource) и влезлият (auth: ресурсът на потребителя; тогава ендпойнтите искат вход, освен public). По веригата от собственици до auth се знае чии са данните: съобщенията носят id-то на влезлия, списъците и търсенето са само неговите. Полетата са {име: тип}: string, int, float, bool, date, datetime, клас, [тип] за масив, {поле: тип} за вложен обект. Изходът е какво връщат методите: тип (Gallery, [Gallery]) или полета (става клас за отговора). Не пиши код с това — само чертежа; потребителят го вижда в графа.',
    inputSchema: {
      type: 'object',
      properties: {
        from_code: {
          type: 'boolean',
          description: 'чертеж от написания код: ендпойнтите от route-овете, стилът най-близкият до кода',
        },
        stack: { type: 'string', description: DESIGN_STACKS.map((s) => s.stack).join(' | ') },
        style: { type: 'string', description: DESIGN_STYLES.map((s) => s.style).join(' | ') },
        endpoint: {
          type: 'object',
          properties: {
            method: { type: 'string', enum: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] },
            path: { type: 'string', description: '/galleries/{id}' },
            input: { type: 'object', description: '{име: тип}' },
            output: { description: 'тип, [тип] или {име: тип}' },
            entity: { type: 'string', description: 'по избор, ако пътят подвежда' },
            action: { type: 'string', description: 'по избор, ако пътят подвежда' },
            public: { type: 'boolean', description: 'без вход (регистрация, вход), когато има auth' },
          },
          required: ['method', 'path'],
        },
        remove: { type: 'string', description: 'METHOD /път на ендпойнт за махане' },
        auth: { type: 'string', description: 'ресурсът на влезлия (User); "" маха входа' },
        resource: {
          type: 'object',
          properties: {
            name: { type: 'string', description: 'Album' },
            owner: { type: 'string', description: 'чий е: друг ресурс (User, Album)' },
            fields: { type: 'object', description: '{име: тип}: полетата на entity-то' },
            level: {
              type: 'integer',
              enum: [1, 2, 3],
              description:
                'на колко парчета се разбива: 1 просто (входът вика repository-то), 2 service за ресурса, 3 стилът изцяло (use case за всяко действие); за части, които няма да се разширяват — по-ниско',
            },
          },
          required: ['name'],
        },
        remove_resource: { type: 'string', description: 'името на ресурс за махане' },
        project,
      },
    },
  },
  {
    name: 'design_status',
    description:
      'Проверка на кода срещу чертежа след писане: какво още го няма, липсващи методи и полета в написаните класове, различни сигнатури (параметри, изход), класове от друга архитектура и нарушения на слоевете, с усилието за рефакторинг. Сканира наново. Пускай го след всяка порция код по чертежа. Със style или stack проверява срещу друга архитектура или език, без да записва: какво ще се счупи и колко работа е преходът.',
    inputSchema: {
      type: 'object',
      properties: {
        style: { type: 'string', description: `по избор, без запис: ${DESIGN_STYLES.map((s) => s.style).join(' | ')}` },
        stack: { type: 'string', description: `по избор, без запис: ${DESIGN_STACKS.map((s) => s.stack).join(' | ')}` },
        project,
      },
    },
  },
  {
    name: 'skeleton',
    description:
      'Скелетът на файл от чертежа: namespace, импорти, класът, конструкторът със зависимостите, полетата и методите със сигнатурите, с коментар кого вика всеки метод. Логиката в телата я пишеш ти.',
    inputSchema: {
      type: 'object',
      properties: {
        file: { type: 'string', description: 'пътят от плана: src/Gallery/Handler/GetGalleryHandler.php' },
        project,
      },
      required: ['file'],
    },
  },
  {
    name: 'rescan',
    description: 'Сканира проекта отново след промени в кода. Другите инструменти ползват последното сканиране.',
    inputSchema: { type: 'object', properties: { project } },
  },
];

export class Server {
  private readonly options: ServerOptions;
  private readonly graphs = new Map<string, Promise<Scanned>>();

  constructor(options: ServerOptions) {
    this.options = options;
  }

  // Отговор на едно съобщение. Известията (без id) нямат отговор.
  async handle(message: Request): Promise<object | undefined> {
    const { id, method, params = {} } = message;
    if (id === undefined) return undefined;
    try {
      return { jsonrpc: '2.0', id, result: await this.dispatch(method, params) };
    } catch (e) {
      const error = e instanceof RpcError ? e : { code: -32603, message: (e as Error).message };
      return { jsonrpc: '2.0', id, error: { code: error.code, message: error.message } };
    }
  }

  private async dispatch(method: string, params: Record<string, unknown>): Promise<object> {
    switch (method) {
      case 'initialize': {
        const requested = String(params['protocolVersion'] ?? '');
        return {
          protocolVersion: PROTOCOL_VERSIONS.includes(requested) ? requested : PROTOCOL_VERSIONS[0],
          capabilities: { tools: {} },
          serverInfo: { name: 'archgraph', version: '0.0.0' },
          instructions:
            'Графът на архитектурата на проекта: кой кого вика, кой от кого зависи, сигнатури с file:line. Ползвай го преди да ровиш из файловете. Ако проектът има чертеж (design): пиши по плана и скелетите му и след всяка порция код пусни design_status.',
        };
      }
      case 'ping':
        return {};
      case 'tools/list':
        return { tools: TOOLS };
      case 'tools/call': {
        const args = (params['arguments'] ?? {}) as Record<string, unknown>;
        try {
          return { content: [{ type: 'text', text: await this.call(String(params['name']), args) }] };
        } catch (e) {
          if (e instanceof RpcError) throw e;
          return { content: [{ type: 'text', text: (e as Error).message }], isError: true };
        }
      }
      default:
        throw new RpcError(-32601, `непознат метод ${method}`);
    }
  }

  private async call(tool: string, args: Record<string, unknown>): Promise<string> {
    const root = resolve(this.options.cwd, typeof args['project'] === 'string' ? args['project'] : '.');
    if (tool === 'rescan') {
      this.graphs.delete(root);
      return (await this.graph(root)).summary;
    }
    if (tool === 'design_edit' && args['from_code'] === true) {
      if (loadDesign(root)) throw new Error('проектът вече има чертеж; промени го с останалите полета');
      const { query, report } = await this.graph(root);
      const draft = draftDesign(query.graph, report.frameworks);
      if (typeof draft === 'string') throw new Error(draft);
      saveDesign(root, draft.design);
      this.graphs.delete(root);
      const fit = draft.styles.map((x) => `${x.style} ${x.done}/${x.total}, ${x.files} файла`).join('\n');
      return `Чертеж от кода: ${draft.design.stack}, ${draft.design.style}, ${draft.design.endpoints.length} ендпойнта.\nКолко е готово по всеки стил:\n${fit}`;
    }
    if (tool === 'design_edit') {
      const text = editDesign(root, args);
      this.graphs.delete(root);
      return text;
    }
    if (tool === 'skeleton') {
      const code = skeleton(blueprint(designOf(root)), String(args['file'] ?? ''));
      if (!code) throw new Error(`${String(args['file'])} не е файл от чертежа; файловете са в плана (design)`);
      return code;
    }
    if (tool === 'design_status') this.graphs.delete(root);
    const { query } = await this.graph(root);
    switch (tool) {
      case 'trace': {
        const direction = args['direction'] === 'up' ? 'up' : 'down';
        const depth = Math.min(20, Math.max(1, Number(args['depth'] ?? 4)));
        return query.trace(one(query, args['target']), direction, depth);
      }
      case 'dependents':
        return query.dependents(one(query, args['target']).node);
      case 'describe_node':
        return query.describe(one(query, args['target']));
      case 'plan': {
        const targets = Array.isArray(args['targets']) ? args['targets'] : [];
        return plan(
          query,
          String(args['task'] ?? ''),
          targets.map((t) => one(query, t)),
        );
      }
      case 'pattern': {
        const example = one(query, args['example']);
        const from = typeof args['from'] === 'string' && args['from'] ? args['from'] : undefined;
        return patternPlan(pattern(query.graph, example, String(args['to'] ?? ''), from), example.node.name);
      }
      case 'design': {
        const design = loadDesign(root);
        if (!design)
          return `Проектът няма чертеж. Ако кодът вече е написан: design_edit from_code. Иначе design_edit: stack (${DESIGN_STACKS.map((s) => s.stack).join(', ')}) и style (${DESIGN_STYLES.map((s) => s.style).join(', ')}).`;
        const warnings = designWarnings(design);
        return [
          ...(design.auth ? [`Влезлият е ${design.auth}: ендпойнтите искат вход, освен публичните.`, ''] : []),
          ...(design.resources
            ? ['## Ресурсите', ...Object.entries(design.resources).map(([n, r]) => `- ${resourceText(n, r)}`), '']
            : []),
          '## Ендпойнтите в чертежа',
          ...design.endpoints.map((e) => `- ${endpointText(e)}`),
          ...(warnings.length ? ['', '## Предупреждения', ...warnings.map((w) => `- ${w}`)] : []),
          '',
          designPlan(query.graph, design, blueprint(design)),
        ].join('\n');
      }
      case 'design_status': {
        const saved = designOf(root);
        const style = typeof args['style'] === 'string' && args['style'] ? args['style'] : saved.style;
        const stack = typeof args['stack'] === 'string' && args['stack'] ? args['stack'] : saved.stack;
        if (!DESIGN_STYLES.some((s) => s.style === style))
          throw new Error(`style е един от: ${DESIGN_STYLES.map((s) => s.style).join(', ')}`);
        if (!DESIGN_STACKS.some((s) => s.stack === stack))
          throw new Error(`stack е един от: ${DESIGN_STACKS.map((s) => s.stack).join(', ')}`);
        const design = { ...saved, style, stack };
        return designStatus(query.graph, design, blueprint(design));
      }
      case 'violations':
        return query.violations(args['target'] === undefined ? undefined : one(query, args['target']).node);
      case 'find_by_role': {
        const role = String(args['role'] ?? '');
        const nodes = query.findBy(role);
        if (nodes.length === 0) return `няма нодове с роля, вид или таг "${role}"`;
        return nodes.map((node) => `${label({ node })}  ${where({ node })}`).join('\n');
      }
      default:
        throw new RpcError(-32602, `непознат инструмент ${tool}`);
    }
  }

  // Графът се сканира веднъж за проект и се пази в паметта до `rescan`.
  private graph(root: string): Promise<Scanned> {
    let entry = this.graphs.get(root);
    if (!entry) {
      entry = scan(root, { scip: this.options.scip }).then(({ graph, report }) => ({
        query: new GraphQuery(graph),
        report,
        summary: `${root}: ${graph.nodes.length} нода, ${graph.edges.length} ребра (${Object.entries(report.files)
          .map(([l, n]) => `${l} ${n}`)
          .join(', ')})`,
      }));
      entry.catch(() => this.graphs.delete(root));
      this.graphs.set(root, entry);
    }
    return entry;
  }
}

interface Scanned {
  query: GraphQuery;
  report: ScanReport;
  summary: string;
}

function designOf(root: string): Design {
  const design = loadDesign(root);
  if (!design) throw new Error('проектът няма чертеж (.archgraph/design.yaml); започни с design_edit');
  return design;
}

const endpointText = (e: DesignEndpoint) =>
  [
    `${e.method} ${e.path}`,
    e.input && Object.keys(e.input).length ? `вход ${JSON.stringify(e.input)}` : '',
    e.output !== undefined ? `изход ${JSON.stringify(e.output)}` : '',
    e.public ? 'публичен' : '',
  ]
    .filter(Boolean)
    .join(' · ');

const resourceText = (name: string, r: DesignResource) =>
  [
    name,
    r.owner ? `на ${r.owner}` : '',
    r.level ? `ниво ${r.level}` : '',
    r.fields ? `полета ${JSON.stringify(r.fields)}` : '',
  ]
    .filter(Boolean)
    .join(' · ');

// Нов чертеж, ендпойнт (заменя същия метод и път) или махане. Проверките са като в UI-а (PUT /api/design).
function editDesign(root: string, args: Record<string, unknown>): string {
  const old = loadDesign(root);
  const stack = typeof args['stack'] === 'string' ? args['stack'] : old?.stack;
  const style = typeof args['style'] === 'string' ? args['style'] : old?.style;
  if (!DESIGN_STACKS.some((s) => s.stack === stack))
    throw new Error(`stack е един от: ${DESIGN_STACKS.map((s) => s.stack).join(', ')}`);
  if (!DESIGN_STYLES.some((s) => s.style === style))
    throw new Error(`style е един от: ${DESIGN_STYLES.map((s) => s.style).join(', ')}`);
  let endpoints = old?.endpoints ?? [];
  const key = (method: string, path: string) =>
    `${method.toUpperCase()} ${path.replace(/\{[^}]*\}|:\w+/g, '{}').replace(/\/$/, '')}`;
  const done: string[] = [];
  if (typeof args['remove'] === 'string') {
    const [method = '', path = ''] = args['remove'].trim().split(/\s+/);
    const left = endpoints.filter((e) => key(e.method, e.path) !== key(method, path));
    if (left.length === endpoints.length) throw new Error(`в чертежа няма ${args['remove']}`);
    endpoints = left;
    done.push(`махнат ${args['remove']}`);
  }
  if (args['endpoint'] !== undefined) {
    const e = args['endpoint'] as DesignEndpoint;
    const method = String(e.method ?? '').toUpperCase();
    if (!['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(method) || !e.path?.startsWith('/'))
      throw new Error('endpoint е {method: GET|POST|PUT|PATCH|DELETE, path: /път}');
    if (e.input !== undefined && !validFields(e.input))
      throw new Error('input е {име: тип}; имената са букви, цифри и _; [тип] е масив, {поле: тип} — обект');
    if (e.output !== undefined && !validOutput(e.output))
      throw new Error('output е тип (Gallery), [тип] или {име: тип}');
    const next: DesignEndpoint = { ...e, method };
    const at = endpoints.findIndex((x) => key(x.method, x.path) === key(method, e.path));
    endpoints = at < 0 ? [...endpoints, next] : endpoints.map((x, i) => (i === at ? next : x));
    done.push(`${at < 0 ? 'добавен' : 'променен'} ${endpointText(next)}`);
  }
  let resources = { ...(old?.resources ?? {}) };
  const gone = args['remove_resource'];
  if (typeof gone === 'string') {
    if (!resources[gone]) throw new Error(`в чертежа няма ресурс ${gone}`);
    resources = Object.fromEntries(Object.entries(resources).filter(([n]) => n !== gone));
    done.push(`махнат ресурс ${gone}`);
  }
  if (args['resource'] !== undefined) {
    const { name, owner, fields, level } = args['resource'] as { name?: string } & DesignResource;
    if (!name || !/^[A-Z]\w*$/.test(name)) throw new Error('resource.name е име на клас: Album');
    if (level !== undefined && !LEVELS.includes(level)) throw new Error('resource.level е 1, 2 или 3');
    if (fields !== undefined && !validFields(fields))
      throw new Error('resource.fields е {име: тип}; имената са букви, цифри и _');
    // само подадените свойства се сменят; owner: "" маха собственика
    const { owner: _, ...kept } = resources[name] ?? {};
    const was = resources[name]?.owner;
    resources[name] = {
      ...kept,
      ...((owner ?? was) ? { owner: (owner ?? was) as string } : {}),
      ...(fields ? { fields } : {}),
      ...(level ? { level } : {}),
    };
    done.push(`ресурс ${resourceText(name, resources[name])}`);
  }
  const auth = typeof args['auth'] === 'string' ? args['auth'] : old?.auth;
  if (typeof args['auth'] === 'string') done.push(args['auth'] ? `влезлият е ${args['auth']}` : 'без вход');
  const design: Design = {
    stack: stack as string,
    style: style as string,
    ...(auth ? { auth } : {}),
    ...(Object.keys(resources).length ? { resources } : {}),
    endpoints,
  };
  saveDesign(root, design);
  const warnings = designWarnings(design);
  return [
    `Чертежът е записан (${design.style} · ${design.stack}, ${design.endpoints.length} ендпойнта)${done.length ? `: ${done.join('; ')}` : ''}.`,
    ...warnings.map((w) => `Внимание: ${w}`),
    'Планът е в design.',
  ].join('\n');
}

class RpcError extends Error {
  readonly code: number;

  constructor(code: number, message: string) {
    super(message);
    this.code = code;
  }
}

// Точно едно съвпадение, иначе грешка с кандидатите, за да може агентът да уточни.
function one(query: GraphQuery, value: unknown): Target {
  const text = String(value ?? '');
  const found = query.find(text);
  if (found.length === 1) return found[0] as Target;
  if (found.length > 1)
    throw new Error(
      `"${text}" съвпада с ${found.length}, уточни с id:\n${found.map((t) => `  ${t.node.id}${t.member ? `#${t.member.name}` : ''}  ${where(t)}`).join('\n')}`,
    );
  // Подобни: името съдържа заявката или двете започват еднакво (печатна грешка в края).
  const q = (text.split(/#|::|->|\./)[0] ?? '').toLowerCase();
  const similar = query.graph.nodes.filter((n) => {
    const name = n.name.toLowerCase();
    return name.includes(q) || name.startsWith(q.slice(0, Math.max(4, q.length - 3)));
  });
  throw new Error(
    `няма "${text}"${
      similar.length
        ? `. Подобни:\n${similar
            .slice(0, 10)
            .map((node) => `  ${label({ node })}  ${where({ node })}`)
            .join('\n')}`
        : ''
    }`,
  );
}
