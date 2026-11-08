import { existsSync, readFileSync } from 'node:fs';
import { extname, join, resolve } from 'node:path';
import { nodeAdapter } from '@archgraph/lang-node';
import { phpAdapter } from '@archgraph/lang-php';
import { pythonAdapter } from '@archgraph/lang-python';
import {
  assignLayers,
  assignRoles,
  FRAMEWORKS,
  layerOrder,
  loadArchitecture,
  loadFrameworks,
  routes,
  services,
  type FrameworkRules,
  type RoleFacts,
} from '@archgraph/rules';
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
import { violations } from './violations.ts';
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
  layers: string[]; // редът на слоевете отвън навътре
}

const CATALOG_LAYERS = ['presentation', 'application', 'domain', 'infrastructure', 'composition'];

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
    this.report = { files: {}, tooBig: [], duplicates: [], scip: {}, frameworks: [], layers: [] };
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
    const report: ScanReport = {
      files: {},
      tooBig: this.report.tooBig,
      duplicates: [],
      scip: {},
      frameworks: [],
      layers: [],
    };
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
    // вградените правила и тези на проекта (.archgraph/rules/*.yaml)
    const frameworks = detect(root, [...loadFrameworks(join(root, '.archgraph/rules')), ...FRAMEWORKS]);
    // наследяването е от адаптерите, преди ребрата към външни типове да отпаднат: `implements` в
    // правилата сочи и външни интерфейси (PSR RequestHandlerInterface, pydantic.BaseModel)
    const heritage = graph.edges.filter((e) => e.kind === 'extends' || e.kind === 'implements');
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
    const facts = roleFacts(heritage, annotations, graph.edges);
    graph.nodes = assignRoles(graph.nodes, frameworks, facts);
    // слоеве и контексти от .archgraph/architecture.yaml; без него слоят е от каталога на ролите
    const architecture = loadArchitecture(root);
    graph.nodes = assignLayers(graph.nodes, architecture, facts);
    report.layers = layerOrder(architecture, CATALOG_LAYERS);
    const found = violations(graph.nodes, graph.edges, architecture);
    if (found.length > 0) graph.violations = found;

    const result = validate(graph);
    if (!result.ok) throw new InvalidGraphError(result.errors);
    this.graph = graph;
    this.report = report;
  }
}

function roleFacts(heritage: Edge[], annotations: Annotation[], edges: Edge[]): RoleFacts {
  const closure = (kinds: string[]) => {
    const parents = Map.groupBy(
      heritage.filter((e) => kinds.includes(e.kind)),
      (e) => e.from.node,
    );
    const all = new Map<string, Set<string>>();
    const walk = (id: string, seen: Set<string>) => {
      for (const e of parents.get(id) ?? [])
        if (!seen.has(e.to.node)) {
          seen.add(e.to.node);
          walk(e.to.node, seen);
        }
      return seen;
    };
    for (const id of parents.keys()) all.set(id, walk(id, new Set()));
    return all;
  };
  const decorators = new Map<string, string[]>();
  for (const a of annotations)
    if (
      a.kind === 'decorator' &&
      a.on &&
      (!a.on.member || a.on.node.endsWith(`.${a.on.member}`) || a.on.node.endsWith(`#${a.on.member}`))
    )
      decorators.set(a.on.node, [...(decorators.get(a.on.node) ?? []), a.name]);
  return {
    ancestors: closure(['extends', 'implements']),
    extending: closure(['extends']),
    decorators,
    injected: new Set(edges.filter((e) => e.kind === 'injects').map((e) => e.from.node)),
    handlers: new Set(edges.filter((e) => e.kind === 'routes-to').map((e) => e.to.node)),
  };
}

function adapterFor(file: string): LanguageAdapter | undefined {
  return ADAPTERS.find((a) => a.extensions.includes(extname(file)));
}

// Framework-ите, чийто manifest в корена ги споменава (`composer.json`, `package.json`, `pyproject.toml`).
function detect(root: string, all: FrameworkRules[]): FrameworkRules[] {
  const read = (file: string) => (existsSync(join(root, file)) ? readFileSync(join(root, file), 'utf8') : '');
  return all.filter(
    (f) => f.detect.length === 0 || f.detect.some((d) => read(d.file).toLowerCase().includes(d.contains.toLowerCase())),
  );
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
