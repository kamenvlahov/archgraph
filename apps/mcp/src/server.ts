import { resolve } from 'node:path';
import { GraphQuery, label, scan, where, type Target } from '@archgraph/engine';

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
    'Клас, метод или функция: `OrderService#place`, `OrderService::place`, `OrderService.place`, име или id.',
};

const TOOLS = [
  {
    name: 'trace',
    description:
      'Веригата от извиквания от метод надолу (кого вика, с имплементациите на интерфейсите) или нагоре (кой го вика). Всеки ред е с file:line. `→` е точно (SCIP), `→?` е по евристика, `⇒` е имплементация, `new` е създаване.',
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
      'Кой зависи от клас или интерфейс: извиквания по метод, инжекции, наследяване, създаване, портове с този тип. За оценка на въздействието преди промяна.',
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
      'Нодове по роля (controller, service, repository...; ролите идват от правилата за framework), вид (class, interface, function) или таг (abstract, duplicate).',
    inputSchema: {
      type: 'object',
      properties: { role: { type: 'string' }, project },
      required: ['role'],
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
  private readonly graphs = new Map<string, Promise<{ query: GraphQuery; summary: string }>>();

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
            'Графът на архитектурата на проекта: кой кого вика, кой от кого зависи, сигнатури с file:line. Ползвай го преди да ровиш из файловете.',
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
  private graph(root: string): Promise<{ query: GraphQuery; summary: string }> {
    let entry = this.graphs.get(root);
    if (!entry) {
      entry = scan(root, { scip: this.options.scip }).then(({ graph, report }) => ({
        query: new GraphQuery(graph),
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
