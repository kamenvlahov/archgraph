import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { edge, type CallSite, type Edge, type Indexer, type Node } from '@archgraph/model';
import { CONSTRUCTORS } from './edges.ts';
import { ROLE_DEFINITION, readScip, type ScipDocument } from './scip.ts';

const TIMEOUT = 10 * 60_000;

// Командата от PATH или до node (глобалният `npm i -g` слага там, а не винаги е в PATH).
export function findCommand(command: string): string | undefined {
  const dirs = [...(process.env['PATH'] ?? '').split(delimiter), dirname(realpathSync(process.execPath))];
  return dirs
    .filter((d) => d !== '')
    .map((d) => join(d, command))
    .find((p) => existsSync(p));
}

// Пуска индексатора и връща документите му или грешката като текст.
export function runIndexer(root: string, indexer: Indexer, path: string): ScipDocument[] | string {
  const tmp = mkdtempSync(join(tmpdir(), 'archgraph-scip-'));
  try {
    for (const [name, text] of Object.entries(indexer.files ?? {})) writeFileSync(join(tmp, name), text);
    const out = join(tmp, 'index.scip');
    const run = spawnSync(path, indexer.args(out, tmp), { cwd: root, encoding: 'utf8', timeout: TIMEOUT });
    if (run.error) return run.error.message;
    if (run.status !== 0 || !existsSync(out))
      return `${indexer.command} излезе с код ${run.status}: ${(run.stderr || run.stdout).trim().split('\n').at(-1) ?? ''}`;
    return readScip(readFileSync(out));
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

// `calls` от SCIP. Тръгваме от извикванията в синтаксиса, защото SCIP не различава извикване от
// споменаване (`Depends(get_service)`). За всяко извикване търсим SCIP референция на същия ред към
// символ със същото име. Ако има, извикването е решено от SCIP: реброто е `exact`, или няма ребро,
// когато символът е външен. Ако няма (липсващи пакети, `any`), извикването остава за евристиката.
// Символът се свързва с метод по позицията на дефиницията му, така че не зависим от формата на символите.
export function exactCalls(
  nodes: Node[],
  documents: ScipDocument[],
  sites: CallSite[],
): { edges: Edge[]; resolved: Set<CallSite> } {
  const byFile = Map.groupBy(
    nodes.flatMap((n) => n.members.map((m) => ({ node: n.id, member: m.name, ...m.location }))),
    (m) => m.file,
  );
  const enclosing = (file: string, line: number) =>
    (byFile.get(file) ?? [])
      .filter((m) => m.line <= line && line <= m.endLine)
      .sort((a, b) => a.endLine - a.line - (b.endLine - b.line))[0];

  // Методите от проекта по символ. Конструкторите не се броят: `new X` дава `creates`.
  // Името трябва да съвпада: scip-python дава на вложена функция същия символ като на метода.
  const methods = new Map<string, { node: string; member: string }>();
  for (const doc of documents)
    for (const o of doc.occurrences) {
      if (!(o.roles & ROLE_DEFINITION) || !o.symbol.endsWith(').')) continue;
      const m = enclosing(doc.path, o.line);
      if (m && !CONSTRUCTORS.has(m.member) && o.symbol.replaceAll('`', '').endsWith(`${m.member}().`))
        methods.set(o.symbol, { node: m.node, member: m.member });
    }

  const refs = new Map(
    documents.map((d) => [
      d.path,
      Map.groupBy(
        d.occurrences.filter((o) => !(o.roles & ROLE_DEFINITION)),
        (o) => o.line,
      ),
    ]),
  );
  const files = new Map(nodes.map((n) => [n.id, n.location.file]));
  const edges = new Map<string, Edge>();
  const resolved = new Set<CallSite>();
  for (const site of sites) {
    if (site.kind === 'new') continue;
    const name = site.kind === 'method' ? site.name : (site.id.split(/[#.\\/:]/).at(-1) ?? '');
    const found = (refs.get(files.get(site.from.node) ?? '')?.get(site.line) ?? []).filter((o) =>
      o.symbol.replaceAll('`', '').endsWith(`${name}().`),
    );
    if (found.length === 0) continue;
    resolved.add(site);
    for (const o of found) {
      const to = methods.get(o.symbol);
      if (!to) continue;
      const e = edge('calls', { node: site.from.node, member: site.from.member }, to);
      edges.set(e.id, e);
    }
  }
  return { edges: [...edges.values()], resolved };
}
