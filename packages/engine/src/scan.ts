import { readFileSync } from 'node:fs';
import { extname, join, resolve } from 'node:path';
import { nodeAdapter } from '@archgraph/lang-node';
import { phpAdapter } from '@archgraph/lang-php';
import { pythonAdapter } from '@archgraph/lang-python';
import {
  MODEL_VERSION,
  validate,
  type GraphModel,
  type LanguageAdapter,
  type Node,
  type ValidationError,
} from '@archgraph/model';
import { linkEdges } from './edges.ts';
import { DEFAULT_EXCLUDES, isTooBig, listFiles, MAX_FILE_SIZE } from './files.ts';

export const ADAPTERS: LanguageAdapter[] = [phpAdapter, nodeAdapter, pythonAdapter];

export interface ScanOptions {
  exclude?: string[]; // добавя се към DEFAULT_EXCLUDES
  maxFileSize?: number;
}

export interface ScanReport {
  files: Record<string, number>; // по език
  tooBig: string[];
  duplicates: string[];
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
  const report: ScanReport = { files: {}, tooBig: [], duplicates: [] };
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
  for (const [adapter, files] of byAdapter) {
    const part = await adapter.read(files);
    // concat, а не push(...): голям проект има повече нодове, отколкото стекът побира като аргументи.
    graph.nodes = graph.nodes.concat(part.nodes);
    graph.edges = graph.edges.concat(part.edges);
    Object.assign(graph.types, part.types);
  }
  report.duplicates = renameDuplicates(graph.nodes);
  graph.edges = linkEdges(graph.nodes, graph.edges);

  const result = validate(graph);
  if (!result.ok) throw new InvalidGraphError(result.errors);
  return { graph, report };
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
