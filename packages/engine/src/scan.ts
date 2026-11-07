import { existsSync, readFileSync } from 'node:fs';
import { extname, join, resolve } from 'node:path';
import { nodeAdapter } from '@archgraph/lang-node';
import { phpAdapter } from '@archgraph/lang-php';
import { pythonAdapter } from '@archgraph/lang-python';
import { FRAMEWORKS, routes, type FrameworkRules } from '@archgraph/rules';
import {
  MODEL_VERSION,
  type Annotation,
  validate,
  type GraphModel,
  type CallSite,
  type Edge,
  type LanguageAdapter,
  type Node,
  type ValidationError,
} from '@archgraph/model';
import { callEdges } from './calls.ts';
import { linkEdges } from './edges.ts';
import { exactCalls, findCommand, runIndexer } from './exact.ts';
import { DEFAULT_EXCLUDES, isTooBig, listFiles, MAX_FILE_SIZE } from './files.ts';

export const ADAPTERS: LanguageAdapter[] = [phpAdapter, nodeAdapter, pythonAdapter];

export interface ScanOptions {
  exclude?: string[]; // добавя се към DEFAULT_EXCLUDES
  maxFileSize?: number;
  scip?: boolean; // по подразбиране true: пуска SCIP индексаторите, които са инсталирани
}

export interface ScanReport {
  files: Record<string, number>; // по език
  tooBig: string[];
  duplicates: string[];
  scip: Record<string, string>; // по език: 'exact', 'няма <команда>' или грешката на индексатора
  frameworks: string[];
}

export class InvalidGraphError extends Error {
  readonly errors: ValidationError[];

  constructor(errors: ValidationError[]) {
    super(`графът не е валиден: ${errors.length} грешки, първата: ${errors[0]?.path} ${errors[0]?.message}`);
    this.errors = errors;
  }
}

export async function scan(
  path: string,
  options: ScanOptions = {},
): Promise<{ graph: GraphModel; report: ScanReport }> {
  const root = resolve(path);
  const maxFileSize = options.maxFileSize ?? MAX_FILE_SIZE;
  const report: ScanReport = { files: {}, tooBig: [], duplicates: [], scip: {}, frameworks: [] };
  const byAdapter = new Map<LanguageAdapter, { path: string; text: string }[]>();

  for (const file of listFiles(root, [...DEFAULT_EXCLUDES, ...(options.exclude ?? [])])) {
    const adapter = ADAPTERS.find((a) => a.extensions.includes(extname(file)));
    if (!adapter) continue;
    if (isTooBig(join(root, file), maxFileSize)) {
      report.tooBig.push(file);
      continue;
    }
    const files = byAdapter.get(adapter) ?? [];
    files.push({ path: file, text: readFileSync(join(root, file), 'utf8') });
    byAdapter.set(adapter, files);
    report.files[adapter.language] = (report.files[adapter.language] ?? 0) + 1;
  }

  const graph: GraphModel = { version: MODEL_VERSION, root, nodes: [], edges: [], types: {} };
  let calls: CallSite[] = [];
  let annotations: Annotation[] = [];
  for (const [adapter, files] of byAdapter) {
    const part = await adapter.read(files);
    // concat, а не push(...): голям проект има повече нодове, отколкото стекът побира като аргументи.
    graph.nodes = graph.nodes.concat(part.nodes);
    graph.edges = graph.edges.concat(part.edges);
    Object.assign(graph.types, part.types);
    calls = calls.concat(part.calls ?? []);
    annotations = annotations.concat(part.annotations ?? []);
  }
  report.duplicates = renameDuplicates(graph.nodes);
  const frameworks = detect(root, FRAMEWORKS);
  report.frameworks = frameworks.map((f) => f.framework);
  const routed = routes(annotations, frameworks, graph.nodes);
  graph.nodes = graph.nodes.concat(routed.nodes);
  graph.edges = linkEdges(graph.nodes, graph.edges);
  const exact =
    options.scip === false
      ? { edges: [], rest: calls }
      : scipCalls(root, graph.nodes, [...byAdapter.keys()], calls, report);
  const inferred = callEdges(graph.nodes, graph.edges, graph.types, exact.rest);
  // Едно и също извикване може да се среща няколко пъти в метода, а реброто е едно.
  const called = new Map([...inferred.edges, ...exact.edges].map((e) => [e.id, e]));
  graph.edges = graph.edges.concat([...called.values()], routed.edges);
  if (inferred.unresolved.length > 0) graph.unresolved = inferred.unresolved;

  const result = validate(graph);
  if (!result.ok) throw new InvalidGraphError(result.errors);
  return { graph, report };
}

// Framework-ите, чийто manifest в корена ги споменава (`composer.json`, `package.json`, `pyproject.toml`).
function detect(root: string, all: FrameworkRules[]): FrameworkRules[] {
  const read = (file: string) => (existsSync(join(root, file)) ? readFileSync(join(root, file), 'utf8') : '');
  return all.filter((f) => f.detect.some((d) => read(d.file).toLowerCase().includes(d.contains.toLowerCase())));
}

// Пуска инсталираните SCIP индексатори. Връща точните ребра и извикванията, които остават за евристиката.
function scipCalls(
  root: string,
  nodes: Node[],
  adapters: LanguageAdapter[],
  calls: CallSite[],
  report: ScanReport,
): { edges: Edge[]; rest: CallSite[] } {
  let edges: Edge[] = [];
  let rest = calls;
  for (const { language, indexer } of adapters) {
    if (!indexer) continue;
    const command = findCommand(indexer.command);
    const documents = command ? runIndexer(root, indexer, command) : `няма ${indexer.command}`;
    if (typeof documents === 'string') {
      report.scip[language] = documents;
      continue;
    }
    report.scip[language] = 'exact';
    const result = exactCalls(nodes, documents, rest);
    edges = edges.concat(result.edges);
    rest = rest.filter((c) => !result.resolved.has(c));
  }
  return { edges, rest };
}

// Два класа с едно и също пълно име се срещат (copy-paste между модули, тестови `Foo`).
// И двата остават в графа с таг `duplicate`. Първият по път пази id-то, останалите получават `@файл`.
function renameDuplicates(nodes: Node[]): string[] {
  const groups = Map.groupBy(nodes, (n) => n.id);
  const duplicates: string[] = [];
  for (const [id, group] of groups) {
    if (group.length < 2) continue;
    duplicates.push(id);
    group.sort((a, b) => a.location.file.localeCompare(b.location.file));
    group.forEach((n, i) => {
      n.tags = [...(n.tags ?? []), 'duplicate'];
      if (i > 0) n.id = `${id}@${n.location.file}`;
    });
  }
  return duplicates;
}
