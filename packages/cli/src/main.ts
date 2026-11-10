#!/usr/bin/env node
import { writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { GraphQuery, InvalidGraphError, scan } from '@archgraph/engine';
import { plan } from '@archgraph/planner';
import { serve } from './serve.ts';

const USAGE = `archgraph scan [път] [--out graph.json] [--exclude шаблон]... [--max-file-size байтове] [--no-scip]

  --out, -o         къде да се запише графът (по подразбиране stdout)
  --exclude, -x     пропусни пътища (повтаря се): vendor, '*.gen.ts', 'src/legacy/**'
  --max-file-size   по-големи файлове се пропускат като бъндъли (по подразбиране 1000000)
  --no-scip         без SCIP индексатори: по-бързо, всички calls са inferred

archgraph plan [път] --task "задача" --node Клас#метод [--node ...] [--no-scip]

  --task, -t        задачата с думи
  --node, -n        засегнат клас, метод или функция (повтаря се): OrderService#place, PlaceOrderDto

archgraph serve [път] [--port 8790] [--host 127.0.0.1] [--scip]

  интерфейсът в браузъра: процесът от избран ендпойнт (първо \`pnpm ui\`)
  --host            0.0.0.0 само в контейнер, иначе се вижда от мрежата`;

export async function main(argv: string[]): Promise<number> {
  const { positionals, values } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      out: { type: 'string', short: 'o' },
      exclude: { type: 'string', short: 'x', multiple: true },
      'max-file-size': { type: 'string' },
      'no-scip': { type: 'boolean' },
      task: { type: 'string', short: 't' },
      node: { type: 'string', short: 'n', multiple: true },
      port: { type: 'string' },
      host: { type: 'string' },
      scip: { type: 'boolean' },
      help: { type: 'boolean', short: 'h' },
    },
  });
  const [command, path = '.'] = positionals;
  if (values.help || !['scan', 'plan', 'serve'].includes(command ?? '')) {
    console.error(USAGE);
    return values.help ? 0 : 1;
  }
  if (command === 'serve') {
    const port = Number(values.port ?? 8790);
    const server = await serve(path, port, { exclude: values.exclude ?? [], scip: values.scip ?? false }, values.host);
    const address = server.address();
    // Редът с адреса е договор с VS Code разширението: то пуска `serve --port 0` и чете порта оттук.
    console.error(
      `archgraph: http://127.0.0.1:${typeof address === 'object' && address ? address.port : port}  (Ctrl+C спира)`,
    );
    return 0;
  }
  if (command === 'plan') {
    if (!values.task || !values.node?.length) {
      console.error(USAGE);
      return 1;
    }
    const query = new GraphQuery((await scan(path, { scip: !values['no-scip'] })).graph);
    const targets = values.node.map((n) => ({ name: n, found: query.find(n) }));
    const found = targets.flatMap((t) => (t.found.length === 1 ? t.found : []));
    for (const t of targets.filter((t) => t.found.length !== 1))
      console.error(`${t.name}: ${t.found.length ? `${t.found.length} съвпадения, уточни с id` : 'няма такъв нод'}`);
    if (found.length !== targets.length) return 1;
    process.stdout.write(plan(query, values.task, found));
    return 0;
  }

  const started = performance.now();
  try {
    const { graph, report } = await scan(path, {
      exclude: values.exclude ?? [],
      scip: !values['no-scip'],
      ...(values['max-file-size'] ? { maxFileSize: Number(values['max-file-size']) } : {}),
    });
    const json = JSON.stringify(graph, null, 2) + '\n';
    if (values.out) writeFileSync(values.out, json);
    else process.stdout.write(json);

    const members = graph.nodes.flatMap((n) => n.members);
    const ports = members.flatMap((m) => [...m.inputs, ...(m.output ? [m.output] : [])]);
    const untyped = ports.filter((p) => p.type.kind === 'unknown').length;
    const files = Object.entries(report.files);
    const edges = Map.groupBy(graph.edges, (e) => e.kind);
    const seconds = ((performance.now() - started) / 1000).toFixed(1);
    console.error(
      `archgraph: ${files.reduce((a, [, n]) => a + n, 0)} файла (${files.map(([l, n]) => `${l} ${n}`).join(', ') || 'няма поддържани'})` +
        ` → ${graph.nodes.length} нода, ${members.length} метода, ${ports.length} порта` +
        (ports.length ? ` (${Math.round((untyped / ports.length) * 100)}% без тип)` : '') +
        `, ${graph.edges.length} ребра за ${seconds} s`,
    );
    const calls = edges.get('calls') ?? [];
    if (calls.length) {
      const exact = calls.filter((e) => e.confidence === 'exact').length;
      console.error(`  calls: ${calls.length}, точни (SCIP) ${exact}, по евристика ${calls.length - exact}`);
    }
    for (const [language, status] of Object.entries(report.scip))
      if (status !== 'exact') console.error(`  scip ${language}: ${status}`);
    if (report.tooBig.length) console.error(`  пропуснати големи файлове: ${report.tooBig.length} (--max-file-size)`);
    if (report.duplicates.length) console.error(`  еднакви имена: ${report.duplicates.length}, с таг duplicate`);
    if (values.out) console.error(`  записано в ${values.out}`);
    return 0;
  } catch (e) {
    if (!(e instanceof InvalidGraphError)) throw e;
    console.error(e.message);
    for (const err of e.errors.slice(0, 20)) console.error(`  ${err.path}: ${err.message}`);
    return 2;
  }
}

if (import.meta.main) process.exitCode = await main(process.argv.slice(2));
