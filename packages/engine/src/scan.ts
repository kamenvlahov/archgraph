import { existsSync, readFileSync } from 'node:fs';
import { extname, join, resolve } from 'node:path';
import { nodeAdapter } from '@archgraph/lang-node';
import { phpAdapter } from '@archgraph/lang-php';
import { pythonAdapter } from '@archgraph/lang-python';
import { FRAMEWORKS, routes, services, type FrameworkRules } from '@archgraph/rules';
import {
  MODEL_VERSION,
  type Annotation,
  validate,
  type GraphModel,
  type CallSite,
  type GraphFragment,
  type Edge,
  type LanguageAdapter,
  type Node,
  type ValidationError,
} from '@archgraph/model';
import { callEdges } from './calls.ts';
import { linkEdges } from './edges.ts';
import { exactCalls, findCommand, runIndexer } from './exact.ts';
import { DEFAULT_EXCLUDES, isExcluded, isTooBig, listFiles, MAX_FILE_SIZE } from './files.ts';

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
  const project = await Project.open(path, options);
  return { graph: project.graph, report: project.report };
}

// Проектът в паметта: прочетеното се пази по файл, затова промяна на файл препрочита само него,
// а свързването (правила, ребра, извиквания) минава наново върху всичко. SCIP се пуска само при
// отварянето; след промяна извикванията са по евристика, докато не се отвори наново.
export class Project {
  readonly root: string;
  graph: GraphModel;
  report: ScanReport;
  private readonly options: ScanOptions;
  private readonly fragments = new Map<string, { adapter: LanguageAdapter; part: GraphFragment }>();

  private constructor(root: string, options: ScanOptions) {
    this.root = root;
    this.options = options;
    this.graph = { version: MODEL_VERSION, root, nodes: [], edges: [], types: {} };
    this.report = { files: {}, tooBig: [], duplicates: [], scip: {}, frameworks: [] };
  }

  static async open(path: string, options: ScanOptions = {}): Promise<Project> {
    const project = new Project(resolve(path), options);
    const files = listFiles(project.root, project.excludes());
    for (const file of files) await project.read(file, files);
    project.link(options.scip !== false);
    return project;
  }

  // Препрочита променените файлове (относителни пътища) и свързва наново. Изтрит или вече
  // изключен файл изчезва от графа. Връща дали нещо от поддържаните езици е засегнато.
  async update(changed: string[]): Promise<boolean> {
    const relevant = changed.filter((f) => this.fragments.has(f) || (adapterFor(f) && !isExcluded(f, this.excludes())));
    if (!relevant.length) return false;
    const all = [...new Set([...this.fragments.keys(), ...relevant])];
    for (const file of relevant) {
      this.fragments.delete(file);
      if (existsSync(join(this.root, file))) await this.read(file, all);
    }
    this.link(false);
    return true;
  }

  private excludes(): string[] {
    return [...DEFAULT_EXCLUDES, ...(this.options.exclude ?? [])];
  }

  private async read(file: string, all: string[]) {
    const adapter = adapterFor(file);
    if (!adapter) return;
    if (isTooBig(join(this.root, file), this.options.maxFileSize ?? MAX_FILE_SIZE)) {
      this.report.tooBig.push(file);
      return;
    }
    const text = readFileSync(join(this.root, file), 'utf8');
    const paths = all.filter((f) => adapterFor(f) === adapter);
    this.fragments.set(file, { adapter, part: await adapter.read([{ path: file, text }], paths) });
  }

  private link(scip: boolean) {
    const { root } = this;
    const report: ScanReport = { files: {}, tooBig: this.report.tooBig, duplicates: [], scip: {}, frameworks: [] };
    const graph: GraphModel = { version: MODEL_VERSION, root, nodes: [], edges: [], types: {} };
    let calls: CallSite[] = [];
    let annotations: Annotation[] = [];
    for (const { adapter, part } of this.fragments.values()) {
      // concat, а не push(...): голям проект има повече нодове, отколкото стекът побира като аргументи.
      graph.nodes = graph.nodes.concat(part.nodes);
      graph.edges = graph.edges.concat(part.edges);
      Object.assign(graph.types, part.types);
      calls = calls.concat(part.calls ?? []);
      annotations = annotations.concat(part.annotations ?? []);
      report.files[adapter.language] = (report.files[adapter.language] ?? 0) + 1;
    }
    const renamed = renameDuplicates(graph.nodes);
    graph.nodes = renamed.nodes;
    report.duplicates = renamed.duplicates;
    const frameworks = detect(root, FRAMEWORKS);
    report.frameworks = frameworks.map((f) => f.framework);
    const registered = services(annotations, frameworks, graph.nodes);
    const routed = routes(annotations, frameworks, graph.nodes, registered.services);
    graph.nodes = graph.nodes.concat(routed.nodes);
    graph.edges = linkEdges(graph.nodes, graph.edges);
    const adapters = [...new Set([...this.fragments.values()].map((f) => f.adapter))];
    const exact = scip ? scipCalls(root, graph.nodes, adapters, calls, report) : { edges: [], rest: calls };
    const inferred = callEdges(graph.nodes, graph.edges, graph.types, exact.rest, registered.services);
    // Едно и също извикване може да се среща няколко пъти в метода, а реброто е едно.
    const called = new Map([...inferred.edges, ...exact.edges].map((e) => [e.id, e]));
    graph.edges = graph.edges.concat([...called.values()], routed.edges, registered.edges);
    if (inferred.unresolved.length > 0) graph.unresolved = inferred.unresolved;

    const result = validate(graph);
    if (!result.ok) throw new InvalidGraphError(result.errors);
    this.graph = graph;
    this.report = report;
  }
}

function adapterFor(file: string): LanguageAdapter | undefined {
  return ADAPTERS.find((a) => a.extensions.includes(extname(file)));
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
// Нодовете не се променят на място: прочетеното по файл се ползва отново при следващото свързване.
function renameDuplicates(nodes: Node[]): { nodes: Node[]; duplicates: string[] } {
  const groups = Map.groupBy(nodes, (n) => n.id);
  const renamed = new Map<Node, Node>();
  const duplicates: string[] = [];
  for (const [id, group] of groups) {
    if (group.length < 2) continue;
    duplicates.push(id);
    group.sort((a, b) => a.location.file.localeCompare(b.location.file));
    group.forEach((n, i) =>
      renamed.set(n, { ...n, id: i > 0 ? `${id}@${n.location.file}` : id, tags: [...(n.tags ?? []), 'duplicate'] }),
    );
  }
  return { nodes: duplicates.length ? nodes.map((n) => renamed.get(n) ?? n) : nodes, duplicates };
}
