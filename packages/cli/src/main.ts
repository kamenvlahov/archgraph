#!/usr/bin/env node
import { writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { InvalidGraphError, scan } from '@archgraph/engine';

const USAGE = `archgraph scan [път] [--out graph.json] [--exclude шаблон]... [--max-file-size байтове]

  --out, -o         къде да се запише графът (по подразбиране stdout)
  --exclude, -x     пропусни пътища (повтаря се): vendor, '*.gen.ts', 'src/legacy/**'
  --max-file-size   по-големи файлове се пропускат като бъндъли (по подразбиране 1000000)`;

export async function main(argv: string[]): Promise<number> {
  const { positionals, values } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      out: { type: 'string', short: 'o' },
      exclude: { type: 'string', short: 'x', multiple: true },
      'max-file-size': { type: 'string' },
      help: { type: 'boolean', short: 'h' },
    },
  });
  const [command, path = '.'] = positionals;
  if (values.help || command !== 'scan') {
    console.error(USAGE);
    return values.help ? 0 : 1;
  }

  const started = performance.now();
  try {
    const { graph, report } = await scan(path, {
      exclude: values.exclude ?? [],
      ...(values['max-file-size'] ? { maxFileSize: Number(values['max-file-size']) } : {}),
    });
    const json = JSON.stringify(graph, null, 2) + '\n';
    if (values.out) writeFileSync(values.out, json);
    else process.stdout.write(json);

    const members = graph.nodes.flatMap((n) => n.members);
    const ports = members.flatMap((m) => [...m.inputs, ...(m.output ? [m.output] : [])]);
    const untyped = ports.filter((p) => p.type.kind === 'unknown').length;
    const files = Object.entries(report.files);
    const seconds = ((performance.now() - started) / 1000).toFixed(1);
    console.error(
      `archgraph: ${files.reduce((a, [, n]) => a + n, 0)} файла (${files.map(([l, n]) => `${l} ${n}`).join(', ') || 'няма поддържани'})` +
        ` → ${graph.nodes.length} нода, ${members.length} метода, ${ports.length} порта` +
        (ports.length ? ` (${Math.round((untyped / ports.length) * 100)}% без тип)` : '') +
        ` за ${seconds} s`,
    );
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
